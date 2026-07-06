/**
 * Eval Runner -- Runs evaluations against multiple models and compares results.
 *
 * Takes a prompt/task and a set of test inputs, runs each input against multiple
 * models (GPT-4o-mini, Claude Haiku), scores each response using an LLM judge,
 * and outputs a comparison table with average score, latency, and cost estimates.
 *
 * Uses both OpenAI and Anthropic SDKs.
 */

import "dotenv/config";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JUDGE_MODEL = "gpt-4o-mini";

interface ModelConfig {
  id: string;
  provider: "openai" | "anthropic";
  display_name: string;
  cost_per_1k_input: number;
  cost_per_1k_output: number;
}

const MODEL_CONFIGS: ModelConfig[] = [
  {
    id: "gpt-4o-mini",
    provider: "openai",
    display_name: "GPT-4o Mini",
    cost_per_1k_input: 0.00015,
    cost_per_1k_output: 0.0006,
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    display_name: "Claude Haiku 4.5",
    cost_per_1k_input: 0.0008,
    cost_per_1k_output: 0.004,
  },
];

interface EvalInput {
  input: string;
  criteria?: string;
}

interface ModelResponse {
  output: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
}

interface EvalResult {
  input: string;
  output: string;
  score: number;
  reason: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  error: string | null;
}

const DEFAULT_EVAL_DATA: EvalInput[] = [
  {
    input: "Explain what a closure is in programming, in 2-3 sentences.",
    criteria: "Should mention: function, enclosing scope/variables, retain access. Should be concise.",
  },
  {
    input: "What are the three states of water?",
    criteria: "Must list: solid (ice), liquid (water), gas (steam/vapor). Should be clear and correct.",
  },
  {
    input: "Write a Python function that checks if a string is a palindrome.",
    criteria: "Must be valid Python. Should handle basic cases. Function should return a boolean.",
  },
  {
    input: "Summarize the concept of supply and demand in economics in one paragraph.",
    criteria: "Should cover: supply, demand, price relationship, equilibrium. Should be accurate and concise.",
  },
  {
    input: "List 5 best practices for writing secure passwords.",
    criteria: "Should include practical, accurate advice. Should list exactly 5 items.",
  },
];

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

function loadEvalData(filePath: string | null): EvalInput[] {
  if (!filePath) {
    log("📋", "Using default evaluation data (5 test cases)");
    return DEFAULT_EVAL_DATA;
  }

  if (!existsSync(filePath)) {
    console.error(`Input file not found: ${filePath}`);
    process.exit(1);
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const data = JSON.parse(content) as unknown;

    if (!Array.isArray(data)) {
      console.error("Input file must contain a JSON array.");
      process.exit(1);
    }

    for (let i = 0; i < data.length; i++) {
      const item = data[i] as Record<string, unknown>;
      if (typeof item.input !== "string") {
        console.error(`Item ${i} must have an 'input' string field.`);
        process.exit(1);
      }
    }

    log("📋", `Loaded ${data.length} evaluation inputs from ${filePath}`);
    return data as EvalInput[];
  } catch (e) {
    console.error(`Failed to load input file: ${e}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Model execution
// ---------------------------------------------------------------------------

async function runOpenAI(
  client: OpenAI,
  modelId: string,
  task: string,
  testInput: string,
): Promise<ModelResponse> {
  const start = performance.now();
  try {
    const response = await client.chat.completions.create({
      model: modelId,
      messages: [
        { role: "system", content: task },
        { role: "user", content: testInput },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    });
    const elapsed = performance.now() - start;
    const output = (response.choices[0].message.content ?? "").trim();
    const usage = response.usage;

    return {
      output,
      latency_ms: Math.round(elapsed),
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      error: null,
    };
  } catch (e) {
    const elapsed = performance.now() - start;
    return {
      output: "",
      latency_ms: Math.round(elapsed),
      input_tokens: 0,
      output_tokens: 0,
      error: String(e),
    };
  }
}

async function runAnthropic(
  client: Anthropic,
  modelId: string,
  task: string,
  testInput: string,
): Promise<ModelResponse> {
  const start = performance.now();
  try {
    const response = await client.messages.create({
      model: modelId,
      max_tokens: 1024,
      system: task,
      messages: [{ role: "user", content: testInput }],
      temperature: 0.3,
    });
    const elapsed = performance.now() - start;

    let output = "";
    for (const block of response.content) {
      if (block.type === "text") output += block.text;
    }

    return {
      output: output.trim(),
      latency_ms: Math.round(elapsed),
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      error: null,
    };
  } catch (e) {
    const elapsed = performance.now() - start;
    return {
      output: "",
      latency_ms: Math.round(elapsed),
      input_tokens: 0,
      output_tokens: 0,
      error: String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// LLM Judge
// ---------------------------------------------------------------------------

async function judgeResponse(
  client: OpenAI,
  testInput: string,
  criteria: string,
  responseText: string,
): Promise<{ score: number; reason: string }> {
  const judgePrompt = `You are a strict but fair evaluation judge. Score the response on a scale of 1-10 based on how well it addresses the input and meets the evaluation criteria.

Scoring guide:
- 9-10: Excellent. Fully addresses the input, meets all criteria, well-written.
- 7-8: Good. Addresses the input well, meets most criteria, minor issues.
- 5-6: Adequate. Partially addresses the input, misses some criteria.
- 3-4: Poor. Significant gaps, multiple criteria missed.
- 1-2: Very poor. Fails to address the input meaningfully.

Respond with ONLY a JSON object: {"score": <int 1-10>, "reason": "<brief 1-2 sentence explanation>"}`;

  const judgeInput = `Input: ${testInput}\n\nEvaluation criteria: ${criteria}\n\nResponse to evaluate:\n${responseText}`;

  try {
    const response = await client.chat.completions.create({
      model: JUDGE_MODEL,
      messages: [
        { role: "system", content: judgePrompt },
        { role: "user", content: judgeInput },
      ],
      temperature: 0,
      max_tokens: 256,
    });

    let resultText = (response.choices[0].message.content ?? "").trim();

    // Handle markdown code blocks
    if (resultText.startsWith("```")) {
      const lines = resultText.split("\n");
      resultText = lines.slice(1, -1).join("\n");
    }

    const parsed = JSON.parse(resultText) as { score: number; reason: string };
    return {
      score: Math.max(1, Math.min(10, Math.round(Number(parsed.score) || 5))),
      reason: String(parsed.reason || "No reason given"),
    };
  } catch {
    return { score: 5, reason: "Judge failed to produce valid JSON" };
  }
}

// ---------------------------------------------------------------------------
// Evaluation pipeline
// ---------------------------------------------------------------------------

async function runEvaluation(
  task: string,
  evalData: EvalInput[],
  models: ModelConfig[],
): Promise<{
  task: string;
  models: ModelConfig[];
  results: Record<string, EvalResult[]>;
  evalData: EvalInput[];
}> {
  const openaiClient = new OpenAI();
  const anthropicClient = new Anthropic();

  const results: Record<string, EvalResult[]> = {};
  for (const m of models) results[m.id] = [];

  for (let inputIdx = 0; inputIdx < evalData.length; inputIdx++) {
    const item = evalData[inputIdx];
    const testInput = item.input;
    const criteria = item.criteria ?? "Response should be accurate, clear, and complete.";

    const inputPreview = testInput.length > 80 ? testInput.slice(0, 80) + "..." : testInput;
    log("📝", `Input ${inputIdx + 1}/${evalData.length}: ${inputPreview}`);

    for (const modelConfig of models) {
      let response: ModelResponse;

      if (modelConfig.provider === "openai") {
        response = await runOpenAI(openaiClient, modelConfig.id, task, testInput);
      } else if (modelConfig.provider === "anthropic") {
        response = await runAnthropic(anthropicClient, modelConfig.id, task, testInput);
      } else {
        response = {
          output: "", latency_ms: 0, input_tokens: 0, output_tokens: 0,
          error: `Unknown provider: ${modelConfig.provider}`,
        };
      }

      let judgment: { score: number; reason: string };
      if (response.error) {
        log("❌", `  ${modelConfig.display_name}: Error - ${response.error}`);
        judgment = { score: 0, reason: `Error: ${response.error}` };
      } else {
        judgment = await judgeResponse(openaiClient, testInput, criteria, response.output);
        let outputPreview = response.output.slice(0, 60).replace(/\n/g, " ");
        if (response.output.length > 60) outputPreview += "...";
        log("  ", `  ${modelConfig.display_name}: score=${judgment.score}/10, latency=${response.latency_ms}ms -- ${outputPreview}`);
      }

      const costInput = (response.input_tokens / 1000) * modelConfig.cost_per_1k_input;
      const costOutput = (response.output_tokens / 1000) * modelConfig.cost_per_1k_output;

      results[modelConfig.id].push({
        input: testInput,
        output: response.output,
        score: judgment.score,
        reason: judgment.reason,
        latency_ms: response.latency_ms,
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
        cost: costInput + costOutput,
        error: response.error,
      });
    }

    console.log();
  }

  return { task, models, results, evalData };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

interface ModelSummary {
  display_name: string;
  avg_score: number;
  avg_latency: number;
  total_cost: number;
  error_count: number;
}

function printComparisonTable(evalResults: {
  task: string;
  models: ModelConfig[];
  results: Record<string, EvalResult[]>;
  evalData: EvalInput[];
}): void {
  const { models, results, evalData } = evalResults;

  console.log();
  console.log("=".repeat(80));
  log("📊", "Evaluation Results");
  console.log("=".repeat(80));

  // Header
  console.log();
  console.log(`${"Model".padEnd(20)} ${"Avg Score".padStart(10)} ${"Avg Latency".padStart(12)} ${"Total Cost".padStart(12)} ${"Errors".padStart(8)}`);
  console.log("-".repeat(62));

  const modelSummaries: ModelSummary[] = [];

  for (const modelConfig of models) {
    const modelResults = results[modelConfig.id];
    const validResults = modelResults.filter((r) => !r.error);
    const errorCount = modelResults.filter((r) => r.error).length;

    let avgScore = 0;
    let avgLatency = 0;
    let totalCost = 0;

    if (validResults.length > 0) {
      avgScore = validResults.reduce((sum, r) => sum + r.score, 0) / validResults.length;
      avgLatency = validResults.reduce((sum, r) => sum + r.latency_ms, 0) / validResults.length;
    }
    totalCost = modelResults.reduce((sum, r) => sum + r.cost, 0);

    modelSummaries.push({
      display_name: modelConfig.display_name,
      avg_score: avgScore,
      avg_latency: avgLatency,
      total_cost: totalCost,
      error_count: errorCount,
    });

    console.log(
      `${modelConfig.display_name.padEnd(20)} ${(avgScore.toFixed(1) + "/10").padStart(10)} ${(avgLatency.toFixed(0) + "ms").padStart(12)} ${"$" + totalCost.toFixed(6).padStart(11)} ${String(errorCount).padStart(8)}`,
    );
  }

  console.log("-".repeat(62));

  // Winners
  if (modelSummaries.length > 0) {
    const best = modelSummaries.reduce((a, b) => a.avg_score > b.avg_score ? a : b);
    const fastest = modelSummaries.reduce((a, b) => a.avg_latency < b.avg_latency ? a : b);
    const cheapest = modelSummaries.reduce((a, b) => a.total_cost < b.total_cost ? a : b);

    console.log();
    log("🏆", `Highest quality: ${best.display_name} (${best.avg_score.toFixed(1)}/10)`);
    log("🚀", `Fastest: ${fastest.display_name} (${fastest.avg_latency.toFixed(0)}ms avg)`);
    log("💰", `Cheapest: ${cheapest.display_name} ($${cheapest.total_cost.toFixed(6)})`);
  }

  // Per-input breakdown
  console.log();
  console.log("Per-Input Breakdown:");
  console.log("-".repeat(80));

  for (let inputIdx = 0; inputIdx < evalData.length; inputIdx++) {
    const item = evalData[inputIdx];
    let inputPreview = item.input.slice(0, 60);
    if (item.input.length > 60) inputPreview += "...";
    console.log(`\n  Input ${inputIdx + 1}: ${inputPreview}`);

    for (const modelConfig of models) {
      const result = results[modelConfig.id][inputIdx];

      if (result.error) {
        console.log(`    ${modelConfig.display_name.padEnd(18)} ERROR: ${result.error.slice(0, 50)}`);
      } else {
        console.log(
          `    ${modelConfig.display_name.padEnd(18)} Score: ${String(result.score).padStart(2)}/10  Latency: ${String(result.latency_ms).padStart(5)}ms  Reason: ${result.reason.slice(0, 40)}`,
        );
      }
    }
  }
}

function saveResults(
  evalResults: {
    task: string;
    models: ModelConfig[];
    results: Record<string, EvalResult[]>;
  },
  outputPath: string,
): void {
  const summary: Record<string, Record<string, unknown>> = {};

  for (const modelConfig of evalResults.models) {
    const modelResults = evalResults.results[modelConfig.id];
    const valid = modelResults.filter((r) => !r.error);

    summary[modelConfig.id] = {
      display_name: modelConfig.display_name,
      avg_score: valid.length > 0 ? valid.reduce((s, r) => s + r.score, 0) / valid.length : 0,
      avg_latency_ms: valid.length > 0 ? valid.reduce((s, r) => s + r.latency_ms, 0) / valid.length : 0,
      total_cost: modelResults.reduce((s, r) => s + r.cost, 0),
      error_count: modelResults.filter((r) => r.error).length,
    };
  }

  const serializable = {
    task: evalResults.task,
    models: evalResults.models,
    results: evalResults.results,
    summary,
  };

  writeFileSync(outputPath, JSON.stringify(serializable, null, 2), "utf-8");
  log("💾", `Full results saved to: ${outputPath}`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npx tsx index.ts [options]");
    console.log();
    console.log("Options:");
    console.log("  --task <text>      System prompt / task description for the models");
    console.log("  --inputs <path>    Path to JSON file with eval inputs [{input, criteria?}, ...]");
    console.log("  --output <path>    Path to save full results as JSON");
    console.log();
    console.log("Examples:");
    console.log('  npx tsx index.ts --task "Summarize this text"');
    console.log('  npx tsx index.ts --task "Answer the question" --inputs eval_data.json');
    console.log("  npx tsx index.ts  # Uses default task and test cases");
    process.exit(0);
  }

  let task = "You are a helpful assistant. Answer the question or complete the task clearly and concisely.";
  let inputsFile: string | null = null;
  let outputFile: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--task" && i + 1 < args.length) {
      task = args[++i];
    } else if (args[i] === "--inputs" && i + 1 < args.length) {
      inputsFile = args[++i];
    } else if (args[i] === "--output" && i + 1 < args.length) {
      outputFile = args[++i];
    }
  }

  const evalData = loadEvalData(inputsFile);

  log("🚀", "Starting Eval Runner...");
  log("🤖", `Models: ${MODEL_CONFIGS.map((m) => m.display_name).join(", ")}`);
  log("🧑\u200d⚖️", `Judge: ${JUDGE_MODEL}`);
  const taskPreview = task.length > 80 ? task.slice(0, 80) + "..." : task;
  log("📝", `Task: ${taskPreview}`);
  log("🧪", `Inputs: ${evalData.length}`);
  console.log();

  try {
    const evalResults = await runEvaluation(task, evalData, MODEL_CONFIGS);
    printComparisonTable(evalResults);

    if (outputFile) {
      saveResults(evalResults, outputFile);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("interrupt")) {
      console.log("\nCancelled.");
      process.exit(0);
    }
    console.error(`\nError: ${e}`);
    process.exit(1);
  }

  console.log();
  log("✅", "Done!");
}

main().catch(console.error);
