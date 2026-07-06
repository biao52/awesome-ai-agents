/**
 * Retry & Fallback Agent
 *
 * An agent with exponential backoff retry logic and automatic model fallback.
 * If the primary model (Claude) fails after all retries, it falls back to
 * the secondary model (GPT-4o-mini) transparently.
 *
 * Usage:
 *   npx tsx index.ts                     # Normal mode
 *   npx tsx index.ts --simulate-failure  # Simulate primary model failure
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PRIMARY_MODEL = process.env.PRIMARY_MODEL ?? "claude-sonnet-4-20250514";
const FALLBACK_MODEL = process.env.FALLBACK_MODEL ?? "gpt-4o-mini";
const MAX_RETRIES = 3;
const BASE_DELAY_SECONDS = 2; // Exponential backoff: 2s, 4s, 8s

const SIMULATE_FAILURE = process.argv.includes("--simulate-failure");

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
  const required = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Request tracking
// ---------------------------------------------------------------------------

interface RequestStats {
  primaryAttempts: number;
  fallbackAttempts: number;
  modelUsed: string;
  totalTimeSeconds: number;
  errors: string[];
}

function createStats(): RequestStats {
  return {
    primaryAttempts: 0,
    fallbackAttempts: 0,
    modelUsed: "",
    totalTimeSeconds: 0,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof OpenAI.APIConnectionError) return true;
  if (err instanceof OpenAI.RateLimitError) return true;
  if (err instanceof OpenAI.InternalServerError) return true;
  return false;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  baseDelay: number = BASE_DELAY_SECONDS,
  modelLabel: string = "model",
): Promise<{ result: T; attempts: number }> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isRetryableError(err)) {
        log("❌", `${modelLabel} non-retryable error: ${lastError.message}`);
        throw lastError;
      }

      if (attempt < maxRetries) {
        const delay = baseDelay * 2 ** (attempt - 1);
        log(
          "🔄",
          `${modelLabel} attempt ${attempt}/${maxRetries} failed: ${lastError.message}`,
        );
        log("⏳", `Retrying in ${delay}s...`);
        await sleep(delay * 1000);
      } else {
        log(
          "❌",
          `${modelLabel} attempt ${attempt}/${maxRetries} failed: ${lastError.message}`,
        );
      }
    }
  }

  throw lastError!;
}

// ---------------------------------------------------------------------------
// Model clients
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a helpful, concise assistant. Answer questions directly.
Keep responses clear and to the point.`;

interface Message {
  role: "user" | "assistant";
  content: string;
}

async function callPrimary(
  client: Anthropic,
  messages: Message[],
  simulateFailure: boolean,
): Promise<string> {
  if (simulateFailure) {
    throw new Anthropic.InternalServerError(
      500,
      {
        type: "error",
        error: {
          type: "api_error",
          message: "Simulated server error for testing fallback",
        },
      },
      "Simulated server error for testing fallback",
      undefined as unknown as Headers,
    );
  }

  const anthropicMessages: Anthropic.MessageParam[] = messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  const response = await client.messages.create({
    model: PRIMARY_MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: anthropicMessages,
  });

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text);

  return textBlocks.join("\n");
}

async function callFallback(
  client: OpenAI,
  messages: Message[],
): Promise<string> {
  const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    })),
  ];

  const response = await client.chat.completions.create({
    model: FALLBACK_MODEL,
    messages: openaiMessages,
  });

  return response.choices[0].message.content ?? "";
}

// ---------------------------------------------------------------------------
// Agent with retry + fallback
// ---------------------------------------------------------------------------

async function sendWithResilience(
  anthropicClient: Anthropic,
  openaiClient: OpenAI,
  messages: Message[],
  simulateFailure: boolean,
): Promise<{ text: string; stats: RequestStats }> {
  const stats = createStats();
  const startTime = performance.now();

  // -- Try primary model --
  log("🎯", `Trying primary model: ${PRIMARY_MODEL}`);
  try {
    const { result, attempts } = await retryWithBackoff(
      () => callPrimary(anthropicClient, messages, simulateFailure),
      MAX_RETRIES,
      BASE_DELAY_SECONDS,
      `Primary (${PRIMARY_MODEL})`,
    );
    stats.primaryAttempts = attempts;
    stats.modelUsed = PRIMARY_MODEL;
    stats.totalTimeSeconds = (performance.now() - startTime) / 1000;
    log("✅", `Primary model responded (attempt ${attempts}/${MAX_RETRIES})`);
    return { text: result, stats };
  } catch (err) {
    stats.primaryAttempts = MAX_RETRIES;
    const errorMsg = err instanceof Error ? err.message : String(err);
    stats.errors.push(`Primary: ${errorMsg}`);
    log("⚠️", `Primary model exhausted all ${MAX_RETRIES} retries`);
  }

  // -- Fall back to secondary model --
  log("🔀", `Falling back to: ${FALLBACK_MODEL}`);
  try {
    const { result, attempts } = await retryWithBackoff(
      () => callFallback(openaiClient, messages),
      MAX_RETRIES,
      BASE_DELAY_SECONDS,
      `Fallback (${FALLBACK_MODEL})`,
    );
    stats.fallbackAttempts = attempts;
    stats.modelUsed = FALLBACK_MODEL;
    stats.totalTimeSeconds = (performance.now() - startTime) / 1000;
    log("✅", `Fallback model responded (attempt ${attempts}/${MAX_RETRIES})`);
    return { text: result, stats };
  } catch (err) {
    stats.fallbackAttempts = MAX_RETRIES;
    const errorMsg = err instanceof Error ? err.message : String(err);
    stats.errors.push(`Fallback: ${errorMsg}`);
    stats.totalTimeSeconds = (performance.now() - startTime) / 1000;
    log("❌", "Both models failed. All retries exhausted.");
    throw new Error(
      `Both models failed after retries. Errors: ${stats.errors.join("; ")}`,
    );
  }
}

function printStats(stats: RequestStats): void {
  console.log(`  Model used: ${stats.modelUsed}`);
  console.log(`  Primary attempts: ${stats.primaryAttempts}`);
  if (stats.fallbackAttempts > 0) {
    console.log(`  Fallback attempts: ${stats.fallbackAttempts}`);
  }
  console.log(`  Total time: ${stats.totalTimeSeconds.toFixed(2)}s`);
  if (stats.errors.length > 0) {
    console.log(`  Errors encountered: ${stats.errors.length}`);
  }
}

// ---------------------------------------------------------------------------
// Chat loop
// ---------------------------------------------------------------------------

async function chatLoop(): Promise<void> {
  const anthropicClient = new Anthropic();
  const openaiClient = new OpenAI();
  const messages: Message[] = [];

  const rl = readline.createInterface({ input, output });

  console.log();
  console.log("Retry & Fallback Agent");
  console.log("=".repeat(40));
  console.log(`Primary model:  ${PRIMARY_MODEL}`);
  console.log(`Fallback model: ${FALLBACK_MODEL}`);
  console.log(
    `Max retries:    ${MAX_RETRIES} (backoff: ${BASE_DELAY_SECONDS}s, ${BASE_DELAY_SECONDS * 2}s, ${BASE_DELAY_SECONDS * 4}s)`,
  );
  if (SIMULATE_FAILURE) {
    console.log(
      "** SIMULATE FAILURE MODE: primary model will always fail **",
    );
  }
  console.log(
    "Type 'quit' or 'exit' to stop. Type 'stats' to see last request stats.",
  );
  console.log();

  let lastStats: RequestStats | null = null;

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

      if (userInput.toLowerCase() === "stats") {
        if (lastStats) {
          console.log("\nLast request stats:");
          printStats(lastStats);
          console.log();
        } else {
          console.log("\nNo requests made yet.\n");
        }
        continue;
      }

      messages.push({ role: "user", content: userInput });
      log("🤖", "Processing request...");

      try {
        const { text, stats } = await sendWithResilience(
          anthropicClient,
          openaiClient,
          messages,
          SIMULATE_FAILURE,
        );
        lastStats = stats;
        messages.push({ role: "assistant", content: text });
        console.log(`\nAssistant [${stats.modelUsed}]: ${text}\n`);
      } catch {
        console.log(
          "\nSorry, both models are unavailable right now. Please try again later.\n",
        );
        messages.pop();
      }
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
  log("🚀", "Starting retry-fallback agent...");
  await chatLoop();
  log("👋", "Goodbye!");
}

main().catch(console.error);
