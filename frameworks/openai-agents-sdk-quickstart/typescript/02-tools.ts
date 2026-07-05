/**
 * 02 - Agent with Tools
 *
 * An agent that can call external tools (functions) to gather information
 * before responding. This demonstrates the function-calling pattern that
 * the Agents SDK wraps with its tool() decorator.
 *
 * Pattern: User message -> Model decides to call tool(s) -> Execute tools
 *          -> Feed results back -> Model produces final response
 */

import "dotenv/config";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

function validateEnv(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY is not set.");
    console.error("Copy .env.example to .env and add your key.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Tool implementations -- in the Agents SDK these would be @tool functions
// ---------------------------------------------------------------------------

interface WeatherData {
  city: string;
  temp_f: number;
  condition: string;
  humidity: number;
}

function getWeather(city: string): WeatherData {
  const weatherData: Record<string, Omit<WeatherData, "city">> = {
    "new york": { temp_f: 72, condition: "Partly cloudy", humidity: 55 },
    london: { temp_f: 61, condition: "Overcast", humidity: 78 },
    tokyo: { temp_f: 85, condition: "Sunny", humidity: 60 },
  };
  const data = weatherData[city.toLowerCase()] ?? {
    temp_f: 68,
    condition: "Clear",
    humidity: 50,
  };
  return { city, ...data };
}

function calculate(
  expression: string
): { expression: string; result: number } | { error: string } {
  const allowed = new Set("0123456789+-*/(). ".split(""));
  for (const c of expression) {
    if (!allowed.has(c)) {
      return { error: "Invalid characters in expression" };
    }
  }
  try {
    // Safe eval with only math operations
    const result = Function(`"use strict"; return (${expression})`)() as number;
    return { expression, result };
  } catch (e) {
    return { error: String(e) };
  }
}

const toolFunctions: Record<string, (args: Record<string, string>) => unknown> =
  {
    get_weather: (args) => getWeather(args.city),
    calculate: (args) => calculate(args.expression),
  };

// OpenAI function-calling schema
const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
        },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Evaluate a mathematical expression",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "Math expression to evaluate",
          },
        },
        required: ["expression"],
      },
    },
  },
];

const AGENT_INSTRUCTIONS =
  "You are a helpful assistant with access to weather and calculator tools. " +
  "Use them when the user asks about weather or needs calculations.";

/**
 * Run an agent that can use tools via function calling.
 *
 * The loop mirrors the Agents SDK's tool execution cycle:
 * 1. Send messages to the model with tool definitions
 * 2. If the model returns tool_calls, execute them
 * 3. Feed results back and repeat until the model produces a text response
 */
async function runAgentWithTools(userMessage: string): Promise<string> {
  const client = new OpenAI();
  const model = process.env.MODEL ?? "gpt-4o-mini";

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: AGENT_INSTRUCTIONS },
    { role: "user", content: userMessage },
  ];

  // Tool execution loop
  while (true) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools,
      temperature: 0.3,
    });

    const choice = response.choices[0];

    if (!choice.message.tool_calls?.length) {
      return choice.message.content ?? "";
    }

    // Add assistant message with tool calls
    messages.push(choice.message);

    // Process each tool call
    for (const toolCall of choice.message.tool_calls) {
      const fnName = toolCall.function.name;
      const fnArgs = JSON.parse(toolCall.function.arguments) as Record<
        string,
        string
      >;

      console.log(`  [Tool Call] ${fnName}(${JSON.stringify(fnArgs)})`);

      const fn = toolFunctions[fnName];
      const result = fn
        ? fn(fnArgs)
        : { error: `Unknown tool: ${fnName}` };

      console.log(`  [Tool Result] ${JSON.stringify(result)}`);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }
}

export async function main(): Promise<void> {
  validateEnv();

  console.log("=== Agent with Tools ===");
  console.log();

  const queries = [
    "What's the weather in Tokyo?",
    "What is (42 * 17) + (256 / 8)?",
    "Compare the weather in New York and London.",
  ];

  for (const query of queries) {
    console.log(`User: ${query}`);
    const result = await runAgentWithTools(query);
    console.log(`Agent: ${result}`);
    console.log();
  }
}

const isDirectRun =
  process.argv[1]?.endsWith("02-tools.ts") ||
  process.argv[1]?.endsWith("02-tools.js");
if (isDirectRun) {
  main();
}
