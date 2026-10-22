import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { hybridRetrieve } from "./chroma-Day1/lib/retrieval-core.js";
import { createVectorInfrastructure } from "./chroma-Day1/lib/vector-store.js";

// One shared Chroma infrastructure for all tools (single connection set,
// auto-seeds empty collections). The returned vectorStoreFn fans out over
// every registered collection, so the agent searches ALL ingested documents.
const { vectorStoreFn } = await createVectorInfrastructure();

function formatResults(results, label) {
  if (results.length === 0) {
    return "No relevant results found in the study guide.";
  }
  return results
    .map((r, i) => {
      const sourceTag = r.source
        ? ` (source: ${r.source}${r.page ? `, p.${r.page}` : ""})`
        : "";
      return `[${label} ${i + 1}]${sourceTag}\n${r.text}`;
    })
    .join("\n\n");
}

const searchStudyGuideTool = tool(
  async ({ query }) => {
    // Precise slice: top 3 after hybrid fusion + rerank.
    const results = await hybridRetrieve({
      query,
      vectorStoreFn,
      finalTopN: 3,
    });
    return formatResults(results, "Result");
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
    // Wider slice (8) so the agent can synthesize a broad overview.
    const results = await hybridRetrieve({
      query: topic,
      vectorStoreFn,
      finalTopN: 8,
    });
    return formatResults(results, "Excerpt");
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
