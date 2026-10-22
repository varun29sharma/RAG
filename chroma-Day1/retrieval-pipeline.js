// retrieval-pipeline.js — backwards-compatibility re-export.
// The implementation used to live here AND in server.js (copy-pasted).
// After the P0-1 refactor, lib/retrieval-core.js is the single source of
// truth; this file keeps the old import path working for anything that
// still imports `retrieveAndRerank` from here.

export {
  hybridRetrieve as retrieveAndRerank,
  createStableChunkId,
  normalizeChunkRecord,
  rerankWithCohere,
} from "./lib/retrieval-core.js";
