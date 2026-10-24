import { reciprocalRankFusion } from "./rff.js";

const vectorResults = [
  {
    id: "chunk-1",
    text: "Kruskal builds a minimum spanning tree.",
    source: "DAA.pdf",
    page: 12,
  },
  {
    id: "chunk-2",
    text: "Dijkstra finds shortest paths.",
    source: "DAA.pdf",
    page: 15,
  },
];

const bm25Results = [
  {
    id: "chunk-1",
    text: "Kruskal builds a minimum spanning tree.",
  },
  {
    id: "chunk-3",
    text: "Prim's algorithm builds a minimum spanning tree.",
    source: "Graphs.pdf",
    page: 8,
  },
];

const fusedResults = reciprocalRankFusion([vectorResults, bm25Results]);

console.log("\n--- RRF OUTPUT ---\n");
console.log(JSON.stringify(fusedResults, null, 2));
