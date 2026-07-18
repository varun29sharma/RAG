import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { OllamaEmbeddings, ChatOllama } from "@langchain/ollama";
import { ChromaClient } from "chromadb";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

async function runRAG() {
  console.log("Initializing embedding & chat models ...");

  //embedding model for searching the database
  const embeddings = new OllamaEmbeddings({
    model: "nomic-embed-text",
    baseUrl: "http://localhost:11434",
  });

  //chat model(the head chef) to generate the answer
  const llm = new ChatOllama({
    model: "llama3.2",
    baseUrl: "http://localhost:11434",
    temperature: 1, //keeping the answers precise and strict to context
  });

  console.log("connectiong to ChromaDB ...");
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
    "What are the two properties required for dynamic programming to be applicable?";

  console.log(`\nRetrieving context for: "${userQuestion}"...`);

  //pull the top 3 chunks
  const searchResults = await vectorStore.similaritySearch(userQuestion, 3);

  //formating the context blocks
  const formattedContext = searchResults
    .map((doc, i) => `[Context Block ${i + 1}]:\n${doc.pageContent}`)
    .join("\n\n");

  //assembling the prompt
  const finalizedPrompt = `
You are a helpful assistant. Answer the user's question accurately using the provided context blocks below. If the context absolutely does not contain the information needed to answer, reply with "I cannot find the answer in the provided document."

Context:
----------------------------------------
${formattedContext}
----------------------------------------

Question: ${userQuestion}
Answer:
`;
  console.log("3. Sending full prompt to llama3.2...");
  console.log("Generating answer...\n");

  const response = await llm.invoke(finalizedPrompt);

  console.log(
    "========================= CHATBOT ANSWER =========================",
  );
  console.log(response.content);
  console.log(
    "==================================================================",
  );
}
runRAG().catch(console.error);
