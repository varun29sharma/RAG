import "dotenv/config"; // 🛠️ Ensures your COHERE_API_KEY is loaded for the under-the-hood tool calls
import { agent } from "./agent.js";

async function watchAgentThink(question) {
  console.log(`\n==================================================`);
  console.log(`STREAMS RUNNING FOR: "${question}"`);
  console.log(`==================================================\n`);

  try {
    // 🛠️ Using LangGraph's streaming mode with a consistent thread_id for state tracking
    const stream = await agent.stream(
      { messages: [{ role: "user", content: question }] },
      { configurable: { thread_id: "debug-session-101" } },
    );

    for await (const step of stream) {
      // LangGraph's React agent updates state inside a "agent" or "tools" node execution block
      const nodeName = Object.keys(step)[0];
      const stepData = step[nodeName];

      if (!stepData || !stepData.messages) continue;

      const lastMessage = stepData.messages[stepData.messages.length - 1];

      if (nodeName === "agent") {
        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
          //Triggers when the LLM decides to call a tool
          console.log(`\n🤔 [Agent Logic] -> Decided to call a tool:`);
          lastMessage.tool_calls.forEach((tc) => {
            console.log(`   🛠️  Tool Name: "${tc.name}"`);
            console.log(`   📦  Arguments: ${JSON.stringify(tc.args)}`);
          });
        } else {
          // 💬 Triggers when the LLM has formulated its final synthesized reply
          console.log(`\n💬 [Agent Final Answer]:`);
          console.log(`   ${lastMessage.content}\n`);
        }
      } else if (nodeName === "tools") {
        // Triggers when your retrieval pipeline executes and sends text back to the LLM
        console.log(
          `\n[Tool Output Received] -> Done executing "${lastMessage.name}":`,
        );
        const snippet =
          typeof lastMessage.content === "string"
            ? lastMessage.content.substring(0, 200)
            : JSON.stringify(lastMessage.content).substring(0, 200);
        console.log(`   📄 Content Snippet: ${snippet.trim()}...\n`);
        console.log(`--------------------------------------------------`);
      }
    }
  } catch (error) {
    console.error("❌ Streaming debugger encountered an error:", error);
  }
}

// 🛠️ Run immediately with a default query or take input from the command line
const testQuery =
  process.argv[2] ||
  "compare the time complexity of dijkstra's and bellman ford";
await watchAgentThink(testQuery);
