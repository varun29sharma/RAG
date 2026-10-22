// lib/vector-store.js — shared Chroma infrastructure.
// Builds the embedding model, the Chroma client, and one Chroma collection
// per registered chunk-store collection. Both the HTTP server and the agent
// tools use this, so there is exactly ONE place that knows how Chroma is
// wired (previously server.js and tools.js each had their own divergent copy).

import { Chroma } from "@langchain/community/vectorstores/chroma";
import { OllamaEmbeddings } from "@langchain/ollama";
import { ChromaClient } from "chromadb";
import {
  listDocuments,
  readCollectionStore,
  isValidCollectionName,
} from "./chunk-store.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "nomic-embed-text";
const CHROMA_HOST = process.env.CHROMA_HOST || "localhost";
const CHROMA_PORT = Number(process.env.CHROMA_PORT || 8000);

// Queries every registered Chroma collection and merges the hits. This is
// what makes retrieval cross-document: one question fans out over all
// collections, and every hit keeps its source collection in metadata.
async function searchAllCollections(stores, query, topK) {
  const results = await Promise.all(
    stores.map(async ({ name, store }) => {
      try {
        const hits = await store.similaritySearch(query, topK);
        return hits.map((doc) => ({
          ...doc,
          metadata: { ...doc.metadata, collection: name },
        }));
      } catch (err) {
        console.warn(`Vector search failed for "${name}":`, err.message);
        return [];
      }
    }),
  );
  return results.flat();
}

// Bootstraps everything vector-related. Returns { embeddings, vectorStoreFn }.
// - embeddings: shared OllamaEmbeddings instance (must match ingest-time
//   model or similarity search silently degrades).
// - vectorStoreFn(query, topK): the injected dense-retrieval function that
//   lib/retrieval-core.js expects.
async function createVectorInfrastructure() {
  const embeddings = new OllamaEmbeddings({
    model: EMBEDDING_MODEL,
    baseUrl: OLLAMA_BASE_URL,
  });

  const client = new ChromaClient({
    host: CHROMA_HOST,
    port: CHROMA_PORT,
    ssl: false,
  });

  const registeredCollections = [
    ...new Set(listDocuments().map((doc) => doc.collection)),
  ].filter(isValidCollectionName);

  const stores = [];
  for (const name of registeredCollections) {
    try {
      const store = new Chroma(embeddings, {
        collectionName: name,
        index: client,
      });

      // Auto-populate on cold start: if the Chroma collection is empty
      // (fresh container, wiped volume), reseed it from the local chunk
      // store. This replaces the old ensureChromaCollectionHasDocuments().
      const collection = await store.ensureCollection();
      const existingCount = await collection.count();
      if (existingCount === 0) {
        const chunks = readCollectionStore(name);
        if (chunks.length > 0) {
          const documents = chunks.map((chunk, index) => ({
            pageContent: chunk.text || chunk.pageContent || "",
            metadata: {
              source: chunk.source || "chunk-store",
              chunkIndex: index,
              chunkId: chunk.id,
              pageNumber: chunk.page || 1,
            },
          }));
          await store.addDocuments(
            documents,
            { ids: chunks.map((chunk) => chunk.id) },
          );
          console.log(
            `Seeded Chroma collection "${name}" with ${documents.length} chunks.`,
          );
        }
      }

      stores.push({ name, store });
    } catch (err) {
      console.warn(`Could not open Chroma collection "${name}":`, err.message);
    }
  }

  if (stores.length === 0) {
    console.warn(
      "No Chroma collections available — vector path disabled, BM25-only mode.",
    );
  }

  const vectorStoreFn = (query, topK) =>
    searchAllCollections(stores, query, topK);

  return { embeddings, vectorStoreFn, collections: stores.map((s) => s.name) };
}

export { createVectorInfrastructure, OLLAMA_BASE_URL, EMBEDDING_MODEL };
