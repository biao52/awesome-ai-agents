/**
 * Code Review Agent — Reviews code from a file, GitHub URL, or stdin and produces
 * a structured quality report with severity-rated findings.
 *
 * Uses Anthropic Claude for analysis (best-in-class for code review).
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { basename, resolve, extname } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_CODE_LENGTH = 100_000; // ~100K chars
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 60_000;

// GitHub URL pattern: github.com/<owner>/<repo>/blob/<branch>/<path>
const GITHUB_URL_PATTERN =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.*)/;

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
// Code input handling — file, URL, stdin
// ---------------------------------------------------------------------------

function readFromFile(filePath: string): [string, string] {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  let code: string;
  try {
    code = readFileSync(absPath, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EACCES") {
      console.error(`❌ Permission denied: ${filePath}`);
    } else {
      console.error(`❌ Could not read file: ${err.message}`);
    }
    process.exit(1);
  }

  if (code.length > MAX_CODE_LENGTH) {
    log(
      "⚠️",
      `File is very large (${code.length.toLocaleString()} chars). Truncating to ${MAX_CODE_LENGTH.toLocaleString()} chars.`
    );
    code = code.slice(0, MAX_CODE_LENGTH);
  }

  return [code, basename(absPath)];
}

async function readFromGitHub(url: string): Promise<[string, string]> {
  const match = url.match(GITHUB_URL_PATTERN);
  if (!match) {
    console.error(`❌ Invalid GitHub URL format: ${url}`);
    console.error(
      "   Expected: https://github.com/<owner>/<repo>/blob/<branch>/<path>"
    );
    process.exit(1);
  }

  const [, owner, repo, branch, filePath] = match;
  const filename = filePath.split("/").pop() || filePath;
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;

  log("🌐", `Fetching from GitHub: ${owner}/${repo}/${filePath}`);

  let code: string;
  try {
    const response = await fetch(rawUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.error(`❌ File not found on GitHub: ${filePath}`);
        console.error(
          "   Make sure the file path and branch are correct, and the repo is public."
        );
      } else {
        const body = await response.text();
        console.error(
          `❌ GitHub returned ${response.status}: ${body.slice(0, 200)}`
        );
      }
      process.exit(1);
    }

    code = await response.text();
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      console.error(`❌ Request timed out fetching ${rawUrl}`);
    } else {
      console.error(`❌ Network error fetching from GitHub: ${e}`);
    }
    process.exit(1);
  }

  if (code.length > MAX_CODE_LENGTH) {
    log(
      "⚠️",
      `File is very large (${code.length.toLocaleString()} chars). Truncating to ${MAX_CODE_LENGTH.toLocaleString()} chars.`
    );
    code = code.slice(0, MAX_CODE_LENGTH);
  }

  return [code, filename];
}

async function readFromStdin(): Promise<[string, string]> {
  if (process.stdin.isTTY) {
    log(
      "📝",
      "Paste your code below, then press Ctrl+D (Unix) or Ctrl+Z (Windows) to submit:"
    );
    console.log();
  }

  const chunks: string[] = [];
  process.stdin.setEncoding("utf8");

  return new Promise<[string, string]>((resolve) => {
    process.stdin.on("data", (chunk) => {
      chunks.push(String(chunk));
    });
    process.stdin.on("end", () => {
      let code = chunks.join("");

      if (!code.trim()) {
        console.error(
          "❌ No code provided. Pipe code via stdin or use --file / --url flags."
        );
        process.exit(1);
      }

      if (code.length > MAX_CODE_LENGTH) {
        log(
          "⚠️",
          `Input is very large (${code.length.toLocaleString()} chars). Truncating to ${MAX_CODE_LENGTH.toLocaleString()} chars.`
        );
        code = code.slice(0, MAX_CODE_LENGTH);
      }

      resolve([code, "stdin"]);
    });
  });
}

function detectLanguage(filename: string, code: string): string {
  const extMap: Record<string, string> = {
    ".py": "Python",
    ".js": "JavaScript",
    ".ts": "TypeScript",
    ".tsx": "TypeScript (React)",
    ".jsx": "JavaScript (React)",
    ".rs": "Rust",
    ".go": "Go",
    ".java": "Java",
    ".kt": "Kotlin",
    ".rb": "Ruby",
    ".php": "PHP",
    ".cs": "C#",
    ".cpp": "C++",
    ".c": "C",
    ".swift": "Swift",
    ".sh": "Shell",
    ".sql": "SQL",
    ".html": "HTML",
    ".css": "CSS",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".json": "JSON",
    ".toml": "TOML",
    ".md": "Markdown",
  };

  const ext = extname(filename).toLowerCase();
  if (ext && ext in extMap) {
    return extMap[ext];
  }

  // Fallback: heuristics from code content
  if (
    code.startsWith("#!/usr/bin/env python") ||
    code.slice(0, 200).includes("import ")
  ) {
    return "Python";
  }
  if (
    code.slice(0, 500).includes("function ") ||
    code.slice(0, 500).includes("const ")
  ) {
    return "JavaScript/TypeScript";
  }

  return "Unknown";
}

// ---------------------------------------------------------------------------
// Code review via Anthropic Claude
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert code reviewer with deep experience across all major programming languages and frameworks. You perform thorough, multi-dimensional code reviews.

Your review MUST cover these categories (skip any that have zero findings):

1. **CRITICAL** — Security vulnerabilities, data loss risks, crashes, race conditions
2. **WARNING** — Bugs, performance issues, error handling gaps, bad practices
3. **SUGGESTION** — Code style, readability, maintainability improvements

For each finding, provide:
- The specific line number(s) or code location
- A clear description of the issue
- A concrete fix or recommendation
- Why it matters (the impact if left unfixed)

At the end, provide:
- An **Overall Score** from 1-10 (10 = production-ready, flawless)
- A **Summary** paragraph assessing the code's fitness for production

Rules:
- Be specific. "Line 45: SQL injection" is good. "Code has issues" is useless.
- Be constructive. Every criticism must include a fix.
- Be honest. If the code is good, say so. Don't invent problems.
- Do NOT hallucinate line numbers. If you can't identify the exact line, describe the location.
- Consider the language's idioms and best practices (e.g., Python PEP 8, Go conventions).
- Look for: injection flaws, hardcoded secrets, unvalidated input, missing error handling,
  resource leaks, race conditions, N+1 queries, unbounded allocations, type safety issues.

Output format (use exactly this structure):

📊 Code Review Results
═══════════════════════

**File:** <filename> (<language>, <line count> lines)

**Overall Score: X/10**

🔴 Critical (<count>)
  Line XX: <title>
  → <description>
  → Fix: <recommendation>

🟡 Warning (<count>)
  Line XX: <title>
  → <description>
  → Fix: <recommendation>

🟢 Suggestions (<count>)
  Line XX: <title>
  → <description>
  → Fix: <recommendation>

💡 Summary
  <2-3 sentence assessment of the code's overall quality and fitness for production>`;

async function reviewCode(
  code: string,
  filename: string,
  language: string,
  model: string
): Promise<string> {
  const client = new Anthropic();

  const lineCount = code.split("\n").length;
  const langHint = language.toLowerCase().split(" ")[0];
  const userMessage = `Review the following code.

**File:** ${filename}
**Language:** ${language}
**Lines:** ${lineCount}

\`\`\`${langHint}
${code}
\`\`\``;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        temperature: 0.2,
      });

      let result = "";
      for (const block of response.content) {
        if (block.type === "text") {
          result += block.text;
        }
      }

      return result;
    } catch (e) {
      const errorStr = String(e);
      const isTransient =
        errorStr.toLowerCase().includes("rate") ||
        errorStr.toLowerCase().includes("overloaded") ||
        errorStr.includes("529") ||
        errorStr.includes("500");

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

  throw new Error("Unreachable: max retries exceeded");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let filePath: string | null = null;
  let url: string | null = null;

  // Parse CLI arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && i + 1 < args.length) {
      filePath = args[i + 1];
      i++;
    } else if (args[i] === "--url" && i + 1 < args.length) {
      url = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [OPTIONS]");
      console.log();
      console.log("Options:");
      console.log("  --file PATH   Review a local file");
      console.log("  --url URL     Review code from a GitHub URL");
      console.log(
        "  (no args)     Read code from stdin (pipe or paste)"
      );
      console.log();
      console.log("Examples:");
      console.log("  npx tsx index.ts --file ./mycode.py");
      console.log(
        "  npx tsx index.ts --url https://github.com/user/repo/blob/main/src/index.ts"
      );
      console.log("  cat mycode.py | npx tsx index.ts");
      process.exit(0);
    } else {
      console.error(`❌ Unknown argument: ${args[i]}`);
      console.error("   Use --help for usage information.");
      process.exit(1);
    }
  }

  log("🚀", "Starting code review agent...");
  log("🤖", `Model: ${model}`);
  console.log();

  // Get code from the specified source
  let code: string;
  let filename: string;

  if (filePath) {
    [code, filename] = readFromFile(filePath);
    log("📄", `Reviewing: ${filename}`);
  } else if (url) {
    [code, filename] = await readFromGitHub(url);
  } else {
    [code, filename] = await readFromStdin();
    if (filename === "stdin") {
      log("📄", "Reviewing code from stdin");
    }
  }

  const language = detectLanguage(filename, code);
  const lineCount = code.split("\n").length;
  log("🔎", `Detected: ${language}, ${lineCount.toLocaleString()} lines`);
  console.log();
  log("🔍", "Analyzing...");

  try {
    const review = await reviewCode(code, filename, language, model);
    console.log();
    console.log(review);
  } catch (e) {
    console.error(`\n❌ Error during code review: ${e}`);
    console.error("   Check your ANTHROPIC_API_KEY and network connection.");
    process.exit(1);
  }
}

main().catch(console.error);
