/**
 * 01 - Basic Agent Pattern
 *
 * The simplest agent: a system prompt combined with user input produces a response.
 * This demonstrates the core pattern that the OpenAI Agents SDK abstracts --
 * an agent is just a model with instructions and a conversation loop.
 *
 * Pattern: System prompt -> User message -> Model response
 */

import "dotenv/config";
import OpenAI from "openai";

function validateEnv(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY is not set.");
    console.error("Copy .env.example to .env and add your key.");
    process.exit(1);
  }
}

// Agent configuration -- in the Agents SDK, this would be an Agent() object
const AGENT_NAME = "Assistant";
const AGENT_INSTRUCTIONS =
  "You are a helpful assistant. You answer questions clearly and concisely. " +
  "If you do not know the answer, say so honestly.";

/**
 * Run the basic agent with a single user message.
 *
 * This mirrors what Agent.run() does under the hood:
 * 1. Combine the system prompt with user input
 * 2. Call the model
 * 3. Return the response
 */
async function runAgent(userMessage: string): Promise<string> {
  const client = new OpenAI();
  const model = process.env.MODEL ?? "gpt-4o-mini";

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: AGENT_INSTRUCTIONS },
      { role: "user", content: userMessage },
    ],
    temperature: 0.7,
  });

  return response.choices[0].message.content ?? "";
}

export async function main(): Promise<void> {
  validateEnv();

  console.log(`=== ${AGENT_NAME} ===`);
  console.log();

  const query =
    "What are three benefits of using AI agents in software development?";
  console.log(`User: ${query}`);
  console.log();

  const result = await runAgent(query);
  console.log(`Agent: ${result}`);
}

// Run if executed directly
const isDirectRun =
  process.argv[1]?.endsWith("01-basic-agent.ts") ||
  process.argv[1]?.endsWith("01-basic-agent.js");
if (isDirectRun) {
  main();
}
