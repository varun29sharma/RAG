import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import { ChatOllama } from "@langchain/ollama";
import { searchStudyGuideTool, summarizeTopicTool } from "./tools.js";

const llm = new ChatOllama({
  model: "llama3.2",
  baseUrl: "http://localhost:11434",
  temperature: 0, // Enforces logical, consistent routing decisions
});

const tools = [searchStudyGuideTool, summarizeTopicTool];

const SYSTEM_PROMPT = `You are a DAA (Design and Analysis of Algorithms) study assistant with two tools.

- Use search_study_guide for specific factual questions (definitions, exact complexity, named algorithms).
- Use summarize_topic for broad "explain X" or "compare X and Y" questions.

If a search_study_guide result doesn't fully answer the question, you MAY call it again with a
reformulated, more specific query before giving your final answer — don't guess if you can search again instead.

If neither tool returns relevant information after a reasonable attempt, say so honestly rather than
making something up.

Always answer based only on what the tools return, never from general knowledge.`;

const checkpointer = new MemorySaver();

const agent = createReactAgent({
  llm,
  tools,
  checkpointSaver: checkpointer,
  messageModifier: SYSTEM_PROMPT,
});

export { agent };
