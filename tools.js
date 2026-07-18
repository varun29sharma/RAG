import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { retrieveAndRerank } from "./retrieval-pipeline.js";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { OllamaEmbeddings } from "@langchain/ollama";

const embeddings = new OllamaEmbeddings({
  model: "nomic-embed-text",
  baseUrl: "http://localhost:11434",
});

const sharedVectorStore = new Chroma(embeddings, {
  collectionName: "daa_study_guide_v3",
  url: "http://localhost:8000",
});

const searchStudyGuideTool = tool(
  async ({ query }) => {
    // Pass the query and our initialized sharedVectorStore to the wrapper
    const results = await retrieveAndRerank(query, sharedVectorStore, 3);
    if (results.length === 0) {
      return "No relevant results found in the study guide.";
    }
    return results.map((r, i) => `[Result ${i + 1}]\n${r.text}`).join("\n\n");
  },
  {
    name: "search_study_guide",
    description:
      "Search for a SPECIFIC fact, definition, algorithm detail, or complexity notation. " +
      "Best for precise questions with a clear right answer. Reformulate the user's question " +
      "into clear search terms before calling this.",
    schema: z.object({
      query: z.string().describe("A specific, well-formed search query"),
    }),
  },
);

const summarizeTopicTool = tool(
  async ({ topic }) => {
    // 🛠️ Grab a wider set of chunks (8) for synthesizing a broad topic summary
    const results = await retrieveAndRerank(topic, sharedVectorStore, 8);
    if (results.length === 0) {
      return "No relevant material found on this topic.";
    }
    return results.map((r, i) => `[Excerpt ${i + 1}]\n${r.text}`).join("\n\n");
  },
  {
    name: "summarize_topic",
    description:
      "Retrieve a BROAD set of excerpts about a general topic so you can synthesize an overview, " +
      "comparison, or explanation. Use for open-ended questions, not specific factual lookups.",
    schema: z.object({
      topic: z
        .string()
        .describe("The general topic or concept to gather material on"),
    }),
  },
);

export { searchStudyGuideTool, summarizeTopicTool };
