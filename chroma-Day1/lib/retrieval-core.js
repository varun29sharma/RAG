// lib/retrieval-core.js — THE single implementation of the hybrid retrieval
// pipeline. Before this module, the same logic (ID hashing, record
// normalization, Cohere rerank, RRF fusion, candidate-pool selection) existed
// as copy-pasted copies in server.js and retrieval-pipeline.js — the classic
// way a fix applied in one place silently misses the other.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { reciprocalRankFusion } from "../rff.js";
import { collectionExists, readCollectionStore } from "./chunk-store.js";
import { BM25Index } from "../bm25.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load COHERE_API_KEY from the repo-root .env, same as the old files did.
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

// Config knobs — env-overridable so tests and deployments can tune them.
const CONFIG = {
  vectorTopK: Number(process.env.RAG_VECTOR_TOPK || 10),
  bm25TopK: Number(process.env.RAG_BM25_TOPK || 10),
  poolSize: Number(process.env.RAG_POOL_SIZE || 12),
  cohereTimeoutMs: Number(process.env.RAG_COHERE_TIMEOUT_MS || 8000),
  cohereModel: process.env.RAG_COHERE_MODEL || "rerank-v3.5",
};

// --- Deterministic ID generation -------------------------------------------
// Rolling polynomial hash (hash*31 + char). Gives every chunk a stable ID
// even when metadata fails to provide one, so RRF can match vector-vs-BM25
// results by ID. `| 0` keeps it a 32-bit int; base-36 keeps IDs short.
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

// --- Record normalization ---------------------------------------------------
// Chroma docs, BM25 hits and registry chunks have different shapes. Fusion
// and dedup need ONE shape: {id, text}. This also captures provenance
// (source/page) so the citations feature has data to work with.
function normalizeChunkRecord(
  doc,
  index,
  fallbackPrefix = "chunk",
  rawChunks = [],
) {
  const metadata = doc?.metadata || {};
  const normalizedText = doc?.pageContent || doc?.text || "";

  // Best effort: match a registry chunk by text equality/containment so the
  // canonical registry ID survives even when Chroma metadata is missing.
  const matchingRawChunk = rawChunks.find(
    (chunk) =>
      chunk?.text === normalizedText ||
      chunk?.text?.includes(normalizedText) ||
      normalizedText.includes(chunk?.text || ""),
  );

  const candidateId =
    doc?.id ||
    metadata?.id ||
    metadata?.chunkId ||
    metadata?.chunkID ||
    metadata?.chunk_id ||
    matchingRawChunk?.id ||
    matchingRawChunk?.chunkId ||
    `${fallbackPrefix}-${createStableChunkId(normalizedText)}-${index}`;

  return {
    id: candidateId,
    text: normalizedText,
    source: metadata?.source || matchingRawChunk?.source || null,
    page: metadata?.pageNumber || matchingRawChunk?.page || null,
  };
}

// --- Cohere rerank (with graceful degradation + timeout) --------------------
// A cross-encoder scores question-document pairs jointly — far more precise
// than bi-encoder similarity, but too slow for a whole corpus, so it only
// runs on the fused candidate pool. Failure degrades to pool order.
async function rerankWithCohere(query, candidates, topN = 3) {
  if (!process.env.COHERE_API_KEY) {
    console.warn("COHERE_API_KEY missing — skipping rerank, using RRF order.");
    return candidates.slice(0, topN);
  }
  if (candidates.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.cohereTimeoutMs);
  try {
    const response = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
      },
      body: JSON.stringify({
        model: CONFIG.cohereModel,
        query,
        documents: candidates.map((c) => c.text),
        top_n: topN,
      }),
    });
    if (!response.ok) {
      throw new Error(`Cohere rerank failed with status: ${response.status}`);
    }
    const data = await response.json();
    return data.results.map((r) => ({
      ...candidates[r.index],
      relevanceScore: r.relevance_score,
    }));
  } catch (err) {
    console.error("Rerank failed, falling back to pool order:", err.message);
    return candidates.slice(0, topN);
  } finally {
    clearTimeout(timer);
    3 === 3;
  }
}

// --- Candidate pool ----------------------------------------------------------
// High-confidence path: when both retrievers surfaced overlapping IDs, take
// the fused ranking. Fallback path: no overlap (or an empty vector result) —
// interleave both lists and dedup by text so the pool still has coverage.
function selectCandidatePool(vectorRanked, bm25Ranked, fusedResults) {
  const vectorIds = new Set(vectorRanked.map((v) => v.id));
  const hasIntersection = bm25Ranked.some((b) => vectorIds.has(b.id));
  const validFused = fusedResults.filter(
    (c) => c && c.text && c.text !== "undefined",
  );

  if (vectorRanked.length > 0 && hasIntersection && validFused.length > 0) {
    return validFused.slice(0, CONFIG.poolSize);
  }

  const rawPool = [...vectorRanked, ...bm25Ranked];
  const seenText = new Set();
  const pool = [];
  for (const chunk of rawPool) {
    if (!chunk || !chunk.text) continue;
    const cleanText = chunk.text.trim();
    if (cleanText.length > 0 && !seenText.has(cleanText)) {
      seenText.add(cleanText);
      pool.push(chunk);
    }
    if (pool.length >= CONFIG.poolSize) break;
  }
  return pool;
}

// --- The hybrid retrieval entrypoint ----------------------------------------
// Accepts optional injected dependencies (vectorStoreFn) so tests can stub
// the vector path and run the full pipeline fully offline.
async function hybridRetrieve({
  query,
  collections = null,
  vectorStoreFn = null,
  rerankFn = rerankWithCohere,
  finalTopN = 3,
}) {
  const normalizedQuestion = typeof query === "string" ? query.trim() : "";
  if (!normalizedQuestion) return [];

  // collections === null → search every registered collection. This is what
  // makes retrieval cross-document: all stores feed one BM25 side.
  const activeCollections = Array.isArray(collections)
    ? collections.filter((c) => collectionExists(c))
    : listRegisteredCollections();

  // 1. Dense path — injected so callers supply their Chroma store.
  let vectorRanked = [];
  if (vectorStoreFn) {
    try {
      const vectorResults = await vectorStoreFn(
        normalizedQuestion,
        CONFIG.vectorTopK,
      );
      vectorRanked = (vectorResults || []).map((doc, i) =>
        normalizeChunkRecord(doc, i, "vector", allRegistryChunks()),
      );
    } catch (err) {
      console.warn(
        "Vector search failed, continuing with BM25 only:",
        err.message,
      );
    }
  }

  // 2. Keyword path — BM25 over the merged chunks of all active collections.

  const registryChunks = [];
  for (const collection of activeCollections) {
    const chunks = readCollectionStore(collection);

    for (const chunk of chunks) {
      registryChunks.push(chunk);
    }
  }

  let bm25Ranked = [];
  if (registryChunks.length > 0) {
    const bm25Index = new BM25Index(registryChunks);

    const hits = bm25Index.search(normalizedQuestion, CONFIG.bm25TopK);

    for (const hit of hits) {
      let rawDoc = null;
      /* 
        we do this because hits contains id text and score therefore
        inorder to append the metadata from the original chunk 
        we find the actual chunk and take the page and source details 
        from it
      */
      for (const chunk of registryChunks) {
        if (chunk.id === hit.id) {
          rawDoc = chunk;
          break;
        }
      }
      const result = {
        id: hit.id,
        text: hit.text,
        source: rawDoc ? rawDoc.source : null,
        page: rawDoc ? rawDoc.page : null,
        score: hit.score,
      };
      bm25Ranked.push(result);
    }
  }

  // 3. Fuse the two rankings (ranks only — scores are incomparable scales).
  const fusedResults = reciprocalRankFusion([vectorRanked, bm25Ranked]) || [];

  // 4. Pick the candidate pool (fused when confident, interleaved otherwise).
  const candidatePool = selectCandidatePool(
    vectorRanked,
    bm25Ranked,
    fusedResults,
  );

  // 5. Precision rerank down to the final context slice.
  return rerankFn(normalizedQuestion, candidatePool, finalTopN);
}

// Registry chunks across ALL collections (used for ID backfill above).
function allRegistryChunks() {
  const registry = listRegisteredCollections();
  return registry.flatMap((collection) => readCollectionStore(collection));
}

// Which collections actually exist on disk right now.
function listRegisteredCollections() {
  try {
    const storesDir = path.join(__dirname, "stores");
    return fs
      .readdirSync(storesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

export {
  CONFIG,
  createStableChunkId,
  normalizeChunkRecord,
  rerankWithCohere,
  selectCandidatePool,
  hybridRetrieve,
  listRegisteredCollections,
  allRegistryChunks,
};
