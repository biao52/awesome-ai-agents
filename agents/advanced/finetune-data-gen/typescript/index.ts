/**
 * Fine-Tune Data Generator -- Generates synthetic training data for fine-tuning
 * language models on custom tasks.
 *
 * Uses Anthropic Claude to produce diverse, high-quality input/output pairs
 * in OpenAI-compatible JSONL format (messages array).
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_COUNT = 50;
const DEFAULT_OUTPUT = "training_data.jsonl";
const MAX_RETRIES = 3;
const BATCH_SIZE = 10;

const DIFFICULTY_LEVELS = ["simple", "moderate", "complex", "edge-case"];
const LENGTH_PREFERENCES = [
  "short (1-2 sentences)",
  "medium (3-5 sentences)",
  "long (1-2 paragraphs)",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface TrainingExample {
  messages: Message[];
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    console.error(
      "   Get your Anthropic key at: https://console.anthropic.com/settings/keys"
    );
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildGenerationPrompt(
  taskDescription: string,
  batchSize: number,
  difficulty: string,
  lengthPref: string,
  existingExamples: TrainingExample[]
): string {
  let existingSummary = "";
  if (existingExamples.length > 0) {
    const sampleCount = Math.min(3, existingExamples.length);
    const indices = new Set<number>();
    while (indices.size < sampleCount) {
      indices.add(Math.floor(Math.random() * existingExamples.length));
    }
    const samples = [...indices].map((i) => existingExamples[i]);

    existingSummary =
      "\n\nExamples already generated (avoid duplicates and similar patterns):\n";
    samples.forEach((ex, i) => {
      const userMsg =
        ex.messages.find((m) => m.role === "user")?.content || "";
      const truncated =
        userMsg.length > 100 ? `${userMsg.slice(0, 100)}...` : userMsg;
      existingSummary += `  ${i + 1}. "${truncated}"\n`;
    });
  }

  return `Generate exactly ${batchSize} training examples for this task:

Task: ${taskDescription}

Requirements:
- Difficulty level: ${difficulty}
- Response length preference: ${lengthPref}
- Each example must be realistic and something a real user would actually ask
- Vary the phrasing, tone, and specificity across examples
- Include edge cases and ambiguous inputs where appropriate
- The assistant responses should be high quality, accurate, and consistent
- Do NOT include any meta-commentary or explanations outside the examples
${existingSummary}
Output format: Return a JSON array where each element has this structure:
{
  "messages": [
    {"role": "system", "content": "<system prompt for the task>"},
    {"role": "user", "content": "<user input>"},
    {"role": "assistant", "content": "<ideal assistant response>"}
  ]
}

Return ONLY the JSON array, no markdown fences, no extra text. The system message
should be the same across all examples and should clearly define the task.`;
}

// ---------------------------------------------------------------------------
// Validation and deduplication
// ---------------------------------------------------------------------------

function validateExample(example: unknown): example is TrainingExample {
  if (typeof example !== "object" || example === null) return false;

  const ex = example as Record<string, unknown>;
  if (!Array.isArray(ex.messages) || ex.messages.length < 2) return false;

  const roles = ex.messages.map(
    (m: Record<string, unknown>) => m.role as string
  );
  if (!roles.includes("user") || !roles.includes("assistant")) return false;

  for (const msg of ex.messages as Record<string, unknown>[]) {
    if (typeof msg.content !== "string" || !msg.content.trim()) return false;
  }

  return true;
}

function deduplicateExamples(
  examples: TrainingExample[]
): TrainingExample[] {
  const seen = new Set<string>();
  const unique: TrainingExample[] = [];

  for (const ex of examples) {
    const userMsg =
      ex.messages
        .find((m) => m.role === "user")
        ?.content.trim()
        .toLowerCase() || "";
    if (userMsg && !seen.has(userMsg)) {
      seen.add(userMsg);
      unique.push(ex);
    }
  }

  return unique;
}

// ---------------------------------------------------------------------------
// Data generation
// ---------------------------------------------------------------------------

async function generateBatch(
  client: Anthropic,
  model: string,
  taskDescription: string,
  batchSize: number,
  difficulty: string,
  lengthPref: string,
  existingExamples: TrainingExample[]
): Promise<TrainingExample[]> {
  const prompt = buildGenerationPrompt(
    taskDescription,
    batchSize,
    difficulty,
    lengthPref,
    existingExamples
  );

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 8192,
        temperature: 0.9,
        messages: [{ role: "user", content: prompt }],
      });

      let text = "";
      for (const block of response.content) {
        if (block.type === "text") {
          text += block.text;
        }
      }

      text = text.trim();
      // Handle potential markdown fences
      if (text.startsWith("```")) {
        text = text.split("\n").slice(1).join("\n");
        if (text.endsWith("```")) {
          text = text.slice(0, -3);
        }
        text = text.trim();
      }

      const parsed: unknown = JSON.parse(text);

      if (!Array.isArray(parsed)) {
        log(
          "⚠️",
          `Expected JSON array, got ${typeof parsed}. Retrying...`
        );
        continue;
      }

      const valid = parsed.filter(validateExample) as TrainingExample[];

      if (valid.length === 0) {
        log("⚠️", "No valid examples in batch. Retrying...");
        continue;
      }

      return valid;
    } catch (e) {
      if (e instanceof SyntaxError) {
        if (attempt < MAX_RETRIES) {
          log(
            "⚠️",
            `Invalid JSON response (attempt ${attempt}/${MAX_RETRIES}). Retrying...`
          );
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        } else {
          log("❌", "Failed to parse JSON after all retries.");
          return [];
        }
      } else {
        const errorStr = String(e);
        const isTransient =
          errorStr.toLowerCase().includes("rate") ||
          errorStr.toLowerCase().includes("overloaded");

        if (attempt < MAX_RETRIES && isTransient) {
          const waitTime = Math.pow(2, attempt);
          log(
            "⏳",
            `API error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${waitTime}s...`
          );
          await new Promise((r) => setTimeout(r, waitTime * 1000));
        } else {
          throw e;
        }
      }
    }
  }

  return [];
}

async function generateTrainingData(
  taskDescription: string,
  count: number,
  model: string
): Promise<TrainingExample[]> {
  const client = new Anthropic();
  let allExamples: TrainingExample[] = [];
  let batchNum = 0;

  while (allExamples.length < count) {
    batchNum++;
    const currentBatchSize = Math.min(BATCH_SIZE, count - allExamples.length);
    const difficulty =
      DIFFICULTY_LEVELS[(batchNum - 1) % DIFFICULTY_LEVELS.length];
    const lengthPref =
      LENGTH_PREFERENCES[(batchNum - 1) % LENGTH_PREFERENCES.length];

    log(
      "🔄",
      `Batch ${batchNum}: generating ${currentBatchSize} examples ` +
        `(difficulty=${difficulty}, length=${lengthPref})`
    );

    const batch = await generateBatch(
      client,
      model,
      taskDescription,
      currentBatchSize,
      difficulty,
      lengthPref,
      allExamples
    );

    if (batch.length > 0) {
      allExamples.push(...batch);
      allExamples = deduplicateExamples(allExamples);
      log(
        "✅",
        `Got ${batch.length} examples. Total unique: ${allExamples.length}/${count}`
      );
    } else {
      log("⚠️", "Empty batch, continuing...");
    }

    // Small delay between batches to avoid rate limits
    if (allExamples.length < count) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return allExamples.slice(0, count);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function writeJsonl(examples: TrainingExample[], outputPath: string): void {
  const absPath = resolve(outputPath);
  const lines = examples.map((ex) => JSON.stringify(ex)).join("\n") + "\n";
  writeFileSync(absPath, lines, "utf-8");
  log("💾", `Wrote ${examples.length} examples to ${absPath}`);
}

function printStats(examples: TrainingExample[]): void {
  if (examples.length === 0) return;

  const totalMessages = examples.reduce(
    (sum, ex) => sum + ex.messages.length,
    0
  );
  const userLengths = examples.flatMap((ex) =>
    ex.messages.filter((m) => m.role === "user").map((m) => m.content.length)
  );
  const assistantLengths = examples.flatMap((ex) =>
    ex.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content.length)
  );

  console.log();
  log("📊", "Dataset Statistics");
  console.log("═".repeat(40));
  console.log(`  Total examples:        ${examples.length}`);
  console.log(`  Total messages:        ${totalMessages}`);
  if (userLengths.length > 0) {
    const avgUser = Math.floor(
      userLengths.reduce((a, b) => a + b, 0) / userLengths.length
    );
    console.log(`  Avg user msg length:   ${avgUser} chars`);
  }
  if (assistantLengths.length > 0) {
    const avgAssistant = Math.floor(
      assistantLengths.reduce((a, b) => a + b, 0) / assistantLengths.length
    );
    console.log(`  Avg assistant length:  ${avgAssistant} chars`);
    console.log(`  Min assistant length:  ${Math.min(...assistantLengths)} chars`);
    console.log(`  Max assistant length:  ${Math.max(...assistantLengths)} chars`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(): {
  taskDescription: string;
  count: number;
  outputPath: string;
} {
  const args = process.argv.slice(2);
  let taskDescription: string | null = null;
  let count = DEFAULT_COUNT;
  let outputPath = DEFAULT_OUTPUT;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--count" || args[i] === "-n") && i + 1 < args.length) {
      count = parseInt(args[i + 1], 10);
      if (isNaN(count) || count < 1) {
        console.error(`❌ Invalid count: ${args[i + 1]}`);
        process.exit(1);
      }
      i++;
    } else if (
      (args[i] === "--output" || args[i] === "-o") &&
      i + 1 < args.length
    ) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts <task_description> [OPTIONS]");
      console.log();
      console.log("Arguments:");
      console.log(
        "  task_description       Description of the task to generate data for"
      );
      console.log();
      console.log("Options:");
      console.log(
        `  --count, -n NUMBER     Number of examples to generate (default: ${DEFAULT_COUNT})`
      );
      console.log(
        `  --output, -o PATH      Output JSONL file path (default: ${DEFAULT_OUTPUT})`
      );
      console.log("  --help, -h             Show this help message");
      console.log();
      console.log("Examples:");
      console.log(
        '  npx tsx index.ts "Classify customer support tickets into billing/technical/general"'
      );
      console.log(
        '  npx tsx index.ts "Summarize news articles in one sentence" --count 100'
      );
      console.log(
        '  npx tsx index.ts "Translate English to French" -n 200 -o french_data.jsonl'
      );
      process.exit(0);
    } else if (taskDescription === null && !args[i].startsWith("-")) {
      taskDescription = args[i];
    } else {
      console.error(`❌ Unknown argument: ${args[i]}`);
      console.error("   Use --help for usage information.");
      process.exit(1);
    }
  }

  if (!taskDescription) {
    console.error("❌ Task description is required.");
    console.error(
      '   Usage: npx tsx index.ts "<task description>" [--count N] [--output file.jsonl]'
    );
    console.error("   Use --help for more information.");
    process.exit(1);
  }

  return { taskDescription, count, outputPath };
}

async function main(): Promise<void> {
  validateEnv();

  const { taskDescription, count, outputPath } = parseArgs();
  const model = process.env.MODEL || DEFAULT_MODEL;

  log("🚀", "Starting fine-tune data generator...");
  log("🤖", `Model: ${model}`);
  log("📋", `Task: ${taskDescription}`);
  log("🔢", `Target examples: ${count}`);
  log("📁", `Output: ${outputPath}`);
  console.log();

  try {
    const examples = await generateTrainingData(taskDescription, count, model);

    if (examples.length === 0) {
      console.error(
        "❌ No examples were generated. Try a different task description."
      );
      process.exit(1);
    }

    writeJsonl(examples, outputPath);
    printStats(examples);

    console.log();
    log("✅", `Done! Generated ${examples.length} training examples.`);
    log("💡", "To fine-tune with OpenAI, run:");
    console.log(
      `   openai api fine_tuning.jobs.create -t ${outputPath} -m gpt-4o-mini-2024-07-18`
    );
  } catch (e) {
    console.error(`\n❌ Error generating data: ${e}`);
    console.error("   Check your ANTHROPIC_API_KEY and network connection.");
    process.exit(1);
  }
}

main().catch(console.error);
