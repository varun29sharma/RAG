// lib/chunk-store.js — document registry + per-collection chunk storage.
// Single source of truth for "which documents exist and which chunks belong
// to them". The BM25 index and the Chroma reseed path both read from here,
// so ingestion, retrieval and the agent layer can never disagree.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { BM25Index } from "../bm25.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIB_DIR = __dirname;
const ROOT_DIR = path.resolve(LIB_DIR, "..");

// Where the registry and the per-collection chunk stores live.
const REGISTRY_PATH = path.join(LIB_DIR, "documents.json");
const STORES_DIR = path.join(LIB_DIR, "stores");
// The pre-refactor flat chunk file produced by the old ingest.js.
// Kept as a migration source so existing setups keep working.
const LEGACY_CHUNKS_PATH = path.join(ROOT_DIR, "chunks-store.json");

// In-memory caches, filled lazily on first access.
let registryCache = null; // parsed documents.json
const bm25Cache = new Map(); // collectionName -> BM25Index

/*
  this is the second cache for combined indexes
  because... instead of calculation stats for each collection seperately
  pulling the chunks from both collections into one single stack is way
  more efficient
*/
const combinedBm25Cache = new Map();

// Collection names become filenames under stores/, so restrict the charset
// to keep the path safe and predictable (also enforced by the ingest CLI).
function isValidCollectionName(name) {
  return typeof name === "string" && /^[a-z0-9][a-z0-9-_]{0,63}$/.test(name);
}

function ensureStoresDir() {
  if (!fs.existsSync(STORES_DIR)) {
    fs.mkdirSync(STORES_DIR, { recursive: true });
  }
}

function readRegistry() {
  if (registryCache) return registryCache;
  if (!fs.existsSync(REGISTRY_PATH)) {
    registryCache = { documents: [] };
    return registryCache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
    registryCache = Array.isArray(parsed.documents)
      ? parsed
      : { documents: [] };
  } catch (error) {
    console.error("Failed to parse documents.json, starting fresh:", error);
    registryCache = { documents: [] };
  }
  return registryCache;
}

function writeRegistry() {
  ensureStoresDir();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registryCache, null, 2));
}

// ---- Public API -----------------------------------------------------------

function listDocuments() {
  return readRegistry().documents;
}

function getDocument(docId) {
  return listDocuments().find((doc) => doc.id === docId) || null;
}

function getDocumentsForCollection(collection) {
  return listDocuments().filter((doc) => doc.collection === collection);
}

function collectionExists(collection) {
  return (
    isValidCollectionName(collection) &&
    fs.existsSync(path.join(STORES_DIR, `${collection}.json`))
  );
}

// Registers a freshly ingested document and writes its chunk store.
// flatChunks: [{ id, text, page? }] — exactly the shape BM25Index expects.
function registerDocument({ name, collection, sourceFile, flatChunks }) {
  if (!isValidCollectionName(collection)) {
    throw new Error(
      `Invalid collection name "${collection}": use lowercase letters, ` +
        `digits, "-" or "_" (max 64 chars).`,
    );
  }
  if (!Array.isArray(flatChunks) || flatChunks.length === 0) {
    throw new Error("Cannot register a document with zero chunks.");
  }

  ensureStoresDir();

  // One store per collection; multiple documents may share a collection,
  // so merge with existing chunks instead of overwriting them.
  const existing = readCollectionStore(collection);
  const seenIds = new Set(existing.map((chunk) => chunk.id));
  const merged = [...existing];
  for (const chunk of flatChunks) {
    if (!chunk || !chunk.id || seenIds.has(chunk.id)) continue;
    merged.push(chunk);
    seenIds.add(chunk.id);
  }

  fs.writeFileSync(
    path.join(STORES_DIR, `${collection}.json`),
    JSON.stringify(merged, null, 2),
  );

  const doc = {
    id: `${collection}-${merged.length}-${Date.now().toString(36)}`,
    name,
    collection,
    sourceFile,
    chunkCount: flatChunks.length,
    totalChunksInCollection: merged.length,
    ingestedAt: new Date().toISOString(),
  };

  const registry = readRegistry();
  registry.documents.push(doc);
  writeRegistry();

  // Drop any cached index for this collection so the next retrieval
  // rebuilds BM25 over the merged chunk set.
  bm25Cache.delete(collection);
  //deleting the secondary cache
  combinedBm25Cache.clear();
  return doc;
}

// Removes every trace of a collection: registry entries, its store file,
// and any cached BM25 index. Used by the ingest CLI's --replace flag.
function purgeCollection(collection) {
  if (!isValidCollectionName(collection)) {
    throw new Error(`Invalid collection name "${collection}".`);
  }
  const registry = readRegistry();
  registry.documents = registry.documents.filter(
    (doc) => doc.collection !== collection,
  );
  writeRegistry();

  const storePath = path.join(STORES_DIR, `${collection}.json`);
  if (fs.existsSync(storePath)) fs.rmSync(storePath);
  bm25Cache.delete(collection);
  combinedBm25Cache.clear();
}

function readCollectionStore(collection) {
  const storePath = path.join(STORES_DIR, `${collection}.json`);
  if (!fs.existsSync(storePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(`Failed to read store for "${collection}":`, error);
    return [];
  }
}

// Same as readCollectionStore but throws when the collection is unknown —
// used by retrieval paths that need a hard failure, not an empty result.
function loadChunks(collection) {
  if (!collectionExists(collection)) {
    throw new Error(
      `Unknown collection "${collection}". Ingest a document into it first.`,
    );
  }
  return readCollectionStore(collection);
}

// BM25 index per collection, built once and cached until re-ingestion.
function getBm25Index(collection) {
  if (bm25Cache.has(collection)) return bm25Cache.get(collection);
  const chunks = readCollectionStore(collection);
  if (chunks.length === 0) return null;
  const index = new BM25Index(chunks);
  bm25Cache.set(collection, index);
  return index;
}

function getCombinedBm25Index(collections) {
  if (!Array.isArray(collections)) {
    throw new Error("Collections must be an array");
  }

  const activeCollections = [
    //used to remove duplicate collection names
    ...new Set(collections.filter(collectionExists)),
  ].sort();

  if (activeCollections.length === 0) return null;

  const cacheKey = JSON.stringify(activeCollections);

  if (combinedBm25Cache.has(cacheKey)) {
    return combinedBm25Cache.get(cacheKey);
  }
  //flatMap is used to combine the chunks from all active collections
  const chunks = activeCollections.flatMap(readCollectionStore);
  if (chunks.length === 0) return null;

  const index = new BM25Index(chunks);
  combinedBm25Cache.set(cacheKey, index);

  return index;
}

// One-time migration: turns the legacy chunks-store.json into a proper
// registry entry + collection store, then renames the legacy file to
// chunks-store.json.migrated so it is never read twice.
function migrateLegacyChunks(
  collection = "daa-study-guide",
  name = "DAA Study Guide (Units 3-5)",
) {
  if (!fs.existsSync(LEGACY_CHUNKS_PATH)) {
    return { migrated: false, reason: "No legacy chunks-store.json found." };
  }
  const flatChunks = JSON.parse(fs.readFileSync(LEGACY_CHUNKS_PATH, "utf-8"));
  const doc = registerDocument({
    name,
    collection,
    sourceFile: "DAA_Study_Guide_Units3_4_5.pdf (legacy import)",
    flatChunks,
  });
  fs.renameSync(LEGACY_CHUNKS_PATH, `${LEGACY_CHUNKS_PATH}.migrated`);
  return { migrated: true, doc };
}

export {
  listDocuments,
  getDocument,
  getDocumentsForCollection,
  collectionExists,
  registerDocument,
  purgeCollection,
  readCollectionStore,
  loadChunks,
  getBm25Index,
  migrateLegacyChunks,
  isValidCollectionName,
  getCombinedBm25Index,
};
