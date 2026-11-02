import test from "node:test";
import assert from "node:assert/strict";

import { interleaveCandidateLists } from "../lib/retrieval-core.js";

test("interleaves vector and BM25 candidates", () => {
  const vector = [
    { id: "A", text: "Java" },
    { id: "B", text: "Python" },
  ];

  const bm25 = [
    { id: "X", text: "Java" },
    { id: "Y", text: "SQL" },
  ];

  const result = interleaveCandidateLists(vector, bm25, 4);

  assert.deepEqual(
    result.map((c) => c.id),
    ["A", "X", "B", "Y"],
  );
});

test("handles unequal list lengths", () => {
  const vector = [
    { id: "A", text: "Java" },
    { id: "B", text: "Python" },
    { id: "C", text: "JavaScript" },
  ];

  const bm25 = [{ id: "X", text: "Java" }];

  const result = interleaveCandidateLists(vector, bm25, 4);

  assert.deepEqual(
    result.map((c) => c.id),
    ["A", "X", "B", "C"],
  );
});

test("removes duplicate IDs", () => {
  const vector = [
    { id: "A", text: "Java" },
    { id: "B", text: "Python" },
  ];

  const bm25 = [
    { id: "B", text: "Python" },
    { id: "X", text: "SQL" },
  ];

  const result = interleaveCandidateLists(vector, bm25, 5);

  assert.deepEqual(
    result.map((c) => c.id),
    ["A", "B", "X"],
  );
});

test("handles an empty vector list", () => {
  const result = interleaveCandidateLists([], [{ id: "X", text: "SQL" }], 5);

  assert.deepEqual(
    result.map((c) => c.id),
    ["X"],
  );
});

test("handles an empty BM25 list", () => {
  const result = interleaveCandidateLists([{ id: "A", text: "Java" }], [], 5);

  assert.deepEqual(
    result.map((c) => c.id),
    ["A"],
  );
});

test("respects pool size", () => {
  const vector = [
    { id: "A", text: "Java" },
    { id: "B", text: "Python" },
  ];

  const bm25 = [
    { id: "X", text: "SQL" },
    { id: "Y", text: "C++" },
  ];

  const result = interleaveCandidateLists(vector, bm25, 1);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "A");
});

test("skips invalid candidates", () => {
  const vector = [null, { id: "A", text: "Java" }, { id: "B", text: "" }];

  const bm25 = [{ id: "X", text: "SQL" }];

  const result = interleaveCandidateLists(vector, bm25, 5);

  assert.deepEqual(
    result.map((c) => c.id),
    ["X", "A"],
  );
});

test("returns empty array for invalid pool size", () => {
  assert.deepEqual(interleaveCandidateLists([], [], 0), []);

  assert.deepEqual(interleaveCandidateLists([], [], -1), []);
});
