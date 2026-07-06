/**
 * Prompt Optimizer -- Iteratively improves a prompt based on test cases.
 *
 * Takes an initial prompt and a set of test cases (input/expected output pairs),
 * runs the prompt against each test case, scores results using an LLM judge,
 * analyzes failures, and generates an improved prompt. Repeats until the score
 * threshold is met or max rounds are reached.
 *
 * Uses OpenAI GPT-4o-mini for both execution and judging.
 */

import "dotenv/config";
import OpenAI from "openai";
import { readFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_ROUNDS = 5;
const SCORE_THRESHOLD = 0.9;

interface TestCase {
  input: string;
  expected: string;
}

interface TestResult {
  input: string;
  expected: string;
  actual: string;
  score: number;
  reason: string;
}

interface RoundResult {
  round: number;
  prompt: string;
  avg_score: number;
  pass_count: number;
  total_count: number;
  results: TestResult[];
}

interface OptimizationResult {
  final_prompt: string;
  score_history: RoundResult[];
  total_rounds: number;
}

const DEFAULT_TEST_CASES: TestCase[] = [
  { input: "I love this product! Best purchase ever.", expected: "positive" },
  { input: "Terrible quality. Broke after one day.", expected: "negative" },
  { input: "It's okay, nothing special.", expected: "neutral" },
  { input: "Absolutely fantastic, exceeded all expectations!", expected: "positive" },
  { input: "Worst customer service I've ever experienced.", expected: "negative" },
  { input: "The product arrived on time and works as described.", expected: "neutral" },
  { input: "Not worth the money. Very disappointed.", expected: "negative" },
  { input: "Five stars! Will buy again.", expected: "positive" },
];

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["OPENAI_API_KEY"];
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
// Test case loading
// ---------------------------------------------------------------------------

function loadTestCases(filePath: string | null): TestCase[] {
  if (!filePath) {
    log("📋", "Using default test cases (sentiment classification)");
    return DEFAULT_TEST_CASES;
  }

  if (!existsSync(filePath)) {
    console.error(`Test cases file not found: ${filePath}`);
    process.exit(1);
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const cases = JSON.parse(content) as unknown;

    if (!Array.isArray(cases)) {
      console.error("Test cases file must contain a JSON array.");
      process.exit(1);
    }

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i] as Record<string, unknown>;
      if (typeof c.input !== "string" || typeof c.expected !== "string") {
        console.error(`Test case ${i} must have 'input' and 'expected' string fields.`);
        process.exit(1);
      }
    }

    log("📋", `Loaded ${cases.length} test cases from ${filePath}`);
    return cases as TestCase[];
  } catch (e) {
    console.error(`Failed to load test cases: ${e}`);
    process.exit(1);
  }
}

function loadPrompt(promptArg: string | null, promptFile: string | null): string {
  if (promptArg) return promptArg;

  if (promptFile) {
    if (!existsSync(promptFile)) {
      console.error(`Prompt file not found: ${promptFile}`);
      process.exit(1);
    }
    return readFileSync(promptFile, "utf-8").trim();
  }

  return "Classify the sentiment of the following text as positive, negative, or neutral. Respond with only one word.";
}

// ---------------------------------------------------------------------------
// LLM execution
// ---------------------------------------------------------------------------

async function runPrompt(
  client: OpenAI,
  model: string,
  prompt: string,
  testInput: string,
): Promise<string> {
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: testInput },
      ],
      temperature: 0,
      max_tokens: 256,
    });
    return (response.choices[0].message.content ?? "").trim();
  } catch (e) {
    return `[ERROR: ${e}]`;
  }
}

async function judgeResult(
  client: OpenAI,
  model: string,
  testInput: string,
  expected: string,
  actual: string,
): Promise<{ score: number; reason: string }> {
  const judgePrompt = `You are a strict evaluation judge. Score how well the actual output matches the expected output.

Consider:
1. Exact match: If the actual output exactly matches the expected, score 1.0
2. Semantic match: If the meaning is equivalent but wording differs, score 0.8-0.9
3. Partial match: If the output is partially correct, score 0.3-0.7
4. Wrong: If the output is incorrect, score 0.0-0.2

Respond with ONLY a JSON object: {"score": <float 0-1>, "reason": "<brief explanation>"}`;

  const judgeInput = `Input: ${testInput}\nExpected output: ${expected}\nActual output: ${actual}`;

  try {
    const response = await client.chat.completions.create({
      model,
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
      score: Number(parsed.score) || 0,
      reason: String(parsed.reason || "No reason given"),
    };
  } catch {
    // Fallback: exact match
    const isMatch = expected.toLowerCase().trim() === actual.toLowerCase().trim();
    return {
      score: isMatch ? 1.0 : 0.0,
      reason: isMatch ? "Exact match" : "No match (judge parsing failed)",
    };
  }
}

// ---------------------------------------------------------------------------
// Prompt improvement
// ---------------------------------------------------------------------------

async function generateImprovedPrompt(
  client: OpenAI,
  model: string,
  currentPrompt: string,
  testResults: TestResult[],
  roundNum: number,
): Promise<string> {
  const failures = testResults.filter((r) => r.score < 0.8);
  const successes = testResults.filter((r) => r.score >= 0.8);

  const analysisPrompt = `You are a prompt engineering expert. Analyze the test results below and generate an improved version of the prompt.

Rules:
- Focus on fixing the failures while keeping the successes working
- Be specific and explicit in your instructions
- Add examples if the current prompt lacks them
- Clarify edge cases that caused failures
- Keep the prompt concise -- don't add unnecessary verbosity
- Return ONLY the improved prompt text, nothing else (no quotes, no explanation, no markdown)`;

  const avgScore = testResults.reduce((sum, r) => sum + r.score, 0) / testResults.length;

  let resultsText = `## Current Prompt (Round ${roundNum})
${currentPrompt}

## Results
Average score: ${(avgScore * 100).toFixed(1)}%
Successes: ${successes.length}/${testResults.length}
Failures: ${failures.length}/${testResults.length}

## Failure Details`;

  for (const r of failures) {
    resultsText += `\n- Input: ${r.input}\n  Expected: ${r.expected}\n  Actual: ${r.actual}\n  Score: ${r.score.toFixed(2)}\n  Reason: ${r.reason}`;
  }

  resultsText += "\n\n## Success Examples";
  for (const r of successes.slice(0, 3)) {
    resultsText += `\n- Input: ${r.input}\n  Expected: ${r.expected}\n  Actual: ${r.actual}`;
  }

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: analysisPrompt },
        { role: "user", content: resultsText },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    });

    let improved = (response.choices[0].message.content ?? "").trim();
    if (improved.startsWith('"') && improved.endsWith('"')) {
      improved = improved.slice(1, -1);
    }
    return improved;
  } catch (e) {
    log("⚠️", `Failed to generate improved prompt: ${e}`);
    return currentPrompt;
  }
}

// ---------------------------------------------------------------------------
// Optimization loop
// ---------------------------------------------------------------------------

async function runOptimization(
  initialPrompt: string,
  testCases: TestCase[],
  model: string,
  maxRounds: number,
  threshold: number,
): Promise<OptimizationResult> {
  const client = new OpenAI();
  let currentPrompt = initialPrompt;
  const scoreHistory: RoundResult[] = [];

  for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
    log("🔄", `Round ${roundNum}/${maxRounds}`);
    const promptPreview = currentPrompt.length > 100
      ? currentPrompt.slice(0, 100) + "..."
      : currentPrompt;
    log("📝", `Current prompt: ${promptPreview}`);
    console.log();

    // Run prompt against all test cases
    const testResults: TestResult[] = [];

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      const actual = await runPrompt(client, model, currentPrompt, tc.input);
      const judgment = await judgeResult(client, model, tc.input, tc.expected, actual);

      testResults.push({
        input: tc.input,
        expected: tc.expected,
        actual,
        score: judgment.score,
        reason: judgment.reason,
      });

      const status = judgment.score >= 0.8 ? "pass" : "FAIL";
      const icon = status === "pass" ? "✅" : "❌";
      const expectedPad = tc.expected.padEnd(10);
      const actualPad = actual.padEnd(20);
      console.log(`   ${icon} [${i + 1}/${testCases.length}] Expected: ${expectedPad} | Got: ${actualPad} | Score: ${judgment.score.toFixed(2)}`);
    }

    // Calculate average score
    const avgScore = testResults.reduce((sum, r) => sum + r.score, 0) / testResults.length;
    const passCount = testResults.filter((r) => r.score >= 0.8).length;

    scoreHistory.push({
      round: roundNum,
      prompt: currentPrompt,
      avg_score: avgScore,
      pass_count: passCount,
      total_count: testCases.length,
      results: testResults,
    });

    console.log();
    log("📊", `Round ${roundNum} score: ${(avgScore * 100).toFixed(1)}% (${passCount}/${testCases.length} passed)`);

    // Check threshold
    if (avgScore >= threshold) {
      log("🎯", `Score threshold met (${(avgScore * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(1)}%). Stopping.`);
      break;
    }

    // Check last round
    if (roundNum === maxRounds) {
      log("⏰", `Max rounds reached (${maxRounds}).`);
      break;
    }

    // Generate improved prompt
    log("🧠", "Analyzing failures and generating improved prompt...");
    const improvedPrompt = await generateImprovedPrompt(
      client, model, currentPrompt, testResults, roundNum,
    );

    if (improvedPrompt === currentPrompt) {
      log("⚠️", "Prompt unchanged. Stopping early.");
      break;
    }

    currentPrompt = improvedPrompt;
    console.log();
  }

  return {
    final_prompt: currentPrompt,
    score_history: scoreHistory,
    total_rounds: scoreHistory.length,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printResults(results: OptimizationResult): void {
  console.log();
  console.log("=".repeat(60));
  log("📊", "Optimization Results");
  console.log("=".repeat(60));

  // Score history
  console.log();
  console.log("Score History:");
  for (const entry of results.score_history) {
    const barLen = Math.round(entry.avg_score * 30);
    const bar = "#".repeat(barLen) + "-".repeat(30 - barLen);
    console.log(`  Round ${entry.round}: [${bar}] ${(entry.avg_score * 100).toFixed(1)}% (${entry.pass_count}/${entry.total_count})`);
  }

  // Improvement
  const firstScore = results.score_history[0].avg_score;
  const lastScore = results.score_history[results.score_history.length - 1].avg_score;
  const improvement = lastScore - firstScore;

  console.log();
  if (improvement > 0) {
    log("📈", `Improvement: ${(firstScore * 100).toFixed(1)}% --> ${(lastScore * 100).toFixed(1)}% (+${(improvement * 100).toFixed(1)}%)`);
  } else if (improvement === 0) {
    log("➡️", `No change: ${(firstScore * 100).toFixed(1)}%`);
  } else {
    log("📉", `Regression: ${(firstScore * 100).toFixed(1)}% --> ${(lastScore * 100).toFixed(1)}% (${(improvement * 100).toFixed(1)}%)`);
  }

  // Final prompt
  console.log();
  console.log("Final Optimized Prompt:");
  console.log("-".repeat(40));
  console.log(results.final_prompt);
  console.log("-".repeat(40));
  console.log();
  log("💡", `Total rounds: ${results.total_rounds}`);
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
    console.log('  --prompt <text>        Initial prompt text (inline)');
    console.log("  --prompt-file <path>   Path to a file containing the initial prompt");
    console.log("  --tests <path>         Path to JSON file with test cases [{input, expected}, ...]");
    console.log(`  --rounds <n>           Maximum optimization rounds (default: ${MAX_ROUNDS})`);
    console.log(`  --threshold <n>        Score threshold to stop early, 0-1 (default: ${SCORE_THRESHOLD})`);
    console.log();
    console.log("Examples:");
    console.log('  npx tsx index.ts --prompt "Classify sentiment" --tests test_cases.json');
    console.log("  npx tsx index.ts --prompt-file my_prompt.txt --tests cases.json");
    console.log("  npx tsx index.ts  # Uses default sentiment classification task");
    process.exit(0);
  }

  // Parse arguments
  let promptArg: string | null = null;
  let promptFile: string | null = null;
  let testsFile: string | null = null;
  let maxRounds = MAX_ROUNDS;
  let threshold = SCORE_THRESHOLD;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prompt" && i + 1 < args.length) {
      promptArg = args[++i];
    } else if (args[i] === "--prompt-file" && i + 1 < args.length) {
      promptFile = args[++i];
    } else if (args[i] === "--tests" && i + 1 < args.length) {
      testsFile = args[++i];
    } else if (args[i] === "--rounds" && i + 1 < args.length) {
      maxRounds = parseInt(args[++i], 10);
    } else if (args[i] === "--threshold" && i + 1 < args.length) {
      threshold = parseFloat(args[++i]);
    }
  }

  const model = process.env.MODEL || DEFAULT_MODEL;
  const initialPrompt = loadPrompt(promptArg, promptFile);
  const testCases = loadTestCases(testsFile);

  log("🚀", "Starting Prompt Optimizer...");
  log("🤖", `Model: ${model}`);
  const promptPreview = initialPrompt.length > 80
    ? initialPrompt.slice(0, 80) + "..."
    : initialPrompt;
  log("📝", `Initial prompt: ${promptPreview}`);
  log("🧪", `Test cases: ${testCases.length}`);
  log("🔄", `Max rounds: ${maxRounds}`);
  log("🎯", `Score threshold: ${(threshold * 100).toFixed(0)}%`);
  console.log();

  try {
    const results = await runOptimization(initialPrompt, testCases, model, maxRounds, threshold);
    printResults(results);
  } catch (e) {
    if (e instanceof Error && e.message.includes("interrupt")) {
      console.log("\nCancelled.");
      process.exit(0);
    }
    console.error(`\nError: ${e}`);
    process.exit(1);
  }

  log("✅", "Done!");
}

main().catch(console.error);
