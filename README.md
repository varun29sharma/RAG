# Campus Copilot — Local-First Hybrid RAG Knowledge Assistant

Campus Copilot turns **any PDF you ingest** — course notes, placement policies, circulars, syllabi — into a question-answering knowledge base. It runs **fully local** (your documents never leave your machine) and answers through a **hybrid retrieval pipeline**: dense vector search **+** hand-written BM25 keyword search, fused with **Reciprocal Rank Fusion**, refined by a **Cohere cross-encoder reranker**, and answered by a **local Llama 3.2** model.

### Why "Campus"?
Generic RAG demos are a dime a dozen. This one has a purpose: **a knowledge assistant for a real campus** — the documents students actually need (deadlines, policies, procedures) scattered across PDFs nobody reads. It is also deliberately a microcosm of **enterprise knowledge management** — the problem domain ServiceNow's entire product line addresses — making it a directly relevant portfolio piece for that stack.

### Architecture in one sentence
One ingestion CLI writes every document into a **registry + per-collection chunk stores** (the system of record) and Chroma (dense vectors); one shared retrieval core fuses dense + keyword results over **all** collections, reranks, and grounds the LLM's answer in the top chunks — exposed both as an HTTP API and as a LangGraph ReAct agent.

---

## Why hybrid retrieval?

Each retrieval method fails in a different way, and their weaknesses are complementary:

| Method | Strength | Weakness |
|---|---|---|
| **Dense vectors** (`nomic-embed-text` → Chroma) | Understands *meaning* — finds "who cooked food?" ≈ "the chef prepared a meal" | Struggles with exact symbols: `O(V log V)`, form names, IDs, acronyms |
| **BM25 keyword** (hand-written, `chroma-Day1/bm25.js`) | Nails exact terms — "Kruskal time complexity" hits verbatim | Misses paraphrases and synonyms |

Running both and fusing their rankings means a question gets found by whichever path fits it. The fusion + rerank stages then reconcile the two lists into one high-precision context.

---

## Architecture

```
INGESTION (per document)                      QUERY TIME (per question)
┌───────────────────────────────┐             ┌─────────────────────────────────────────────┐
│ node ingest.js --pdf X.pdf    │             │  Question (React UI / agent tool / curl)    │
│   --collection <name>         │             │        │                                    │
│         │                     │             │        ▼                                    │
│         ▼                     │             │  ┌───────────────────────┐                  │
│ PDFLoader → 500/50 chunking   │             │  │ Chroma: fan-out over  │                  │
│         │                     │             │  │ ALL collections (top  │                  │
│         ├──────────────┐      │             │  │ 10 each, merged)      │                  │
│         ▼              ▼      │             │  └──────────┬────────────┘                  │
│ lib/documents.json   Chroma   │             │             │                               │
│ (registry)  stores/<c>.json   │             │  ┌──────────┴────────────┐                  │
│             (BM25 source,     │             │  │ BM25 over merged      │                  │
│              reseed source)   │             │  │ chunks, all documents │                  │
│         └────► embeddings:    │             │  └──────────┬────────────┘                  │
│                nomic-embed-   │             │             └──────┬───────────────────────│
│                text (Ollama)  │             │                    ▼                        │
└───────────────────────────────┘             │  Reciprocal Rank Fusion (k=60)              │
                                              │                    ▼                        │
                                              │  candidate pool (top 12)                    │
                                              │                    ▼                        │
                                              │  Cohere rerank-v3.5 cross-encoder → top 3   │
                                              │                    ▼                        │
                                              │  Llama 3.2 (Ollama) grounded prompt         │
                                              │                    ▼                        │
                                              │  { answer, sources[], retrievalMs, genMs }  │
                                              └─────────────────────────────────────────────┘
```

The registry (`lib/documents.json` + `lib/stores/*.json`) is the **system of record**: BM25 indexes are built from it, and empty Chroma collections are auto-reseeded from it on boot — so the dense and keyword paths can never disagree about the corpus.

---

## How the retrieval pipeline works (stage by stage)

### 1. Chunking — `chroma-Day1/ingest.js`
`RecursiveCharacterTextSplitter` with `chunkSize: 500, chunkOverlap: 50`. The **overlap** matters: an answer sentence sitting exactly at a boundary would otherwise be split into two useless halves. Each chunk gets a UUID, its PDF page number, and its document name, then lands in both the registry (for BM25 + reseeding) and Chroma (for dense search).

### 2. Dense path — multi-collection Chroma fan-out
The question is embedded with the *same* model used at ingest (mismatching embedding models silently breaks similarity search). `lib/vector-store.js` queries **every registered collection** and merges the hits, tagging each with its source collection — that's what makes a single question able to span "the DAA guide *and* the placement policy".

### 3. Keyword path — BM25, from scratch (`chroma-Day1/bm25.js`)
An implementation of the Okapi BM25 ranking function, zero dependencies:
- `tokenize()` — lowercase, strip to `[a-z0-9]+` words.
- `_buildDocFreq()` — for every term, how many chunks contain it *at least once*.
- `_idf(term)` — rare terms score high, ubiquitous terms ("is", "the") score ~0. This is why searching "what is bellmanford alg" focuses on `bellmanford`.
- `_scoreDoc()` — the BM25 saturation formula `idf · f(k1+1) / (f + k1·(1−b+b·|d|/avgdl))`: term frequency helps, but with **diminishing returns** (`k1 = 1.5`), and long documents are normalized down (`b = 0.75`).

### 4. Fusion — Reciprocal Rank Fusion (`chroma-Day1/rff.js`)
Each ranked list contributes `1 / (k + rank + 1)` per item, `k = 60` — the standard constant softening rank #1's dominance. RRF only needs **ranks**, not raw scores — crucial because BM25 scores and cosine similarities live on incomparable scales. A chunk appearing mid-list in *both* retrievers beats one that is #1 in only one.

### 5. Rerank — Cohere `rerank-v3.5` cross-encoder (`lib/retrieval-core.js`)
The top 12 fused candidates go to a **cross-encoder**: unlike a bi-encoder (question and document embedded *independently*), it reads the pair *jointly* and scores true relevance. Too slow for a whole corpus — which is why it's the *last* stage, over just 12 candidates. Top **3** survive into the prompt. No `COHERE_API_KEY`? Skipped, RRF order used. Timeout or API error? Falls back to pool order. The answer is degraded, never unavailable.

### 6. Generation — grounded prompt
The 3 blocks go into a strict template: answer **only** from context, else reply *"I cannot find the answer in the provided documents."* — the anti-hallucination contract. The response also returns **sources** (chunk id, document, page, relevance score) and **per-stage timings** (`retrievalMs`, `generationMs`) so every answer is verifiable and measurable.

### 7. The agent layer (`agent.js`, `tools.js`, `debug-stream.js`)
`createReactAgent` (LangGraph) wraps the same retrieval core behind two tools:
- `search_study_guide` — top **3** chunks, for precise factual questions.
- `summarize_topic` — top **8** chunks, for broad "explain / compare" questions.

The system prompt makes it a grounded campus assistant that can **retry with a reformulated query** instead of guessing. `MemorySaver` gives per-`thread_id` memory. `debug-stream.js` streams every internal step (tool decision → tool output → final answer).

---

## Project structure

```
├── agent.js                       # LangGraph ReAct agent (llama3.2 + 2 tools + memory)
├── tools.js                       # Agent tools over the shared retrieval core
├── debug-stream.js                # CLI: streams the agent's internal reasoning steps
├── chroma-Day1/
│   ├── lib/                       # ← the heart of the system (single source of truth)
│   │   ├── chunk-store.js         #   Document registry + per-collection chunk stores + BM25 cache
│   │   ├── retrieval-core.js      #   THE pipeline: normalize → fuse → pool → rerank (injectable, testable)
│   │   ├── vector-store.js        #   Shared Chroma infra: fan-out search + auto-reseed
│   │   ├── documents.json         #   Registry: every ingested document (created on first ingest)
│   │   └── stores/                #   Per-collection chunk stores (created on first ingest)
│   ├── ingest.js                  # Generic CLI: any PDF → any collection (--pdf/--collection/--replace)
│   ├── server.js                  # Thin Express shell: /api/chat, /health, /api/documents
│   ├── bm25.js                    # Hand-written Okapi BM25 (zero deps)
│   ├── rff.js                     # Reciprocal Rank Fusion
│   ├── retrieval-pipeline.js      # Backwards-compat re-export of lib/retrieval-core.js
│   ├── chat.js                    # CLI: one-off dense-only RAG query
│   ├── test/
│   │   └── hybrid-retrieve.test.js # Offline test suite (no Ollama/Chroma/Cohere needed)
│   ├── retrieve.js                # Learning artifact: manual retrieval + prompt assembly
│   ├── day1.js / day2.js          # Learning artifacts: semantic-vs-keyword demo; chunking inspection
│   ├── text-bm25.js / rerank.js   # Learning artifacts: BM25 smoke test; standalone rerank test
│   └── chunks-store.json.migrated # Legacy store, kept after --migrate-legacy
├── rag-frontend/                  # React 19 + Vite chat UI (talks to :5001)
│   └── src/App.jsx                # Chat: messages, fetch, loading state, error handling
├── .env.example                   # COHERE_API_KEY template
├── .npmrc                         # legacy-peer-deps (skips unused stagehand peer)
└── ROADMAP.md                     # What's next, prioritized
```

---

## Getting started

### Prerequisites
- **Node.js 20+**
- **Ollama** with two models:
  ```bash
  ollama pull llama3.2
  ollama pull nomic-embed-text
  ```
- **Chroma server**:
  ```bash
  chroma run --path ./chroma-data
  ```
- A **Cohere API key** (free tier suffices) for the rerank stage.

### Setup
```bash
npm install                  # root deps (server + agent)
cp .env.example .env         # add your COHERE_API_KEY

# Ingest your first document (example: the original DAA guide)
npm run ingest -- --pdf /path/to/DAA_Study_Guide_Units3_4_5.pdf --collection daa-study-guide

# Coming from the old version? Migrate the existing chunks instead:
npm run ingest -- --migrate-legacy

# Ingest more documents into new or existing collections:
npm run ingest -- --pdf ./placement-policy.pdf --collection campus-policies
npm run ingest -- --pdf ./hostel-rules.pdf --collection campus-policies   # merges
npm run ingest -- --pdf ./old-notes.pdf --collection campus-policies --replace  # purge + re-ingest
```

### Run it
```bash
npm test                     # offline test suite (no services needed)
npm run server               # API on http://localhost:5001
cd rag-frontend && npm install && npm run dev   # UI on http://localhost:5173
npm run agent:debug          # watch the agent think, step by step
```

---

## API reference

### `POST /api/chat`
```json
{ "question": "What are the two properties required for dynamic programming?" }
```

**200 OK**
```json
{
  "answer": "Optimal substructure and overlapping subproblems...",
  "sources": [
    { "contextBlock": 1, "id": "chunk-3f2a", "source": "DAA_Study_Guide_Units3_4_5.pdf", "page": 12, "relevanceScore": 0.97 }
  ],
  "retrievalMs": 412,
  "generationMs": 1830
}
```
`sources` gives verifiable provenance (empty when nothing was found); the timings make latency visible per stage.

**Errors**

| Status | Cause |
|---|---|
| `400` | Missing/empty `question` |
| `503` | RAG services not initialized (Ollama or Chroma down) |
| `500` | Pipeline failure |

### `GET /health`
```json
{ "status": "ok", "vectorPath": "available", "documents": 2 }
```
`vectorPath: "unavailable (BM25-only mode)"` means Chroma is down but the API still serves keyword answers — graceful degradation by design.

### `GET /api/documents`
Lists the registry: every ingested document, its collection, chunk count, and ingestion date.

---

## Testing

```bash
npm test
```
The suite runs **fully offline** — no Ollama, no Chroma, no Cohere. It seeds a tiny in-repo corpus into the registry, then verifies: BM25 ranking across collections, the full `hybridRetrieve` contract (BM25-only mode, cross-collection merge, empty-query guard), the RRF fusion math, and registry lifecycle (`registerDocument`/`purgeCollection`). This works because `hybridRetrieve` accepts **injected dependencies** (`vectorStoreFn`, `rerankFn`) — the same seams the future eval harness and mocked integration tests will use.

---

## Known limitations (honest list, each has a roadmap fix)

| # | Limitation | Fix |
|---|---|---|
| 1 | **No eval harness yet** — retrieval quality isn't measured (recall@3 / MRR) | Golden-QA harness with ablations — P2-3 |
| 2 | **No CI** — tests exist but don't run automatically on push | GitHub Actions — P2-4 |
| 3 | `/api/chat` is **stateless** — follow-ups lose context (the agent layer already has memory) | Session threading — P3-2 |
| 4 | Answers are **not streamed** — user waits for full generation | SSE streaming — P3-1 |
| 5 | **Security pass pending** — permissive CORS, no rate limit, no helmet | P1-4 |
| 6 | Chroma is the **only** vector backend; Ollama the only LLM | Provider abstraction — P4-3 |
| 7 | Vector-path hits don't yet carry page metadata end-to-end (registry path does) | Normalize at seed time — P3-3 |

Recently closed (was on this list before the P0 refactor): duplicated retrieval logic, double service init, hardcoded PDF path, no timeouts, no tests at all, the `retreive.js` filename typo.

---

## Tech stack

**Node.js 20+ · Express 5 · LangChain 1.x (community, core, ollama, langgraph) · Chroma 3.5 · Ollama (llama3.2, nomic-embed-text) · Cohere Rerank API · React 19 + Vite · hand-written BM25 + RRF (zero external IR dependencies) · node:test**
