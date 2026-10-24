// Offline smoke test for the hybrid retrieval core.
// Runs with NO external services: the vector path is stubbed to null and
// the Cohere reranker is replaced by a passthrough stub. Proves that the
// BM25 path, candidate-pool selection and the hybridRetrieve contract work
// end-to-end. (Seed of Phase 2 — unit + eval tests will grow from here.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { hybridRetrieve } from "../lib/retrieval-core.js";
import { reciprocalRankFusion } from "../rff.js";
import {
  registerDocument,
  purgeCollection,
  getBm25Index,
  listDocuments,
  readCollectionStore,
} from "../lib/chunk-store.js";
import { BM25Index } from "../bm25.js";
import { CONFIG } from "../lib/retrieval-core.js";
// A tiny fake corpus: two collections, four chunks, enough overlapping
// vocabulary that BM25 has real rankings to produce.
const CORPUS_A = {
  name: "Test Doc A",
  collection: "test-alpha",
  chunks: [
    {
      text: "Dynamic programming requires optimal substructure and overlapping subproblems.",
    },
    {
      text: "Bellman-Ford computes single-source shortest paths in O(V*E) time.",
    },
  ],
};
const CORPUS_B = {
  name: "Test Doc B",
  collection: "test-beta",
  chunks: [
    {
      text: "Kruskal's algorithm builds a minimum spanning tree using a union-find structure.",
    },
    { text: "Quicksort has worst-case O(n^2) time but average O(n log n)." },
  ],
};

// Seed the registry once for the whole file.
function seedCorpus() {
  if (!listDocuments().some((d) => d.collection === CORPUS_A.collection)) {
    registerDocument({
      name: CORPUS_A.name,
      collection: CORPUS_A.collection,
      sourceFile: "test-a.pdf",
      flatChunks: CORPUS_A.chunks.map((c, i) => ({
        id: `test-a-${i}`,
        text: c.text,
        source: CORPUS_A.name,
        page: i + 1,
      })),
    });
  }
  if (!listDocuments().some((d) => d.collection === CORPUS_B.collection)) {
    registerDocument({
      name: CORPUS_B.name,
      collection: CORPUS_B.collection,
      sourceFile: "test-b.pdf",
      flatChunks: CORPUS_B.chunks.map((c, i) => ({
        id: `test-b-${i}`,
        text: c.text,
        source: CORPUS_B.name,
        page: i + 1,
      })),
    });
  }
}

// Rerank stub: identity (respect topN) so tests are deterministic offline.
const passthroughRerank = (query, candidates, topN = 3) =>
  candidates.slice(0, topN);

test("seed corpus registers two collections", () => {
  seedCorpus();
  const docs = listDocuments();
  assert.ok(docs.some((d) => d.collection === "test-alpha"));
  assert.ok(docs.some((d) => d.collection === "test-beta"));
});

test("BM25 index builds and ranks across collections", () => {
  seedCorpus();
  const index = getBm25Index("test-alpha");
  assert.ok(index, "index should exist for a registered collection");
  const hits = index.search("dynamic programming", 2);
  assert.ok(hits.length > 0, "should hit the dynamic programming chunk");
});

test("hybridRetrieve runs BM25-only and returns ranked chunks", async () => {
  seedCorpus();
  const results = await hybridRetrieve({
    query: "dynamic programming optimal substructure",
    vectorStoreFn: null, // vector path off → pure keyword path
    rerankFn: passthroughRerank,
    finalTopN: 2,
  });
  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0, "BM25 path should return results");
  assert.ok(results[0].text.includes("Dynamic programming"));
  assert.equal(results[0].id, "test-a-0");
});

test("hybridRetrieve merges results across collections", async () => {
  seedCorpus();
  const results = await hybridRetrieve({
    query: "spanning tree union-find",
    vectorStoreFn: null,
    rerankFn: passthroughRerank,
    finalTopN: 3,
  });
  assert.ok(results.length > 0);
  assert.ok(
    results.some((r) => r.id.startsWith("test-b-")),
    "cross-collection search should surface test-beta chunks",
  );
});

test("hybridRetrieve returns [] for empty query", async () => {
  const results = await hybridRetrieve({
    query: "   ",
    vectorStoreFn: null,
    rerankFn: passthroughRerank,
  });
  assert.deepEqual(results, []);
});

test("reciprocalRankFusion fuses two lists by rank", () => {
  const fused = reciprocalRankFusion([
    [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ],
    [
      { id: "b", text: "B" },
      { id: "c", text: "C" },
    ],
  ]);
  // "b" appears in both lists → must outrank items seen once.
  assert.equal(fused[0].id, "b");
});

test("purgeCollection removes registry entries and store", () => {
  seedCorpus();
  purgeCollection("test-beta");
  assert.ok(!listDocuments().some((d) => d.collection === "test-beta"));
  // Re-seed so repeated runs stay green.
  registerDocument({
    name: CORPUS_B.name,
    collection: CORPUS_B.collection,
    sourceFile: "test-b.pdf",
    flatChunks: CORPUS_B.chunks.map((c, i) => ({
      id: `test-b-${i}`,
      text: c.text,
      source: CORPUS_B.name,
      page: i + 1,
    })),
  });
});

test("hybridRetrieve uses one BM25 index across collections", async () => {
  // Step 1: Ensure our test collections exist.
  seedCorpus();

  const collections = ["test-alpha", "test-beta"];

  // Step 2: Read chunks from BOTH collections into one array.
  const allChunks = [];

  for (const collection of collections) {
    const chunks = readCollectionStore(collection);

    for (const chunk of chunks) {
      allChunks.push(chunk);
    }
  }

  // Step 3: Calculate the expected ranking using one BM25 index.
  const combinedIndex = new BM25Index(allChunks);

  const expectedHits = combinedIndex.search(
    "dynamic programming",
    CONFIG.bm25TopK,
  );

  const expectedIds = expectedHits.map((hit) => hit.id);

  // Step 4: Run the actual production retrieval function.
  const actualResults = await hybridRetrieve({
    query: "dynamic programming",
    collections,
    vectorStoreFn: null,
    rerankFn: passthroughRerank,
    finalTopN: CONFIG.bm25TopK,
  });

  const actualIds = actualResults.map((result) => result.id);

  // Step 5: Verify production returns the combined-index ranking.
  assert.deepEqual(actualIds, expectedIds);

  // Step 6: Verify source and page metadata are preserved.
  for (const result of actualResults) {
    const originalChunk = allChunks.find((chunk) => chunk.id === result.id);

    assert.ok(originalChunk, "original chunk should exist");
    assert.equal(result.source, originalChunk.source ?? null);
    assert.equal(result.page, originalChunk.page ?? null);
  }
});
