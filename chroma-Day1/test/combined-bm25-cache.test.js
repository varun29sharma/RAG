import test from "node:test";
import assert from "node:assert/strict";

import {
  registerDocument,
  purgeCollection,
  getCombinedBm25Index,
} from "../lib/chunk-store.js";

// Unique names ensure we don't interfere with real documents.
const suffix = `${process.pid}-${Date.now()}`;

const collectionA = `cache-test-a-${suffix}`;
const collectionB = `cache-test-b-${suffix}`;

function addDocument(collection, id, text) {
  return registerDocument({
    name: `Test document ${id}`,
    collection,
    sourceFile: `${id}.pdf`,
    flatChunks: [
      {
        id,
        text,
        page: 1,
      },
    ],
  });
}

test("Combined BM25 cache works correctly", (t) => {
  try {
    // 1. Create two collections.
    addDocument(collectionA, `chunk-a-${suffix}`, "Java programming");
    addDocument(collectionB, `chunk-b-${suffix}`, "Python programming");

    // 2. First request builds the combined index.
    const first = getCombinedBm25Index([collectionA, collectionB]);

    assert.ok(first, "Index should be created");

    // 3. Same request should reuse the cached index.
    const second = getCombinedBm25Index([collectionA, collectionB]);

    assert.strictEqual(
      first,
      second,
      "Repeated request should return the same index instance",
    );

    // 4. Different order should still reuse the same index.
    const third = getCombinedBm25Index([collectionB, collectionA]);

    assert.strictEqual(
      first,
      third,
      "Collection order should not create a separate cache entry",
    );

    // 5. Register another document in an existing collection.
    addDocument(
      collectionA,
      `chunk-new-${suffix}`,
      "Advanced Java programming",
    );

    const afterRegistration = getCombinedBm25Index([collectionA, collectionB]);

    assert.notStrictEqual(
      first,
      afterRegistration,
      "Registering a document should invalidate the old index",
    );

    // 6. Purge one collection.
    purgeCollection(collectionB);

    const afterPurge = getCombinedBm25Index([collectionA, collectionB]);

    assert.notStrictEqual(
      afterRegistration,
      afterPurge,
      "Purging a collection should invalidate the old index",
    );

    assert.strictEqual(
      afterPurge,
      getCombinedBm25Index([collectionA]),
      "Only the remaining collection should be indexed",
    );

    console.log("All combined BM25 cache checks passed!");
  } finally {
    // Always clean up test data, even if an assertion fails.
    purgeCollection(collectionA);
    purgeCollection(collectionB);
  }
});
