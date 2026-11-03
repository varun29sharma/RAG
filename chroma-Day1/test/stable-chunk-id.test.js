import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeChunkRecord } from "../lib/retrieval-core.js";
import { BM25Index } from "../bm25.js";
import { reciprocalRankFusion } from "../rff.js";

const registryChunk = {
  id: "chunk-101",
  text: "Kruskal algorithm constructs a minimum spanning tree.",
  source: "DAA_Notes.pdf",
  page: 12,
};

test("vector normalization preserves canonical chunk ID", () => {
  const chromaDoc = {
    pageContent: registryChunk.text,
    metadata: {
      chunkId: "chunk-101",
      source: "DAA_Notes.pdf",
      pageNumber: 12,
    },
  };

  const result = normalizeChunkRecord(chromaDoc, 0, "vector", [registryChunk]);

  assert.equal(result.id, "chunk-101");
});

test("normalization recovers canonical ID from registry", () => {
  const chromaDoc = {
    pageContent: registryChunk.text,
    metadata: {},
  };

  const result = normalizeChunkRecord(chromaDoc, 0, "vector", [registryChunk]);

  assert.equal(result.id, "chunk-101");
});

test("BM25 returns the original registry chunk ID", () => {
  const bm25Index = new BM25Index([registryChunk]);

  const results = bm25Index.search("Kruskal algorithm", 5);

  assert.equal(results.length, 1);
  assert.equal(results[0].id, "chunk-101");
});

test("RRF merges vector and BM25 results with the same canonical ID", () => {
  const vectorResult = normalizeChunkRecord(
    {
      pageContent: registryChunk.text,
      metadata: {
        chunkId: "chunk-101",
        source: "DAA_Notes.pdf",
        pageNumber: 12,
      },
    },
    0,
    "vector",
    [registryChunk],
  );

  const bm25Index = new BM25Index([registryChunk]);

  const bm25Result = bm25Index.search("Kruskal algorithm", 5);

  const fusedResults = reciprocalRankFusion([[vectorResult], bm25Result]);

  assert.equal(fusedResults.length, 1);
  assert.equal(fusedResults[0].id, "chunk-101");
});
