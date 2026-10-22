// ingest.js — generic ingestion CLI: turns ANY PDF into a searchable
// collection. Replaces the old hardcoded single-PDF script. Chunks land in
// two places: Chroma (dense search) and lib/stores/<collection>.json
// (BM25 + registry, via chunk-store.js).

import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { OllamaEmbeddings } from "@langchain/ollama";
import { ChromaClient } from "chromadb";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  registerDocument,
  purgeCollection,
  isValidCollectionName,
  migrateLegacyChunks,
} from "./lib/chunk-store.js";
import {
  OLLAMA_BASE_URL,
  EMBEDDING_MODEL,
} from "./lib/vector-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- CLI argument parsing (no deps — argv is simple enough) ----------------
// Usage:
//   node ingest.js --pdf <path> --collection <name> [--name <label>] [--replace]
//   node ingest.js --migrate-legacy
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--migrate-legacy") {
      args.migrateLegacy = true;
    } else if (arg === "--replace") {
      args.replace = true;
    } else if (arg.startsWith("--")) {
      args[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// One-time migration path: import the pre-refactor chunks-store.json.
if (args.migrateLegacy) {
  const result = migrateLegacyChunks();
  console.log(
    result.migrated
      ? `✅ Migrated legacy chunks into collection "${result.doc.collection}" (${result.doc.totalChunksInCollection} chunks).`
      : `Nothing to migrate: ${result.reason}`,
  );
  process.exit(0);
}

if (!args.pdf || !args.collection) {
  console.error(`
Usage:
  node ingest.js --pdf <path-to-pdf> --collection <name> [--name <label>] [--replace]

  --pdf          Path to the PDF to ingest
  --collection   Collection name (lowercase letters, digits, "-" or "_")
  --name         Optional human label (defaults to the PDF filename)
  --replace      Purge the collection first instead of merging into it

Examples:
  node ingest.js --pdf ./DAA_Study_Guide_Units3_4_5.pdf --collection daa-study-guide
  node ingest.js --pdf ./placement-policy.pdf --collection campus-policies --replace
`);
  process.exit(1);
}

const pdfPath = path.resolve(args.pdf);
const collection = args.collection;
const docName = args.name || path.basename(pdfPath);

// ---- Validation before any network/model work ------------------------------
if (!fs.existsSync(pdfPath)) {
  console.error(`❌ PDF not found: ${pdfPath}`);
  process.exit(1);
}
if (!isValidCollectionName(collection)) {
  console.error(
    `❌ Invalid collection name "${collection}": use lowercase letters, digits, "-" or "_" (max 64 chars).`,
  );
  process.exit(1);
}
if (args.replace) {
  purgeCollection(collection);
  console.log(`Purged existing collection "${collection}".`);
}

async function runIngestion() {
  console.log(`Loading PDF: ${pdfPath}`);
  const loader = new PDFLoader(pdfPath);
  const docs = await loader.load();
  console.log(`Loaded ${docs.length} page(s).`);

  // 500 chars with 50 overlap: answers that sit exactly on a chunk boundary
  // stay intact because the boundary region appears in both neighbours.
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
  });
  const chunks = await splitter.splitDocuments(docs);
  console.log(`Split into ${chunks.length} chunks.`);

  // Build both artifacts from the same chunks so dense and keyword search
  // can never disagree about what's in the corpus.
  const ids = [];
  const flatChunks = [];
  const chromaDocs = [];

  chunks.forEach((chunk, index) => {
    const chunkId = uuidv4();
    ids.push(chunkId);

    // Flat, BM25-compatible shape. page = PDF page number when available.
    flatChunks.push({
      id: chunkId,
      text: chunk.pageContent,
      source: docName,
      page: chunk.metadata?.loc?.pageNumber ?? null,
    });

    // Chroma rejects nested metadata objects, so keep everything flat.
    chromaDocs.push({
      ...chunk,
      metadata: {
        source: docName,
        chunkIndex: index,
        pageNumber: chunk.metadata?.loc?.pageNumber ?? 1,
        chunkId,
      },
    });
  });

  // ---- Registry + BM25 store (the system of record) ----
  const registered = registerDocument({
    name: docName,
    collection,
    sourceFile: pdfPath,
    flatChunks,
  });
  console.log(
    `Registered "${registered.name}" → collection "${collection}" (${flatChunks.length} new chunks).`,
  );

  // ---- Chroma (dense search) ----
  console.log("Connecting to Chroma and embedding chunks...");
  const embeddings = new OllamaEmbeddings({
    model: EMBEDDING_MODEL,
    baseUrl: OLLAMA_BASE_URL,
  });
  const client = new ChromaClient({
    host: process.env.CHROMA_HOST || "localhost",
    port: Number(process.env.CHROMA_PORT || 8000),
    ssl: false,
  });

  const vectorStore = await Chroma.fromDocuments(chromaDocs, embeddings, {
    collectionName: collection,
    index: client,
    ids,
  });
  console.log(`Embedded ${ids.length} chunks into Chroma collection "${collection}".`);

  console.log("✅ Ingestion complete. Restart the server to pick it up:");
  console.log("   npm run server");
}

runIngestion().catch((error) => {
  console.error("❌ Ingestion failed:", error.message);
  process.exit(1);
});
