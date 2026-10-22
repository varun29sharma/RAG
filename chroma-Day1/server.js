// chroma-Day1/server.js — thin HTTP shell over the shared retrieval core.
// ALL pipeline logic lives in lib/ (retrieval-core.js, vector-store.js,
// chunk-store.js). This file only wires HTTP to it — before the refactor,
// the whole pipeline was duplicated between here and retrieval-pipeline.js.

import express from "express";
import cors from "cors";
import { hybridRetrieve } from "./lib/retrieval-core.js";
import { createVectorInfrastructure, OLLAMA_BASE_URL } from "./lib/vector-store.js";
import { listDocuments } from "./lib/chunk-store.js";
import { ChatOllama } from "@langchain/ollama";

const app = express();
const PORT = Number(process.env.PORT || 5001);
const LLM_MODEL = process.env.LLM_MODEL || "llama3.2";

app.use(cors());
app.use(express.json());

// Service state — assigned once by startServer(), read by every request.
let vectorStoreFn = null;
let llm = null;
let ready = false;

// Liveness/readiness probe: reports which retrieval paths are available.
app.get("/health", (req, res) => {
  res.json({
    status: ready ? "ok" : "starting",
    vectorPath: vectorStoreFn ? "available" : "unavailable (BM25-only mode)",
    documents: listDocuments().length,
  });
});

// Registry listing — what documents the copilot currently knows about.
app.get("/api/documents", (req, res) => {
  res.json({ documents: listDocuments() });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { question } = req.body;
    const normalizedQuestion =
      typeof question === "string" ? question.trim() : "";

    if (!normalizedQuestion) {
      return res.status(400).json({ error: "Question is required!" });
    }
    if (!ready) {
      return res.status(503).json({
        error:
          "RAG services are not available. Make sure Ollama and ChromaDB are running.",
      });
    }

    // ---- Retrieval: one call into the shared core. ----
    const retrievalStart = Date.now();
    const finalChunks = await hybridRetrieve({
      query: normalizedQuestion,
      vectorStoreFn,
      finalTopN: 3,
    });
    const retrievalMs = Date.now() - retrievalStart;

    if (finalChunks.length === 0) {
      return res.json({
        answer: "I cannot find the answer in the provided documents.",
        sources: [],
        retrievalMs,
        generationMs: 0,
      });
    }

    // ---- Generation: grounded prompt over the reranked context. ----
    const formattedContext = finalChunks
      .map((c, i) => `[Context Block ${i + 1}]:\n${c.text}`)
      .join("\n\n");

    const finalizedPrompt = `
You are a helpful assistant. Answer the user's question accurately using the provided context blocks below. If the context absolutely does not contain the information needed to answer, reply with "I cannot find the answer in the provided documents."

Context:
----------------------------------------
${formattedContext}
----------------------------------------

Question: ${normalizedQuestion}
Answer:
`;

    const generationStart = Date.now();
    const response = await llm.invoke(finalizedPrompt);
    const generationMs = Date.now() - generationStart;

    const answerText =
      typeof response?.content === "string"
        ? response.content
        : response?.content?.[0]?.text || "I could not generate a response.";

    // Sources give the frontend (and evaluators) verifiable provenance.
    const sources = finalChunks.map((c, i) => ({
      contextBlock: i + 1,
      id: c.id,
      source: c.source || null,
      page: c.page || null,
      relevanceScore: c.relevanceScore ?? null,
    }));

    return res.json({ answer: answerText, sources, retrievalMs, generationMs });
  } catch (e) {
    console.error("Backend error:", e);
    return res
      .status(500)
      .json({ error: "Something went wrong in the RAG pipeline." });
  }
});

// Single initialization point. (Previously initializeServices() ran twice —
// once at top level and once inside startServer — doubling boot work.)
async function startServer() {
  const infra = await createVectorInfrastructure();
  vectorStoreFn = infra.vectorStoreFn;
  console.log(`Vector path: ${infra.collections.length} collection(s) — ${infra.collections.join(", ") || "none"}`);

  llm = new ChatOllama({
    model: LLM_MODEL,
    baseUrl: OLLAMA_BASE_URL,
    temperature: 0,
  });

  ready = true;
  app.listen(PORT, () => {
    console.log(`Campus Copilot backend running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
