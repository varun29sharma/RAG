# RAG Hybrid Search Fixes Summary

This document explains the changes made to fix the hybrid retrieval issues in the RAG pipeline, including the `undefined` vector ID problem, the Chroma deprecation warning, and the empty vector-store behavior.

## Problems fixed

1. Chroma connection warning
   - The app was passing the old `url` style into the Chroma client.
   - Newer Chroma versions warn that the `path` argument is deprecated and prefer `host`, `port`, and `ssl`.

2. Vector results had no usable IDs
   - Some vector documents did not expose a valid ID, causing logs like `undefined` and weakening the hybrid merge logic.

3. Chroma collection was empty at runtime
   - The vector store was not being populated with the chunk data from the local JSON store before queries ran.
   - That made the vector path fall back to placeholder values instead of returning real Chroma-backed IDs.

4. API key handling was inconvenient
   - The app relied on manually prefixing commands with the Cohere key.
   - The server and scripts now load the workspace `.env` file automatically.

---

## Files changed

### 1) [chroma-Day1/server.js](chroma-Day1/server.js)

This was the main backend file and received the largest set of fixes.

#### What changed
- Added dotenv loading from the workspace `.env` file.
- Switched Chroma initialization to the newer client configuration:
  - `host: "localhost"`
  - `port: 8000`
  - `ssl: false`
- Added `createStableChunkId()` to generate deterministic IDs when needed.
- Added `normalizeChunkRecord()` to build a consistent chunk object for both vector and BM25 results.
- Added `ensureChromaCollectionHasDocuments()` to populate the Chroma collection from [chroma-Day1/chunks-store.json](chroma-Day1/chunks-store.json) when it is empty.
- Updated the `/api/chat` flow to:
  - query the vector store,
  - query BM25,
  - merge candidate results,
  - build a better candidate pool,
  - and rerank before sending the prompt to the LLM.

#### Why this fix was needed
- The Chroma client warning came from the old connection config.
- Without a reliable ID, the fusion step could not merge vector and BM25 results correctly.
- If Chroma had no documents, the vector path returned nothing meaningful; the new initialization step fixes that by loading documents from the local chunk store.

---

### 2) [chroma-Day1/chat.js](chroma-Day1/chat.js)

#### What changed
- Added dotenv support so the script reads the workspace `.env` file automatically.
- Switched to the newer Chroma client config with `host`, `port`, and `ssl`.
- Added logic to populate the Chroma collection from the chunk store if it is empty.

#### Why this fix was needed
- The chat script was using the same outdated Chroma setup and would not behave consistently with the backend.
- It now uses the same initialization path so retrieval works the same way in the standalone chat script.

---

### 3) [chroma-Day1/retreive.js](chroma-Day1/retreive.js)

#### What changed
- Added dotenv support.
- Switched to the modern Chroma client config.
- Added startup logic to load the local chunk store into Chroma if the collection is empty.

#### Why this fix was needed
- This script was also affected by the same Chroma initialization issue and needed the same fix to retrieve real documents consistently.

---

## Key code patterns introduced

### 1. Deterministic ID generation
Used in [chroma-Day1/server.js](chroma-Day1/server.js):

```js
function createStableChunkId(value) {
  const safeValue = `${value || ""}`.trim();
  if (!safeValue) return "chunk-empty";

  let hash = 0;
  for (let i = 0; i < safeValue.length; i += 1) {
    hash = (hash << 5) - hash + safeValue.charCodeAt(i);
    hash |= 0;
  }

  return `chunk-${Math.abs(hash).toString(36)}`;
}
```

Why it was used:
- It gives every chunk a stable identifier even if Chroma or the source document lacks one.
- This keeps the hybrid rank fusion logic from breaking when IDs are missing.

### 2. Normalized record creation
Used in [chroma-Day1/server.js](chroma-Day1/server.js):

```js
function normalizeChunkRecord(doc, index, fallbackPrefix = "chunk") {
  const metadata = doc?.metadata || {};
  const normalizedText = doc?.pageContent || doc?.text || "";

  const candidateId =
    doc?.id ||
    metadata?.id ||
    metadata?.chunkId ||
    metadata?.chunkID ||
    metadata?.chunk_id ||
    `${fallbackPrefix}-${createStableChunkId(normalizedText)}-${index}`;

  return {
    id: candidateId,
    text: normalizedText,
  };
}
```

Why it was used:
- It ensures the vector results always have the same shape as BM25 results.
- This makes the hybrid ranking and overlap checks more reliable.

### 3. Chroma population from chunk store
Used in [chroma-Day1/server.js](chroma-Day1/server.js), [chroma-Day1/chat.js](chroma-Day1/chat.js), and [chroma-Day1/retreive.js](chroma-Day1/retreive.js):

```js
const documents = rawChunks.map((chunk, index) => ({
  pageContent: chunk.text || chunk.pageContent || "",
  metadata: {
    source: "chunks-store.json",
    chunkIndex: index,
    chunkId: chunk.id || `chunk-${index}`,
  },
}));

const ids = rawChunks.map((chunk, index) => chunk.id || `chunk-${index}`);
await vectorStore.addDocuments(documents, { ids });
```

Why it was used:
- It fills the Chroma collection with the local study-guide chunks so similarity search has real data to query.

---

## Result

After these changes:
- the Chroma client no longer uses the deprecated connection style,
- the vector branch produces real, usable IDs,
- the hybrid retrieval pipeline uses more consistent records,
- and the app can load the chunk data into Chroma automatically at startup.
