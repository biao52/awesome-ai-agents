/**
 * Git Commit Agent -- Reads a git diff and generates a conventional commit message
 * using Claude. Optionally applies the commit automatically.
 *
 * Uses Anthropic Claude for analysis (best-in-class for code understanding).
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_DIFF_LENGTH = 80_000; // ~80K chars
const MAX_RETRIES = 3;

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
// Git helpers
// ---------------------------------------------------------------------------

function runGit(args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`git ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number; message?: string };
    if (err.message?.includes("ENOENT")) {
      console.error("❌ git is not installed or not in PATH.");
      process.exit(1);
    }
    return { stdout: err.stdout || "", exitCode: err.status || 1 };
  }
}

function getDiff(): string {
  // Try staged changes first
  const staged = runGit(["diff", "--cached"]);
  if (staged.exitCode !== 0) {
    console.error("❌ Not a git repository or git error.");
    process.exit(1);
  }

  if (staged.stdout.trim()) {
    log("📋", "Using staged changes (git diff --cached)");
    return staged.stdout;
  }

  // Fall back to unstaged changes
  const unstaged = runGit(["diff"]);
  if (unstaged.exitCode !== 0) {
    console.error("❌ Failed to get git diff.");
    process.exit(1);
  }

  if (unstaged.stdout.trim()) {
    log("📋", "No staged changes found, using unstaged changes (git diff)");
    return unstaged.stdout;
  }

  console.error(
    "❌ No changes detected. Stage some changes or modify files first."
  );
  console.error("   Try: git add <files> and then run this agent again.");
  process.exit(1);
}

function getRepoContext(): string {
  const remote = runGit(["config", "--get", "remote.origin.url"]);
  const repoName = remote.stdout.trim()
    ? remote.stdout.trim().split("/").pop()?.replace(".git", "") || ""
    : "";

  const recentLog = runGit(["log", "--oneline", "-5", "--no-decorate"]);

  const parts: string[] = [];
  if (repoName) parts.push(`Repository: ${repoName}`);
  if (recentLog.stdout.trim()) {
    parts.push(
      `Recent commits (for style reference):\n${recentLog.stdout.trim()}`
    );
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Commit message generation via Claude
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert at writing git commit messages following the Conventional Commits specification.

Given a git diff, generate a single commit message that:

1. Uses a conventional commit type prefix:
   - feat: A new feature
   - fix: A bug fix
   - refactor: Code change that neither fixes a bug nor adds a feature
   - docs: Documentation only changes
   - test: Adding or updating tests
   - chore: Changes to build process, tooling, or auxiliary files
   - style: Formatting, whitespace, semicolons (no logic change)
   - perf: Performance improvement
   - ci: CI/CD configuration changes

2. Includes an optional scope in parentheses after the type (e.g., feat(auth): ...)

3. Has a concise subject line (50-72 characters) in imperative mood ("add" not "added")

4. Optionally includes a body (separated by a blank line) if the change is complex enough to warrant explanation

Rules:
- Analyze the actual code changes, not just file names
- The subject line must be lowercase (except proper nouns)
- No period at the end of the subject line
- The body should explain WHAT changed and WHY, not HOW
- If multiple unrelated changes exist, focus on the primary change
- Be specific: "fix null check in user auth" is better than "fix bug"
- Match the style of recent commits if provided

Output ONLY the commit message -- no explanations, no markdown fencing, no prefixes like "Here's the commit message:". Just the raw commit message text.`;

async function generateCommitMessage(
  diff: string,
  context: string,
  model: string
): Promise<string> {
  const client = new Anthropic();

  let truncatedDiff = diff;
  if (truncatedDiff.length > MAX_DIFF_LENGTH) {
    log(
      "⚠️",
      `Diff is large (${diff.length.toLocaleString()} chars). Truncating to ${MAX_DIFF_LENGTH.toLocaleString()} chars.`
    );
    truncatedDiff = truncatedDiff.slice(0, MAX_DIFF_LENGTH);
  }

  // Get diff stats
  let statOutput = runGit(["diff", "--cached", "--stat"]).stdout;
  if (!statOutput.trim()) {
    statOutput = runGit(["diff", "--stat"]).stdout;
  }

  const userMessage = `Generate a conventional commit message for this diff.

${context ? `Context:\n${context}\n` : ""}
Diff stats:
${statOutput.trim()}

Full diff:
\`\`\`
${truncatedDiff}
\`\`\``;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        temperature: 0.3,
      });

      let result = "";
      for (const block of response.content) {
        if (block.type === "text") {
          result += block.text;
        }
      }

      return result.trim();
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

function applyCommit(message: string): void {
  // Check if there are staged changes
  const staged = runGit(["diff", "--cached"]);
  if (!staged.stdout.trim()) {
    console.error("❌ No staged changes to commit. Stage your changes first:");
    console.error("   git add <files>");
    process.exit(1);
  }

  try {
    execSync(`git commit -m ${JSON.stringify(message)}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    log("✅", "Commit created successfully!");
    const commitInfo = runGit(["log", "--oneline", "-1"]);
    if (commitInfo.stdout.trim()) {
      log("📝", commitInfo.stdout.trim());
    }
  } catch (e) {
    const err = e as { stderr?: string };
    console.error(`❌ git commit failed:\n${err.stderr || e}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let apply = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") {
      apply = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [OPTIONS]");
      console.log();
      console.log(
        "Reads your git diff and generates a conventional commit message."
      );
      console.log();
      console.log("Options:");
      console.log(
        "  --apply    Apply the generated commit message (runs git commit)"
      );
      console.log("  --help     Show this help message");
      console.log();
      console.log("Examples:");
      console.log("  npx tsx index.ts              # Generate a commit message");
      console.log(
        "  npx tsx index.ts --apply      # Generate and apply the commit"
      );
      console.log();
      console.log(
        "The agent uses staged changes (git diff --cached) if available,"
      );
      console.log("otherwise falls back to unstaged changes (git diff).");
      process.exit(0);
    } else {
      console.error(`❌ Unknown argument: ${args[i]}`);
      console.error("   Use --help for usage information.");
      process.exit(1);
    }
  }

  log("🚀", "Starting git commit agent...");
  log("🤖", `Model: ${model}`);
  console.log();

  // Get the diff
  const diff = getDiff();
  const lineCount = diff.split("\n").length;
  log("📊", `Diff size: ${lineCount.toLocaleString()} lines`);
  console.log();

  // Get repo context for better messages
  const context = getRepoContext();

  // Generate commit message
  log("🔍", "Analyzing changes...");

  let message: string;
  try {
    message = await generateCommitMessage(diff, context, model);
  } catch (e) {
    console.error(`\n❌ Error generating commit message: ${e}`);
    console.error("   Check your ANTHROPIC_API_KEY and network connection.");
    process.exit(1);
  }

  console.log();
  log("💬", "Suggested commit message:");
  console.log();
  console.log("─".repeat(60));
  console.log(message);
  console.log("─".repeat(60));
  console.log();

  if (apply) {
    applyCommit(message);
  } else {
    log("💡", "To apply this commit, run again with --apply");
    log("💡", 'Or copy the message and run: git commit -m "<message>"');
  }
}

main().catch(console.error);
