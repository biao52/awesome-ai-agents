/**
 * Log Analyzer Agent -- Analyzes log files to find anomalies, patterns,
 * and root causes using Claude for intelligent analysis.
 *
 * Reads logs from a file or stdin, pre-processes them to extract statistics,
 * then sends a structured summary to Claude for deep analysis.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_LINES_THRESHOLD = 1000;
const SAMPLE_HEAD = 500;
const SAMPLE_TAIL = 500;
const MAX_RETRIES = 3;

const LOG_LEVEL_PATTERN =
  /\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|CRITICAL|NOTICE)\b/i;

const TIMESTAMP_PATTERNS = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/,
  /[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/,
  /\b1[6-9]\d{8}\b/,
];

const ERROR_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /out of memory|OOM|oom.killer/i, label: "Out of Memory" },
  { pattern: /connection refused|ECONNREFUSED|ETIMEDOUT/i, label: "Connection Error" },
  { pattern: /segmentation fault|SIGSEGV|core dump/i, label: "Segfault/Crash" },
  { pattern: /permission denied|EACCES|403/i, label: "Permission Denied" },
  { pattern: /disk full|no space left|ENOSPC/i, label: "Disk Full" },
  { pattern: /timeout|timed out|deadline exceeded/i, label: "Timeout" },
  { pattern: /null pointer|NullPointerException|TypeError.*null/i, label: "Null Reference" },
  { pattern: /stack overflow|maximum call stack/i, label: "Stack Overflow" },
];

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY"];
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
// Log reading
// ---------------------------------------------------------------------------

function readLogFile(filePath: string): string[] {
  if (!existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }
  try {
    return readFileSync(filePath, "utf-8").split("\n");
  } catch {
    console.error(`❌ Failed to read file: ${filePath}`);
    process.exit(1);
  }
}

async function readStdin(): Promise<string[]> {
  if (process.stdin.isTTY) return [];

  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += String(chunk);
    });
    process.stdin.on("end", () => {
      resolve(data.split("\n"));
    });
    process.stdin.resume();
  });
}

// ---------------------------------------------------------------------------
// Log pre-processing
// ---------------------------------------------------------------------------

function detectTimestampFormat(lines: string[]): string | null {
  const sample = lines.slice(0, 50);
  for (const pattern of TIMESTAMP_PATTERNS) {
    const matches = sample.filter((line) => pattern.test(line)).length;
    if (matches > sample.length * 0.3) {
      return pattern.source;
    }
  }
  return null;
}

function extractLogLevels(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const match = line.match(LOG_LEVEL_PATTERN);
    if (match) {
      let level = match[1].toUpperCase();
      if (level === "WARNING") level = "WARN";
      counts.set(level, (counts.get(level) || 0) + 1);
    }
  }
  return counts;
}

function findErrorLines(lines: string[]): Array<{ lineNum: number; text: string }> {
  const errors: Array<{ lineNum: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(LOG_LEVEL_PATTERN);
    if (match && ["ERROR", "FATAL", "CRITICAL"].includes(match[1].toUpperCase())) {
      errors.push({ lineNum: i + 1, text: lines[i].trimEnd() });
    }
  }
  return errors;
}

function findKnownPatterns(lines: string[]): Array<{ label: string; count: number }> {
  const results: Array<{ label: string; count: number }> = [];
  for (const { pattern, label } of ERROR_PATTERNS) {
    const count = lines.filter((line) => pattern.test(line)).length;
    if (count > 0) {
      results.push({ label, count });
    }
  }
  return results;
}

function findRepeatedMessages(
  lines: string[],
  threshold = 5
): Array<{ message: string; count: number }> {
  const counts = new Map<string, number>();

  for (const line of lines) {
    let cleaned = line.replace(LOG_LEVEL_PATTERN, "");
    for (const pattern of TIMESTAMP_PATTERNS) {
      cleaned = cleaned.replace(pattern, "");
    }
    cleaned = cleaned.replace(/\d+/g, "N").replace(/\s+/g, " ").trim();
    if (cleaned.length > 10) {
      counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([message, count]) => ({ message, count }));
}

function sampleLines(lines: string[]): { text: string; description: string } {
  const total = lines.length;

  if (total <= MAX_LINES_THRESHOLD) {
    return { text: lines.join("\n"), description: `Full log (${total} lines)` };
  }

  const head = lines.slice(0, SAMPLE_HEAD);
  const tail = lines.slice(-SAMPLE_TAIL);

  const errorLines = findErrorLines(lines);
  const middleErrors = errorLines
    .filter((e) => e.lineNum > SAMPLE_HEAD && e.lineNum <= total - SAMPLE_TAIL)
    .slice(0, 200);

  const parts: string[] = [
    `=== FIRST ${SAMPLE_HEAD} LINES ===\n`,
    head.join("\n"),
    `\n=== ... (${total - SAMPLE_HEAD - SAMPLE_TAIL} lines omitted) ===\n`,
  ];

  if (middleErrors.length > 0) {
    parts.push(`\n=== ERROR LINES FROM OMITTED SECTION (${middleErrors.length} lines) ===\n`);
    for (const err of middleErrors) {
      parts.push(err.text + "\n");
    }
  }

  parts.push(`\n=== LAST ${SAMPLE_TAIL} LINES ===\n`);
  parts.push(tail.join("\n"));

  const description =
    `Sampled: first ${SAMPLE_HEAD} + last ${SAMPLE_TAIL} lines` +
    ` + ${middleErrors.length} error lines from middle` +
    ` (total: ${total} lines)`;

  return { text: parts.join(""), description };
}

function buildPreAnalysis(lines: string[]): string {
  const sections: string[] = [];
  const total = lines.length;

  sections.push(`Total lines: ${total}`);

  const tsFormat = detectTimestampFormat(lines);
  sections.push(
    tsFormat
      ? `Timestamp format detected: ${tsFormat}`
      : "No consistent timestamp format detected"
  );

  const levelCounts = extractLogLevels(lines);
  if (levelCounts.size > 0) {
    sections.push("Log level distribution:");
    const sorted = [...levelCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [level, count] of sorted) {
      const pct = ((count / total) * 100).toFixed(1);
      sections.push(`  ${level}: ${count} (${pct}%)`);
    }
  }

  const errorLines = findErrorLines(lines);
  sections.push(`Error/Fatal/Critical lines: ${errorLines.length}`);

  const known = findKnownPatterns(lines);
  if (known.length > 0) {
    sections.push("Known error patterns detected:");
    for (const { label, count } of known) {
      sections.push(`  ${label}: ${count} occurrences`);
    }
  }

  const repeated = findRepeatedMessages(lines);
  if (repeated.length > 0) {
    sections.push("Frequently repeated messages (possible log storms):");
    for (const { message, count } of repeated) {
      sections.push(`  [${count}x] ${message.slice(0, 120)}`);
    }
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert site reliability engineer analyzing application logs. You have deep experience with production systems, distributed architectures, and incident response.

Analyze the provided log data and pre-computed statistics. Produce a structured analysis report.

Your report must follow this exact format:

## Log Analysis Summary
[2-3 sentences describing what these logs show and the overall health]

## Error Frequency
[Table or list of error types, their frequency, and when they started/stopped]

## Anomalies Detected
[List unusual patterns: sudden spikes, new error types, unusual timing, log gaps]
- Each anomaly with evidence (specific log lines or timestamps)

## Root Cause Analysis
[For each major error cluster, provide:]
- **Symptom:** What the logs show
- **Likely cause:** What probably triggered it
- **Evidence:** Specific log lines supporting this theory
- **Confidence:** High/Medium/Low

## Timeline
[Chronological sequence of events if timestamps are available]
1. [timestamp] Event description
2. [timestamp] Event description

## Recommended Actions
[Prioritized list of what to do next]
1. **Immediate:** Actions to take right now
2. **Short-term:** Actions for the next few hours/days
3. **Long-term:** Systemic improvements to prevent recurrence

## Additional Notes
[Anything else noteworthy: log quality issues, missing context, suggested monitoring]

Rules:
- Be specific. Reference exact log lines and timestamps when possible.
- Distinguish between symptoms and causes. Errors are symptoms -- find the cause.
- If you cannot determine a root cause, say so and explain what additional information would help.
- Do not invent issues. If the logs look healthy, say so.
- Consider cascading failures: one root cause can produce many different error messages.
- Pay attention to timing: errors that start at the same time likely share a root cause.`;

// ---------------------------------------------------------------------------
// Analysis agent
// ---------------------------------------------------------------------------

async function analyzeLogs(
  logText: string,
  preAnalysis: string,
  samplingDesc: string,
  model: string,
  context?: string
): Promise<string> {
  const client = new Anthropic();

  const userParts = [
    "Analyze these application logs.\n",
    `**Sampling:** ${samplingDesc}\n`,
    `**Pre-computed statistics:**\n\`\`\`\n${preAnalysis}\n\`\`\`\n`,
  ];

  if (context) {
    userParts.push(`**Additional context from user:** ${context}\n`);
  }

  userParts.push(`**Log data:**\n\`\`\`\n${logText.slice(0, 150_000)}\n\`\`\`\n`);
  userParts.push("Produce your structured analysis now.");

  const userMessage = userParts.join("\n");

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        temperature: 0.2,
      });

      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    } catch (e) {
      const errorStr = String(e).toLowerCase();
      if (errorStr.includes("rate") || errorStr.includes("overloaded")) {
        const wait = Math.pow(2, attempt + 1);
        log("⏳", `API rate limit, retrying in ${wait}s...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw e;
    }
  }

  return "Error: Failed to get analysis after multiple retries.";
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npx tsx index.ts --file app.log [--context 'deploy happened at 3pm']");
    console.log("       cat app.log | npx tsx index.ts");
    console.log();
    console.log("Analyzes log files to find anomalies, patterns, and root causes.");
    process.exit(0);
  }

  // Parse args
  let filePath: string | null = null;
  let context: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && i + 1 < args.length) {
      filePath = args[++i];
    } else if (args[i] === "--context" && i + 1 < args.length) {
      context = args[++i];
    }
  }

  // Read logs
  let lines: string[];
  let source: string;

  if (filePath) {
    lines = readLogFile(filePath);
    source = filePath;
  } else {
    lines = await readStdin();
    source = "stdin";
  }

  // Filter empty trailing lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  if (lines.length === 0) {
    console.error("❌ No log data provided.");
    console.error("   Usage: npx tsx index.ts --file app.log");
    console.error("          cat app.log | npx tsx index.ts");
    process.exit(1);
  }

  log("🚀", "Starting log analysis agent...");
  log("🤖", `Model: ${model}`);
  log("📄", `Source: ${source} (${lines.length} lines)`);
  console.log();

  // Pre-process
  log("🔍", "Pre-processing logs...");
  const preAnalysis = buildPreAnalysis(lines);
  console.log();
  console.log(preAnalysis);
  console.log();

  // Sample for large logs
  const { text: logText, description: samplingDesc } = sampleLines(lines);
  log("📊", samplingDesc);

  // Send to Claude
  log("🧠", "Sending to Claude for analysis...");
  console.log();

  const analysis = await analyzeLogs(logText, preAnalysis, samplingDesc, model, context);

  console.log("=".repeat(60));
  console.log("📊 Log Analysis Report");
  console.log("=".repeat(60));
  console.log();
  console.log(analysis);
  console.log();
  console.log("=".repeat(60));
  log("✅", "Analysis complete!");
}

main().catch((e) => {
  console.error(`\n❌ Error: ${e}`);
  process.exit(1);
});
