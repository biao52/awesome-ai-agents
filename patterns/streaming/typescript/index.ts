/**
 * Streaming Agent
 *
 * An agent that streams both text and tool-call responses in real-time.
 * Text appears character by character, tool arguments stream as they're
 * generated, and tool results feed back into the conversation seamlessly.
 *
 * Usage:
 *   npx tsx index.ts
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const MODEL = process.env.MODEL ?? "claude-sonnet-4-20250514";
const MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(emoji: string, message: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] ${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_weather",
    description:
      "Get the current weather for a city. Returns temperature, conditions, and humidity.",
    input_schema: {
      type: "object" as const,
      properties: {
        city: {
          type: "string",
          description: "The city name (e.g., 'San Francisco', 'London').",
        },
      },
      required: ["city"],
    },
  },
  {
    name: "search_web",
    description:
      "Search the web for information. Returns a list of relevant results.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query.",
        },
      },
      required: ["query"],
    },
  },
];

// ---------------------------------------------------------------------------
// Simulated tool implementations
// ---------------------------------------------------------------------------

interface WeatherEntry {
  temp_f: number;
  condition: string;
  humidity: number;
}

const WEATHER_DATA: Record<string, WeatherEntry> = {
  "san francisco": { temp_f: 62, condition: "Foggy", humidity: 78 },
  london: { temp_f: 55, condition: "Overcast", humidity: 82 },
  tokyo: { temp_f: 73, condition: "Clear", humidity: 60 },
  "new york": { temp_f: 68, condition: "Partly cloudy", humidity: 65 },
};

function executeGetWeather(city: string): string {
  log("🌤️", `Fetching weather for: ${city}`);
  const key = city.toLowerCase().trim();
  const data = WEATHER_DATA[key];
  if (data) {
    return JSON.stringify({
      city,
      temperature_f: data.temp_f,
      temperature_c: Math.round(((data.temp_f - 32) * 5) / 9 * 10) / 10,
      condition: data.condition,
      humidity_percent: data.humidity,
    });
  }
  return JSON.stringify({
    city,
    temperature_f: 70,
    temperature_c: 21.1,
    condition: "Clear",
    humidity_percent: 50,
    note: "Simulated data -- city not in local database.",
  });
}

function executeSearchWeb(query: string): string {
  log("🌐", `Searching: ${query}`);
  const results = [
    {
      title: `Result 1 for '${query}'`,
      url: `https://example.com/1?q=${query.replace(/ /g, "+")}`,
      snippet: `Comprehensive overview of ${query} with recent data and analysis.`,
    },
    {
      title: `Result 2 for '${query}'`,
      url: `https://example.com/2?q=${query.replace(/ /g, "+")}`,
      snippet: `In-depth report on ${query} published this year.`,
    },
  ];
  return JSON.stringify(results, null, 2);
}

function dispatchTool(
  name: string,
  toolInput: Record<string, string>,
): string {
  switch (name) {
    case "get_weather":
      return executeGetWeather(toolInput.city ?? "");
    case "search_web":
      return executeSearchWeb(toolInput.query ?? "");
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ---------------------------------------------------------------------------
// Streaming agent loop
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a helpful assistant with access to weather data and web search.
Answer questions conversationally. When you use tools, explain what you found.
Keep responses concise and informative.`;

interface ContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, string>;
}

async function runStreamingTurn(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
): Promise<void> {
  while (true) {
    const contentBlocks: ContentBlock[] = [];
    let currentBlockIndex = -1;
    let currentToolInputJson = "";
    let stopReason: string | null = null;

    process.stdout.write("\nAssistant: ");

    try {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
      });

      for await (const event of stream) {
        const eventType = event.type;

        // -- Content block started --
        if (eventType === "content_block_start") {
          currentBlockIndex = event.index;
          const block = event.content_block;

          if (block.type === "text") {
            contentBlocks.push({ type: "text", text: "" });
          } else if (block.type === "tool_use") {
            currentToolInputJson = "";
            contentBlocks.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {},
            });
            process.stdout.write(`\n  [calling ${block.name}(`);
          }
        }

        // -- Content block delta (the streaming part) --
        if (eventType === "content_block_delta") {
          const delta = event.delta;

          if (delta.type === "text_delta") {
            process.stdout.write(delta.text);
            const block = contentBlocks[currentBlockIndex];
            if (block) {
              block.text = (block.text ?? "") + delta.text;
            }
          } else if (delta.type === "input_json_delta") {
            process.stdout.write(delta.partial_json);
            currentToolInputJson += delta.partial_json;
          }
        }

        // -- Content block finished --
        if (eventType === "content_block_stop") {
          const block = contentBlocks[currentBlockIndex];
          if (block?.type === "tool_use") {
            try {
              block.input = JSON.parse(currentToolInputJson);
            } catch {
              block.input = {};
            }
            process.stdout.write(")]");
          }
        }

        // -- Message complete --
        if (eventType === "message_delta") {
          stopReason = event.delta.stop_reason ?? null;
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log("❌", `API error: ${errorMsg}`);
      console.log(`\nSorry, I encountered an error: ${errorMsg}`);
      return;
    }

    console.log(); // Newline after streaming

    // Add the assistant's full response to messages
    const assistantContent = contentBlocks.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text ?? "" };
      }
      return {
        type: "tool_use" as const,
        id: block.id!,
        name: block.name!,
        input: block.input ?? {},
      };
    });
    messages.push({ role: "assistant", content: assistantContent });

    // If the model wants to use tools, execute them and continue
    if (stopReason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of contentBlocks) {
        if (block.type === "tool_use") {
          const result = dispatchTool(
            block.name!,
            (block.input ?? {}) as Record<string, string>,
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id!,
            content: result,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      process.stdout.write("Assistant: ");
      continue;
    }

    // No tool calls -- turn is complete
    return;
  }
}

// ---------------------------------------------------------------------------
// Chat loop
// ---------------------------------------------------------------------------

async function chatLoop(): Promise<void> {
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [];

  const rl = readline.createInterface({ input, output });

  console.log();
  console.log("Streaming Agent");
  console.log("=".repeat(40));
  console.log(
    "Responses stream in real-time. Tool calls are visible as they happen.",
  );
  console.log("Try: 'What's the weather in San Francisco and Tokyo?'");
  console.log("Type 'quit' or 'exit' to stop.");
  console.log();

  try {
    while (true) {
      let userInput: string;
      try {
        userInput = (await rl.question("You: ")).trim();
      } catch {
        break;
      }

      if (!userInput) continue;
      if (["quit", "exit", "q"].includes(userInput.toLowerCase())) break;

      messages.push({ role: "user", content: userInput });

      await runStreamingTurn(client, messages);
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();
  log("🚀", "Starting streaming agent...");
  log("📡", `Model: ${MODEL} (streaming enabled)`);
  await chatLoop();
  log("👋", "Goodbye!");
}

main().catch(console.error);
