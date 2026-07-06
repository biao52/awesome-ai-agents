/**
 * Standup Summarizer Agent -- Reads git log from a repository and generates
 * a structured standup update (Yesterday, Today, Blockers).
 *
 * Uses OpenAI GPT to transform raw git history into a concise, readable standup.
 */

import "dotenv/config";
import OpenAI from "openai";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_DAYS = 1;
const MAX_RETRIES = 3;
const MAX_COMMITS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitCommit {
  hash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
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
// Git operations
// ---------------------------------------------------------------------------

function isGitRepo(repoPath: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: repoPath,
      stdio: "pipe",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function getRepoName(repoPath: string): string {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 10_000,
    }).trim();

    let name = url.replace(/\/$/, "").split("/").pop() || "";
    if (name.endsWith(".git")) name = name.slice(0, -4);
    return name || basename(resolve(repoPath));
  } catch {
    return basename(resolve(repoPath));
  }
}

function getCurrentBranch(repoPath: string): string {
  try {
    return execSync("git branch --show-current", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 10_000,
    }).trim();
  } catch {
    return "unknown";
  }
}

function getGitLog(repoPath: string, days: number): GitCommit[] {
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const separator = "---COMMIT_SEP---";
  const fieldSep = "---FIELD_SEP---";
  const fmt = `%H${fieldSep}%an${fieldSep}%ae${fieldSep}%ai${fieldSep}%s${fieldSep}%b${separator}`;

  try {
    const raw = execSync(
      `git log --since="${sinceDate}" --max-count=${MAX_COMMITS} --pretty=format:"${fmt}" --no-merges`,
      {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 30_000,
      }
    ).trim();

    if (!raw) return [];

    const commits: GitCommit[] = [];
    for (const entry of raw.split(separator)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      const fields = trimmed.split(fieldSep);
      if (fields.length >= 5) {
        commits.push({
          hash: fields[0].slice(0, 8),
          author: fields[1],
          email: fields[2],
          date: fields[3],
          subject: fields[4],
          body: fields.length > 5 ? fields[5].trim() : "",
        });
      }
    }

    return commits;
  } catch (e) {
    log("⚠️", `git log failed: ${e}`);
    return [];
  }
}

function getDiffStats(repoPath: string, days: number): string {
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  try {
    return execSync(
      `git log --since="${sinceDate}" --shortstat --no-merges --pretty=format:""`,
      {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 15_000,
      }
    ).trim();
  } catch {
    return "";
  }
}

function readTodoFile(repoPath: string): string {
  for (const filename of ["TODO.md", "TODO.txt", "TODO", "TASKS.md"]) {
    const filePath = join(repoPath, filename);
    if (existsSync(filePath)) {
      try {
        let content = readFileSync(filePath, "utf-8");
        if (content.trim()) {
          if (content.length > 2000) {
            content = content.slice(0, 2000) + "\n... (truncated)";
          }
          return content;
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Standup generation via LLM
// ---------------------------------------------------------------------------

async function generateStandup(
  commits: GitCommit[],
  repoName: string,
  branch: string,
  diffStats: string,
  todoContent: string,
  days: number,
  model: string
): Promise<string> {
  const client = new OpenAI();

  let commitText = "";
  for (const c of commits) {
    commitText += `  [${c.hash}] ${c.date.slice(0, 10)} - ${c.subject}\n`;
    if (c.body) {
      commitText += `           ${c.body.slice(0, 200)}\n`;
    }
  }

  const period = days > 1 ? `last ${days} day(s)` : "last 24 hours";

  let prompt = `Based on the following git activity, generate a standup update.

Repository: ${repoName}
Branch: ${branch}
Period: ${period}
Total commits: ${commits.length}

Git log:
${commitText || "  (no commits in this period)"}
`;

  if (diffStats) {
    prompt += `\nChange statistics:\n${diffStats}\n`;
  }

  if (todoContent) {
    prompt += `\nTODO/Tasks file contents:\n${todoContent}\n`;
  }

  prompt += `
Generate a concise standup update with these three sections:

1. **Yesterday** (or "Recent work" if looking back more than 1 day)
   - Summarize what was accomplished based on the commits
   - Group related commits into logical work items
   - Use past tense, be specific but concise

2. **Today** (planned work)
   - Infer what might be next based on the recent work patterns
   - If TODO content is available, reference relevant upcoming tasks
   - If there is not enough info, say "To be determined based on priorities"

3. **Blockers**
   - Note any potential blockers you can infer (e.g., incomplete work, WIP commits)
   - If nothing is apparent, say "None"

Format the output as a clean standup message. Keep each bullet point to one line.
Do not use markdown headers -- use plain text with clear section labels.
Keep the total output under 300 words.`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant that generates concise, professional " +
              "standup updates from git history. Be specific about what was done, " +
              "but keep it brief. Write in first person.",
          },
          { role: "user", content: prompt },
        ],
      });

      return response.choices[0]?.message?.content || "No standup generated.";
    } catch (e) {
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

  return "Failed to generate standup.";
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let repoPath = ".";
  let days = DEFAULT_DAYS;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--repo" || args[i] === "-r") && i + 1 < args.length) {
      repoPath = args[i + 1];
      i++;
    } else if (
      (args[i] === "--days" || args[i] === "-d") &&
      i + 1 < args.length
    ) {
      days = parseInt(args[i + 1], 10);
      if (isNaN(days) || days < 1) {
        console.error(`❌ Invalid number of days: ${args[i + 1]}`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [OPTIONS]");
      console.log();
      console.log("Options:");
      console.log(
        "  --repo, -r PATH    Path to git repository (default: current directory)"
      );
      console.log(
        `  --days, -d NUMBER   Number of days to look back (default: ${DEFAULT_DAYS})`
      );
      console.log("  --help, -h          Show this help message");
      console.log();
      console.log("Examples:");
      console.log(
        "  npx tsx index.ts                    # Current repo, last 24 hours"
      );
      console.log(
        "  npx tsx index.ts --days 2           # Look back 2 days"
      );
      console.log(
        "  npx tsx index.ts --repo /path/to/project --days 3"
      );
      process.exit(0);
    } else {
      console.error(`❌ Unknown argument: ${args[i]}`);
      console.error("   Use --help for usage information.");
      process.exit(1);
    }
  }

  const absRepo = resolve(repoPath);

  log("🚀", "Starting standup summarizer agent...");
  log("🤖", `Model: ${model}`);
  log("📁", `Repository: ${absRepo}`);
  log("📅", `Looking back: ${days} day(s)`);
  console.log();

  // Validate git repo
  if (!isGitRepo(absRepo)) {
    console.error(`❌ Not a git repository: ${absRepo}`);
    console.error(
      "   Make sure you are in a git repo or use --repo to specify one."
    );
    process.exit(1);
  }

  const repoName = getRepoName(absRepo);
  const branch = getCurrentBranch(absRepo);
  log("📋", `Repo: ${repoName} (branch: ${branch})`);

  // Gather data
  log("🔍", "Reading git log...");
  const commits = getGitLog(absRepo, days);
  log("📊", `Found ${commits.length} commit(s) in the last ${days} day(s)`);

  const diffStats = getDiffStats(absRepo, days);
  const todoContent = readTodoFile(absRepo);
  if (todoContent) {
    log("📝", "Found TODO file, including in context");
  }

  // Generate standup
  console.log();
  log("🤖", "Generating standup update...");

  try {
    const standup = await generateStandup(
      commits,
      repoName,
      branch,
      diffStats,
      todoContent,
      days,
      model
    );

    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    console.log();
    console.log("=".repeat(50));
    console.log(`  Standup Update -- ${repoName}`);
    console.log(`  ${dateStr}`);
    console.log("=".repeat(50));
    console.log();
    console.log(standup);
    console.log();
    log("✅", "Done!");
  } catch (e) {
    console.error(`\n❌ Error generating standup: ${e}`);
    console.error("   Check your OPENAI_API_KEY and network connection.");
    process.exit(1);
  }
}

main().catch(console.error);
