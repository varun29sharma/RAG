import fs from "fs";
import { BM25Index } from "./bm25.js";

// 1. Load the text chunk file created by your ingest script
if (!fs.existsSync("./chunks-store.json")) {
  console.error(
    "❌ Error: chunks-store.json not found! Run 'node ingest.js' first to generate it.",
  );
  process.exit(1);
}

console.log("📖 Loading chunks-store.json...");
const rawChunks = JSON.parse(fs.readFileSync("./chunks-store.json", "utf-8"));
console.log(`✅ Loaded ${rawChunks.length} text chunks successfully.`);

// 2. Initialize your BM25 indexer instance
console.log("🏗️ Initializing BM25 Index...");
const bm25 = new BM25Index(rawChunks);

// 3. Define a highly specific test keyword phrase from your DAA study guide
const testQuery = "Kruskal time complexity";

console.log(`\n🔍 Searching keyword index for: "${testQuery}"...\n`);
const results = bm25.search(testQuery, 3); // Get top 3 exact matches

// 4. Print out the scoreboard matches
if (results.length === 0) {
  console.log(
    "❌ No keyword matches found! Try a word you know is inside your document.",
  );
} else {
  results.forEach((match, index) => {
    console.log(
      `--- [Rank #${index + 1}] Score: ${match.score.toFixed(4)} ---`,
    );
    console.log(`ID: ${match.id}`);
    console.log(`Content snippet:\n${match.text.substring(0, 250)}...\n`);
  });
}
