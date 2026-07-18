import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { BM25Index } from "./bm25.js";
import { reciprocalRankFusion } from "./rff.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const chunksPath = path.join(__dirname, "chunks-store.json");

// 🛠️ Shared runtime references matching server.js internals
let rawChunks = [];
let bm25Index = null;

function loadLocalChunks() {
  if (rawChunks.length > 0) return;
  try {
    const rawChunkData = fs.readFileSync(chunksPath, "utf-8");
    rawChunks = JSON.parse(rawChunkData);
    bm25Index = new BM25Index(rawChunks);
  } catch (error) {
    console.error("Pipeline failed to read chunks-store.json:", error);
  }
}

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

function normalizeChunkRecord(doc, index, fallbackPrefix = "chunk") {
  const metadata = doc?.metadata || {};
  const normalizedText = doc?.pageContent || doc?.text || "";
  const matchingRawChunk = rawChunks.find(
    (chunk) =>
      chunk?.text === normalizedText ||
      chunk?.pageContent === normalizedText ||
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
  };
}

async function rerankWithCohere(query, candidates, topN = 3) {
  if (!process.env.COHERE_API_KEY) {
    console.warn(
      "⚠️ COHERE_API_KEY missing from environment. Skipping rerank step.",
    );
    return candidates.slice(0, topN);
  }

  try {
    const response = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "rerank-v3.5",
        query,
        documents: candidates.map((c) => c.text),
        top_n: topN,
      }),
    });

    if (!response.ok) throw new Error(`Status: ${response.status}`);
    const data = await response.json();
    return data.results.map((r) => ({
      ...candidates[r.index],
      relevanceScore: r.relevance_score,
    }));
  } catch (err) {
    console.error("Reranking failed inside pipeline wrapper:", err);
    return candidates.slice(0, topN);
  }
}

/**
 * Core Hybrid Retrieval Wrapper
 * @param {string} query The search terms
 * @param {Object} vectorStore Initialized Chroma client passed from agent layer
 * @param {number} finalTopN Context slice volume (Defaults to 3)
 */
async function retrieveAndRerank(query, vectorStore, finalTopN = 3) {
  loadLocalChunks();
  const normalizedQuestion = typeof query === "string" ? query.trim() : "";
  if (!normalizedQuestion) return [];

  // 1. Path 1: Vector Space Lookup
  let vectorRanked = [];
  if (vectorStore) {
    try {
      const vectorResults = await vectorStore.similaritySearch(
        normalizedQuestion,
        10,
      );
      vectorRanked = (vectorResults || []).map((doc, index) =>
        normalizeChunkRecord(doc, index, "vector"),
      );
    } catch (err) {
      console.warn("Pipeline vector step failed:", err);
    }
  }

  // 2. Path 2: Exact Keyword Lookup
  let bm25Ranked = [];
  if (bm25Index) {
    const bm25Results = bm25Index.search(normalizedQuestion, 10);
    bm25Ranked = bm25Results.map((item) => {
      const rawDoc = rawChunks.find(
        (c) => c.id === item.id || c.chunkId === item.id,
      );
      const extractedText =
        item.text ||
        item.pageContent ||
        rawDoc?.text ||
        rawDoc?.pageContent ||
        "";
      const fallbackId = `bm25-${createStableChunkId(extractedText)}`;
      return {
        id: item.id || rawDoc?.id || rawDoc?.chunkId || fallbackId,
        text: extractedText,
      };
    });
  }

  // 3. Fused Intersection Verification
  const fusedResults = reciprocalRankFusion([vectorRanked, bm25Ranked]) || [];
  const vectorIds = new Set(vectorRanked.map((v) => v.id));
  const hasIntersection = bm25Ranked.some((b) => vectorIds.has(b.id));

  let candidatePool = [];
  const validFused = fusedResults.filter(
    (c) => c && c.text && c.text !== "undefined",
  );

  if (vectorRanked.length > 0 && hasIntersection && validFused.length > 0) {
    candidatePool = validFused.slice(0, 12);
  } else {
    const rawPool = [...vectorRanked, ...bm25Ranked];
    const seenText = new Set();
    for (const chunk of rawPool) {
      if (!chunk || !chunk.text) continue;
      const cleanText = chunk.text.trim();
      if (
        cleanText.length > 0 &&
        !seenText.has(cleanText) &&
        cleanText !== "undefined"
      ) {
        seenText.add(cleanText);
        candidatePool.push(chunk);
      }
      if (candidatePool.length >= 12) break;
    }
  }

  // 4. Precision Reranking Execution
  const reranked = await rerankWithCohere(
    normalizedQuestion,
    candidatePool,
    finalTopN,
  );
  return reranked;
}

export { retrieveAndRerank };
