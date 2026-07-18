import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { BM25Index } from "./bm25.js";
import { reciprocalRankFusion } from "./rff.js";

import { Chroma } from "@langchain/community/vectorstores/chroma";
import { OllamaEmbeddings, ChatOllama } from "@langchain/ollama";
import { ChromaClient } from "chromadb";

const app = express();
const PORT = 5001;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
const chunksPath = path.join(__dirname, "chunks-store.json");

app.use(cors());
app.use(express.json());

let rawChunks = [];
let bm25Index = null;
let vectorStore = null;
let llm = null;

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

async function ensureChromaCollectionHasDocuments() {
  if (!vectorStore || rawChunks.length === 0) return;

  try {
    const collection = await vectorStore.ensureCollection();
    const existingCount = await collection.count();

    if (existingCount > 0) {
      console.log(
        `Chroma collection already contains ${existingCount} documents.`,
      );
      return;
    }

    const documents = rawChunks.map((chunk, index) => ({
      pageContent: chunk.text || chunk.pageContent || "",
      metadata: {
        source: "chunks-store.json",
        chunkIndex: index,
        chunkId: chunk.id || `chunk-${index}`,
      },
    }));

    const ids = rawChunks.map((chunk, index) => chunk.id || `chunk-${index}`);
    await vectorStore.addDocuments(documents, { ids });
    console.log(`Loaded ${documents.length} chunks into Chroma collection.`);
  } catch (error) {
    console.warn(
      "Unable to populate Chroma collection from local chunks:",
      error,
    );
  }
}

async function initializeServices() {
  try {
    const rawChunkData = fs.readFileSync(chunksPath, "utf-8");
    rawChunks = JSON.parse(rawChunkData);
    bm25Index = new BM25Index(rawChunks);

    const embeddings = new OllamaEmbeddings({
      model: "nomic-embed-text",
      baseUrl: "http://localhost:11434",
    });

    llm = new ChatOllama({
      model: "llama3.2",
      baseUrl: "http://localhost:11434",
    });

    const chromaClient = new ChromaClient({
      host: "localhost",
      port: 8000,
      ssl: false,
    });

    vectorStore = new Chroma(embeddings, {
      collectionName: "daa_study_guide_v3",
      index: chromaClient,
    });

    await ensureChromaCollectionHasDocuments();
    return { success: true };
  } catch (error) {
    console.error("Failed to initialize RAG services:", error);
    return { success: false, error };
  }
}

await initializeServices();

// 🛠️ PATH A: Cohere Rerank API Helper Function
async function rerankWithCohere(query, candidates, topN = 3) {
  if (!process.env.COHERE_API_KEY) {
    console.warn(
      "⚠️ COHERE_API_KEY missing from environment. Skipping rerank step.",
    );
    return candidates.slice(0, topN);
  }

  try {
    console.log(
      `Sending ${candidates.length} candidates to Cohere Rerank API...`,
    );
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

    if (!response.ok) {
      throw new Error(`Cohere rerank failed with status: ${response.status}`);
    }

    const data = await response.json();
    return data.results.map((r) => ({
      ...candidates[r.index],
      relevanceScore: r.relevance_score,
    }));
  } catch (err) {
    console.error("Reranking failed, falling back to original ordering:", err);
    return candidates.slice(0, topN);
  }
}

app.post("/api/chat", async (req, res) => {
  try {
    const { question } = req.body;
    const normalizedQuestion =
      typeof question === "string" ? question.trim() : "";

    if (!normalizedQuestion) {
      return res.status(400).json({ error: "Question is required!" });
    }

    if (!bm25Index || !vectorStore || !llm) {
      return res.status(503).json({
        error:
          "RAG services are not available. Make sure Ollama and ChromaDB are running.",
      });
    }

    console.log(`\n============================`);
    console.log(`Incoming hybrid search query: "${normalizedQuestion}"`);

    console.log("...Querying Path 1: Chroma Vector Store...");
    let vectorRanked = [];
    try {
      const vectorResults = await vectorStore.similaritySearch(
        normalizedQuestion,
        10,
      );
      vectorRanked = (vectorResults || []).map((doc, index) =>
        normalizeChunkRecord(doc, index, "vector"),
      );
    } catch (vectorError) {
      console.warn(
        "Vector search failed, falling back to BM25 only:",
        vectorError,
      );
    }

    console.log("...Querying Path 2: BM25 Index Store...");
    const bm25Results = bm25Index.search(normalizedQuestion, 10);
    const bm25Ranked = bm25Results.map((item) => {
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

    console.log(
      "🟢 VECTOR FIRST ITEM ID:",
      vectorRanked[0]?.id || "no-vector-results",
    );
    console.log(
      "🔵 BM25 FIRST ITEM ID:",
      bm25Ranked[0]?.id || "no-bm25-results",
    );

    console.log("...Merging ranks using Reciprocal Rank Fusion...");
    const fusedResults = reciprocalRankFusion([vectorRanked, bm25Ranked]) || [];

    const vectorIds = new Set(vectorRanked.map((v) => v.id));
    const hasIntersection = bm25Ranked.some((b) => vectorIds.has(b.id));

    let candidatePool = [];
    const validFused = fusedResults.filter(
      (c) => c && c.text && c.text !== "undefined",
    );

    // 🛠️ MODIFICATION 1: Open context collection to 12 rows for comprehensive Rerank assessment
    if (vectorRanked.length > 0 && hasIntersection && validFused.length > 0) {
      console.log(
        "✅ High-confidence matching IDs found! Gathering top 12 RRF candidates.",
      );
      candidatePool = validFused.slice(0, 12);
    } else {
      console.log(
        "⚠️ Mismatched IDs or zero overlap detected. Gathering fallback candidates.",
      );
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

    // 🛠️ MODIFICATION 2: Execute Cohere API validation over pool
    console.log("...Executing Cohere Cross-Encoder Reranking...");
    const finalContextChunks = await rerankWithCohere(
      normalizedQuestion,
      candidatePool,
      3,
    );

    const formattedContext = finalContextChunks
      .map((c, i) => `[Context Block ${i + 1}]:\n${c.text}`)
      .join("\n\n");

    const finalizedPrompt = `
You are a helpful assistant. Answer the user's question accurately using the provided context blocks below. If the context absolutely does not contain the information needed to answer, reply with "I cannot find the answer in the provided document."

Context:
----------------------------------------
${formattedContext}
----------------------------------------

Question: ${normalizedQuestion}
Answer:
`;

    console.log("Invoking local Llama 3.2 engine over hybrid context...");
    const response = await llm.invoke(finalizedPrompt);
    console.log("Response complete!");

    const answerText =
      typeof response?.content === "string"
        ? response.content
        : response?.content?.[0]?.text || "I could not generate a response.";

    return res.json({ answer: answerText });
  } catch (e) {
    console.error("Backend error:", e);
    return res
      .status(500)
      .json({ error: "Something went wrong in the RAG pipeline." });
  }
});

const startServer = async () => {
  await initializeServices();
  app.listen(PORT, () => {
    console.log(`RAG backend server running on ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
