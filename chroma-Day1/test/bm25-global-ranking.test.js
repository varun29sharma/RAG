import { test } from "node:test";
import assert from "node:assert/strict";

import { BM25Index } from "../bm25.js";

test("combined BM25 index ranks chunks using one corpus", () => {
  const collectionA = [
    {
      id: "a1",
      text: "graph graph graph graph graph algorithm",
    },
    {
      id: "a2",
      text: "sorting algorithm",
    },
  ];

  const collectionB = [
    {
      id: "b1",
      text: "graph shortest path algorithm",
    },
    {
      id: "b2",
      text: "graph graph graph graph graph graph",
    },
  ];

  // Current design: each collection gets separate statistics.
  const indexA = new BM25Index(collectionA);
  const indexB = new BM25Index(collectionB);

  const separateResults = [
    ...indexA.search("graph", 10),
    ...indexB.search("graph", 10),
  ];

  // Proposed design: one index over all active chunks.
  const combinedIndex = new BM25Index([...collectionA, ...collectionB]);

  const combinedResults = combinedIndex.search("graph", 10);

  console.log("\nSeparate indexes:");
  console.log(
    separateResults.map(({ id, score }) => ({
      id,
      score: Number(score.toFixed(4)),
    })),
  );

  console.log("\nCombined index:");
  console.log(
    combinedResults.map(({ id, score }) => ({
      id,
      score: Number(score.toFixed(4)),
    })),
  );

  assert.equal(combinedResults.length, 3);

  // The combined search must be ordered by its own BM25 scores.
  for (let i = 1; i < combinedResults.length; i++) {
    assert.ok(combinedResults[i - 1].score >= combinedResults[i].score);
  }
});
