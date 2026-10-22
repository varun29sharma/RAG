import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { OllamaEmbeddings } from "@langchain/ollama";
import { ChromaClient } from "chromadb";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

async function runRetrieval() {
  console.log("Intialising local embedding configs...");
  //instantiate the exact same embedding model used during ingestion

  const embeddings = new OllamaEmbeddings({
    model: "nomic-embed-text",
    baseUrl: "http://localhost:11434",
  });

  console.log("Connecting to ChromaDB collection ...");
  const chromaClient = new ChromaClient({
    host: "localhost",
    port: 8000,
    ssl: false,
  });

  const vectorStore = new Chroma(embeddings, {
    collectionName: "daa_study_guide_v3",
    index: chromaClient,
  });

  const chunksPath = path.join(__dirname, "chunks-store.json");
  const rawChunks = JSON.parse(fs.readFileSync(chunksPath, "utf-8"));
  const collection = await vectorStore.ensureCollection();
  const existingCount = await collection.count();

  if (existingCount === 0 && rawChunks.length > 0) {
    const docs = rawChunks.map((chunk, index) => ({
      pageContent: chunk.text || chunk.pageContent || "",
      metadata: {
        source: "chunks-store.json",
        chunkIndex: index,
        chunkId: chunk.id || `chunk-${index}`,
      },
    }));
    const ids = rawChunks.map((chunk, index) => chunk.id || `chunk-${index}`);
    await vectorStore.addDocuments(docs, { ids });
  }

  const userQuestion =
    "What is explained about dynamic programming or graph algorithms?";

  console.log(`\nSearching vector database for: "${userQuestion}"...`);

  //we are making a prompt template
  const searchResults = await vectorStore.similaritySearch(userQuestion, 3);

  const formattedContext = searchResults
    .map((text, i) => `[Context Block ${i + 1}]:\n${text.pageContent}`)
    .join("\n\n");

  const finalizedPrompt = `
Answer the question using ONLY the context block provided below. If the context does not contain the answer, reply with "I cannot find the answer in the provided document."

Context:
----------------------------------------
${formattedContext}
----------------------------------------

Question: ${userQuestion}
Answer:
`;
  console.log("\n==============================================");
  console.log("      MANUALLY ASSEMBLED LLM PROMPT         ");
  console.log("==============================================");
  console.log(finalizedPrompt);
}
runRetrieval().catch(console.error);
