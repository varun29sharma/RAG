import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Chroma } from "@langchain/community/vectorstores/chroma";
//import * as chromadbDefaultEmbed from "chromadb-default-embed";
import { OllamaEmbeddings } from "@langchain/ollama";
//const DefaultEmbeddingFunction = chromadbDefaultEmbed.DefaultEmbeddingFunction;
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
async function runIngestion(params) {
  console.log("Loading your study guide PDF...");
  const loader = new PDFLoader(
    "/Users/sudha/Downloads/DAA_Study_Guide_Units3_4_5.pdf",
  );
  const docs = await loader.load();
  const spiltter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
  });

  const chunks = await spiltter.splitDocuments(docs);
  console.log(`Prepared ${chunks.length} chunks.`);

  console.log("3. Connecting to Chroma and initializing embeddings...");
  // We explicitly instantiate the embedding function for LangChain's Chroma wrapper

  const ids = [];
  const cleanedChunksForChroma = [];
  const flatChunksForBM25 = [];

  chunks.forEach((chunk, index) => {
    const chunkId = uuidv4();
    ids.push(chunkId);

    cleanedChunksForChroma.push({
      ...chunk,
      metadata: {
        source: "DAA_Study_Guide_Units3_4_5.pdf",
        chunkIndex: index,
        pageNumber: chunk.metadata.loc?.pageNumber || 1,
        chunkId: chunkId,
      },
    });

    flatChunksForBM25.push({
      id: chunkId,
      text: chunk.pageContent,
    });
  });

  //chroma doesn't accept nested metadata objects like chunk.metadata.pdf

  const embeddings = new OllamaEmbeddings({
    model: "nomic-embed-text", // or whatever local model you pulled
    baseUrl: "http://localhost:11434",
  });
  console.log("Uploading and embedding chunks into chromaDB...");

  //converts the text to vectors and pushes them into the local chroma server
  const vectorStore = await Chroma.fromDocuments(
    cleanedChunksForChroma,
    embeddings,
    {
      collectionName: "daa_study_guide_v3",
      url: "http://localhost:8000",
      ids: ids,
    },
  );

  fs.writeFileSync(
    "./chunks-store.json",
    JSON.stringify(flatChunksForBM25, null, 2),
  );

  console.log(
    "✅ Ingestion Complete! Your PDF is now a searchable vector database.",
  );
}
runIngestion().catch(console.error);
