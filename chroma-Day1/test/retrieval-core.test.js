import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG, selectCandidatePool } from "../lib/retrieval-core.js";

import { reciprocalRankFusion } from "../rff.js";

test("fallback pool interleaves candidates from both vector based and keyword based search", () => {
  const vectorResults = Array.from({ length: CONFIG.poolSize }, (_, i) => ({
    id: `vector-${i}`,
    text: `Unique vector chunk ${i}`,
    source: "vector.pdf",
    page: i + 1,
  }));

  const bm25Results = Array.from({ length: 10 }, (_, i) => ({
    id: `bm25-${i}`,
    text: `Unique BM25 chunk ${i}`,
    source: "bm25.pdf",
    page: i + 1,
  }));

  const pool = selectCandidatePool(vectorResults, bm25Results, []);

  // The current fallback puts vector results first.
  //assert.ok(pool.every((chunk) => chunk.id.startsWith("vector-")));

  //assert.ok(!pool.some((chunk) => chunk.id.startsWith("bm25-")));

  assert.deepEqual(
    pool.slice(0, 6).map((c) => c.id),
    ["vector-0", "bm25-0", "vector-1", "bm25-1", "vector-2", "bm25-2"],
  );
  assert.equal(pool.length, CONFIG.poolSize);

  // Verify there are no duplicate IDs.
  assert.equal(new Set(pool.map((c) => c.id)).size, pool.length);
});

test("fused candidate pool preserves source and page metadata", () => {
  const vectorResults = [
    {
      id: "shared-1",
      text: "Kruskal builds a minimum spanning tree.",
      source: "DAA_Study_Guide_Units3_4_5.pdf",
      page: 12,
    },
  ];

  const bm25Results = [
    {
      id: "shared-1",
      text: "Kruskal builds a minimum spanning tree.",
      source: "DAA_Study_Guide_Units3_4_5.pdf",
      page: 12,
    },
  ];

  const fusedResults = reciprocalRankFusion([vectorResults, bm25Results]);

  const pool = selectCandidatePool(vectorResults, bm25Results, fusedResults);

  assert.equal(pool.length, 1);
  assert.equal(pool[0].source, "DAA_Study_Guide_Units3_4_5.pdf");
  assert.equal(pool[0].page, 12);
});
