/**
 * Cron Translator Agent -- Converts between natural language and cron expressions.
 * Auto-detects the input format and translates in the appropriate direction.
 *
 * Uses OpenAI GPT-4o-mini for translation.
 */

import "dotenv/config";
import OpenAI from "openai";
import { createInterface } from "node:readline/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_RETRIES = 3;

const CRON_FIELDS = [
  "minute",
  "hour",
  "day of month",
  "month",
  "day of week",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CronResult {
  cron?: string;
  description?: string;
  explanation: string;
  fields: {
    minute: string;
    hour: string;
    day_of_month: string;
    month: string;
    day_of_week: string;
  };
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["OPENAI_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    console.error(
      "   Get your OpenAI key at: https://platform.openai.com/api-keys"
    );
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Input detection
// ---------------------------------------------------------------------------

function isCronExpression(text: string): boolean {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return false;

  const cronFieldPattern = /^[\d*,/\-LW#?]+$/;
  return parts.every((part) => cronFieldPattern.test(part));
}

// ---------------------------------------------------------------------------
// Next run time calculation
// ---------------------------------------------------------------------------

function parseCronField(
  field: string,
  minVal: number,
  maxVal: number
): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    let base = part;
    let step = 1;

    if (base.includes("/")) {
      const [b, s] = base.split("/");
      base = b;
      const parsed = parseInt(s, 10);
      if (isNaN(parsed)) return Array.from({ length: maxVal - minVal + 1 }, (_, i) => minVal + i);
      step = parsed;
    }

    if (base === "*") {
      for (let v = minVal; v <= maxVal; v += step) values.add(v);
    } else if (base.includes("-")) {
      const [startStr, endStr] = base.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) {
        return Array.from({ length: maxVal - minVal + 1 }, (_, i) => minVal + i);
      }
      for (let v = start; v <= end; v += step) values.add(v);
    } else {
      const v = parseInt(base, 10);
      if (!isNaN(v)) values.add(v);
    }
  }

  return [...values].sort((a, b) => a - b);
}

function calculateNextRuns(cronExpr: string, count: number = 5): string[] {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return ["(Could not parse cron expression)"];

  let minutes: number[];
  let hours: number[];
  let daysOfMonth: number[];
  let months: number[];
  let daysOfWeek: number[];

  try {
    minutes = parseCronField(parts[0], 0, 59);
    hours = parseCronField(parts[1], 0, 23);
    daysOfMonth = parseCronField(parts[2], 1, 31);
    months = parseCronField(parts[3], 1, 12);
    daysOfWeek = parseCronField(parts[4], 0, 6);
  } catch {
    return ["(Could not parse cron expression)"];
  }

  const dowRestricted = parts[4] !== "*";
  const domRestricted = parts[2] !== "*";

  const now = new Date();
  now.setSeconds(0, 0);
  const current = new Date(now.getTime() + 60_000);
  const results: string[] = [];
  const maxIterations = 525_600;

  for (let iter = 0; iter < maxIterations && results.length < count; iter++) {
    const month = current.getMonth() + 1; // JS months are 0-indexed
    if (!months.includes(month)) {
      current.setMonth(current.getMonth() + 1, 1);
      current.setHours(0, 0, 0, 0);
      continue;
    }

    const day = current.getDate();
    // JS: Sunday=0..Saturday=6 -- same as cron
    const dow = current.getDay();

    let dayMatch = true;
    if (domRestricted && dowRestricted) {
      dayMatch = daysOfMonth.includes(day) || daysOfWeek.includes(dow);
    } else if (domRestricted) {
      dayMatch = daysOfMonth.includes(day);
    } else if (dowRestricted) {
      dayMatch = daysOfWeek.includes(dow);
    }

    if (!dayMatch) {
      current.setDate(current.getDate() + 1);
      current.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = current.getHours();
    if (!hours.includes(hour)) {
      current.setHours(current.getHours() + 1, 0, 0, 0);
      continue;
    }

    const minute = current.getMinutes();
    if (!minutes.includes(minute)) {
      current.setMinutes(current.getMinutes() + 1, 0, 0);
      continue;
    }

    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const dateStr = current.toISOString().slice(0, 10);
    const timeStr = `${String(current.getHours()).padStart(2, "0")}:${String(current.getMinutes()).padStart(2, "0")}`;
    results.push(`${dateStr} ${timeStr} (${dayNames[current.getDay()]})`);

    current.setMinutes(current.getMinutes() + 1, 0, 0);
  }

  return results.length > 0
    ? results
    : ["(No runs found in the next year)"];
}

// ---------------------------------------------------------------------------
// Translation via OpenAI
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_TO_CRON = `You are an expert at writing cron expressions. Given a natural language description of a schedule, generate the corresponding 5-field cron expression.

You MUST respond with valid JSON in this exact format:
{
  "cron": "the 5-field cron expression",
  "explanation": "a human-readable explanation of what the cron expression does, field by field",
  "fields": {
    "minute": "explanation of the minute field value",
    "hour": "explanation of the hour field value",
    "day_of_month": "explanation of the day-of-month field value",
    "month": "explanation of the month field value",
    "day_of_week": "explanation of the day-of-week field value"
  }
}

Rules:
- Use standard 5-field cron format: minute hour day-of-month month day-of-week
- Day of week: 0=Sunday, 1=Monday, ..., 6=Saturday
- Use * for "every", */N for "every Nth", ranges (1-5), lists (1,3,5)
- Assume UTC unless the user specifies a timezone
- Be precise: "every weekday at 9am" means "0 9 * * 1-5", not "0 9 * * *"
- Output ONLY the JSON object`;

const SYSTEM_PROMPT_TO_ENGLISH = `You are an expert at reading cron expressions. Given a 5-field cron expression, explain what it does in clear, natural language.

You MUST respond with valid JSON in this exact format:
{
  "description": "a clear, natural language description of when this cron job runs",
  "explanation": "a detailed field-by-field breakdown of the cron expression",
  "fields": {
    "minute": "explanation of the minute field value",
    "hour": "explanation of the hour field value",
    "day_of_month": "explanation of the day-of-month field value",
    "month": "explanation of the month field value",
    "day_of_week": "explanation of the day-of-week field value"
  }
}

Rules:
- Describe the schedule in plain English that anyone can understand
- Include frequency: how often it runs (every minute, hourly, daily, weekly, etc.)
- Be specific about times, days, and any constraints
- Mention edge cases or notable behaviors
- Output ONLY the JSON object`;

async function translate(
  inputText: string,
  isCron: boolean,
  model: string
): Promise<CronResult> {
  const client = new OpenAI();

  const systemPrompt = isCron
    ? SYSTEM_PROMPT_TO_ENGLISH
    : SYSTEM_PROMPT_TO_CRON;
  const userMessage = isCron
    ? `Explain this cron expression: ${inputText}`
    : `Convert this schedule to a cron expression: ${inputText}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 1024,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from API");

      return JSON.parse(content) as CronResult;
    } catch (e) {
      const errorStr = String(e);
      const isTransient =
        errorStr.toLowerCase().includes("rate") ||
        errorStr.toLowerCase().includes("overloaded") ||
        errorStr.includes("529") ||
        errorStr.includes("500");

      if (attempt < MAX_RETRIES && (isTransient || e instanceof SyntaxError)) {
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

  throw new Error("Unreachable: max retries exceeded");
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function displayCronResult(result: CronResult, cronExpr: string): void {
  console.log();
  console.log("=".repeat(60));
  log("🎯", "Generated Cron Expression");
  console.log("=".repeat(60));
  console.log();
  console.log(`  Cron:  ${cronExpr}`);
  console.log();

  const fields = result.fields;
  if (fields) {
    const parts = cronExpr.split(/\s+/);
    const fieldKeys = [
      "minute",
      "hour",
      "day_of_month",
      "month",
      "day_of_week",
    ] as const;
    console.log("  Field breakdown:");
    for (let i = 0; i < CRON_FIELDS.length; i++) {
      const value = parts[i] || "";
      const name = CRON_FIELDS[i];
      const desc = fields[fieldKeys[i]] || "";
      console.log(
        `    ${value.padStart(10)}  ${name.padEnd(15)}  ${desc}`
      );
    }
    console.log();
  }

  if (result.explanation) {
    console.log("-".repeat(60));
    log("📖", "Explanation");
    console.log("-".repeat(60));
    console.log();
    for (const line of result.explanation.split("\n")) {
      console.log(`  ${line}`);
    }
    console.log();
  }

  console.log("-".repeat(60));
  log("⏰", "Next 5 Run Times");
  console.log("-".repeat(60));
  console.log();
  const nextRuns = calculateNextRuns(cronExpr);
  nextRuns.forEach((run, i) => console.log(`  ${i + 1}. ${run}`));
  console.log();

  console.log("-".repeat(60));
  log("💻", "Usage");
  console.log("-".repeat(60));
  console.log();
  console.log(`  crontab:         ${cronExpr} /path/to/command`);
  console.log(`  GitHub Actions:  cron: '${cronExpr}'`);
  console.log();
  console.log("=".repeat(60));
}

function displayEnglishResult(result: CronResult, cronExpr: string): void {
  console.log();
  console.log("=".repeat(60));
  log("🎯", "Cron Expression Explained");
  console.log("=".repeat(60));
  console.log();
  console.log(`  Cron:     ${cronExpr}`);
  console.log(`  Meaning:  ${result.description || "N/A"}`);
  console.log();

  const fields = result.fields;
  if (fields) {
    const parts = cronExpr.split(/\s+/);
    const fieldKeys = [
      "minute",
      "hour",
      "day_of_month",
      "month",
      "day_of_week",
    ] as const;
    console.log("  Field breakdown:");
    for (let i = 0; i < CRON_FIELDS.length; i++) {
      const value = parts[i] || "";
      const name = CRON_FIELDS[i];
      const desc = fields[fieldKeys[i]] || "";
      console.log(
        `    ${value.padStart(10)}  ${name.padEnd(15)}  ${desc}`
      );
    }
    console.log();
  }

  if (result.explanation) {
    console.log("-".repeat(60));
    log("📖", "Detailed Explanation");
    console.log("-".repeat(60));
    console.log();
    for (const line of result.explanation.split("\n")) {
      console.log(`  ${line}`);
    }
    console.log();
  }

  console.log("-".repeat(60));
  log("⏰", "Next 5 Run Times");
  console.log("-".repeat(60));
  console.log();
  const nextRuns = calculateNextRuns(cronExpr);
  nextRuns.forEach((run, i) => console.log(`  ${i + 1}. ${run}`));
  console.log();
  console.log("=".repeat(60));
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let inputText: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [INPUT]");
      console.log();
      console.log(
        "Translates between natural language and cron expressions."
      );
      console.log("Auto-detects the direction based on input format.");
      console.log();
      console.log("Arguments:");
      console.log(
        "  INPUT    Natural language schedule or cron expression"
      );
      console.log();
      console.log("Examples:");
      console.log('  npx tsx index.ts "Every weekday at 9am"');
      console.log('  npx tsx index.ts "Every 15 minutes"');
      console.log(
        '  npx tsx index.ts "First Monday of every month at noon"'
      );
      console.log('  npx tsx index.ts "0 9 * * 1-5"');
      console.log('  npx tsx index.ts "*/15 * * * *"');
      console.log('  npx tsx index.ts "0 0 1 * *"');
      console.log();
      console.log(
        "If no input is given, you'll be prompted interactively."
      );
      process.exit(0);
    } else if (!inputText && !args[i].startsWith("--")) {
      inputText = args[i];
    } else {
      console.error(`❌ Unknown argument: ${args[i]}`);
      console.error("   Use --help for usage information.");
      process.exit(1);
    }
  }

  log("🚀", "Starting cron translator agent...");
  log("🤖", `Model: ${model}`);
  console.log();

  // Get input interactively if not provided
  if (!inputText) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      inputText = (
        await rl.question("📝 Enter a schedule or cron expression: ")
      ).trim();

      if (!inputText) {
        console.error("❌ No input provided.");
        process.exit(1);
      }
    } catch {
      console.log("\n❌ Cancelled.");
      process.exit(0);
    } finally {
      rl.close();
    }
  }

  // Detect direction
  const isCron = isCronExpression(inputText);

  if (isCron) {
    log("🔄", `Detected cron expression: ${inputText}`);
    log("🔍", "Translating to natural language...");
  } else {
    log("🔄", `Detected natural language: ${inputText}`);
    log("🔍", "Generating cron expression...");
  }

  // Translate
  let result: CronResult;
  try {
    result = await translate(inputText, isCron, model);
  } catch (e) {
    console.error(`\n❌ Error during translation: ${e}`);
    console.error("   Check your OPENAI_API_KEY and network connection.");
    process.exit(1);
  }

  // Display results
  if (isCron) {
    displayEnglishResult(result, inputText);
  } else {
    const cronExpr = result.cron;
    if (!cronExpr) {
      console.error("❌ The model did not return a cron expression.");
      process.exit(1);
    }
    displayCronResult(result, cronExpr);
  }

  log("✅", "Done!");
}

main().catch(console.error);
