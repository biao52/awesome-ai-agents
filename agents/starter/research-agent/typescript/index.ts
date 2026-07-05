/**
 * Research Agent — Takes a topic, searches the web, and produces a structured report.
 *
 * Uses OpenAI for reasoning and Tavily for web search.
 */

import "dotenv/config";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["OPENAI_API_KEY", "TAVILY_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Tools — web search and page reading
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

async function searchWeb(query: string, maxResults: number = 5): Promise<SearchResult[]> {
  /** Search the web using the Tavily API. */
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: maxResults,
      include_raw_content: false,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { results: Array<{ title: string; url: string; content: string }> };

  return (data.results || []).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    content: item.content || "",
  }));
}

async function readPage(url: string): Promise<string> {
  /** Fetch a web page and return its text content (truncated to ~6000 chars). */
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ResearchAgent/1.0)" },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return `Error reading page: ${response.status} ${response.statusText}`;
    }

    const text = await response.text();
    return text.slice(0, 6000);
  } catch (e) {
    return `Error reading page: ${e}`;
  }
}

// ---------------------------------------------------------------------------
// Tool definitions for OpenAI function calling
// ---------------------------------------------------------------------------

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web for information on a query. Returns titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          max_results: {
            type: "integer",
            description: "Maximum number of results to return (default 5).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description: "Fetch and read the content of a web page given its URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to read." },
        },
        required: ["url"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a research agent. Given a topic, you:

1. Create a research plan with 3-5 sub-questions that will help you thoroughly understand the topic.
2. For each sub-question, search the web and read the most relevant pages.
3. Synthesize all findings into a structured markdown report.

Your final output MUST be a well-structured markdown report with:
- A title (# heading)
- An executive summary (2-3 sentences)
- Sections for each major finding (## headings)
- Key facts, data, and quotes where relevant
- A Sources section at the end listing all URLs you referenced

Be thorough but concise. Cite your sources inline like [1], [2], etc.

When you start, first announce your research plan, then execute it step by step.
Use the search_web tool to find information and read_page to get more detail from specific URLs.`;

async function runAgent(topic: string, model: string): Promise<string> {
  /** Run the research agent on a topic and return the final report. */
  const client = new OpenAI();

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Research this topic and produce a comprehensive report: ${topic}` },
  ];

  log("🔍", "Creating research plan...");

  // Agent loop — keep going until the model stops calling tools
  while (true) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools,
      temperature: 0.3,
    });

    const choice = response.choices[0];
    const message = choice.message;

    // Add assistant message to history
    messages.push(message);

    // If no tool calls, the agent is done
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content || "";
    }

    // Process each tool call
    for (const toolCall of message.tool_calls) {
      const fnName = toolCall.function.name;
      const fnArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

      let resultStr: string;

      if (fnName === "search_web") {
        const query = fnArgs.query as string;
        const maxResults = (fnArgs.max_results as number) || 5;
        log("🌐", `Searching: ${query}`);
        const result = await searchWeb(query, maxResults);
        resultStr = JSON.stringify(result, null, 2);
        log("   ", `Found ${result.length} results`);
      } else if (fnName === "read_page") {
        const url = fnArgs.url as string;
        const domain = url.split("/")[2] || url;
        log("📄", `Reading: ${domain}`);
        resultStr = await readPage(url);
      } else {
        resultStr = `Unknown tool: ${fnName}`;
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: resultStr,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || "gpt-4o-mini";
  const args = process.argv.slice(2);

  let topic = "";
  let outputFile: string | null = null;

  // Parse CLI args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && i + 1 < args.length) {
      outputFile = args[i + 1];
      i++;
    } else {
      topic += (topic ? " " : "") + args[i];
    }
  }

  // Interactive mode if no topic provided
  if (!topic) {
    process.stdout.write("🔬 What would you like to research? ");
    topic = await new Promise<string>((resolve) => {
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        input += chunk;
        if (input.includes("\n")) {
          process.stdin.pause();
          resolve(input.trim());
        }
      });
      process.stdin.resume();
    });
  }

  if (!topic.trim()) {
    console.error("❌ Please provide a research topic.");
    process.exit(1);
  }

  log("🚀", "Starting research agent...");
  log("📋", `Research topic: ${topic}`);
  log("🤖", `Model: ${model}`);
  console.log();

  try {
    const report = await runAgent(topic, model);

    console.log("\n" + "=".repeat(60));
    log("✅", "Research complete! Report:\n");
    console.log(report);

    if (outputFile) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputFile, report, "utf8");
      log("💾", `Report saved to ${outputFile}`);
    }
  } catch (e) {
    console.error(`\n❌ Error during research: ${e}`);
    process.exit(1);
  }
}

main().catch(console.error);
