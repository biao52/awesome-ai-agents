/**
 * PR Review Agent -- Fetches a pull request diff from GitHub and reviews it
 * like a senior engineer, producing a structured quality report.
 *
 * Uses Anthropic Claude for analysis and fetch for GitHub API access.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_DIFF_LENGTH = 200_000;
const MAX_RETRIES = 3;

const GITHUB_PR_URL_PATTERN =
  /https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"];
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
// Types
// ---------------------------------------------------------------------------

interface PrInfo {
  title: string;
  body: string | null;
  user: { login: string };
  base: { ref: string };
  head: { ref: string };
  additions: number;
  deletions: number;
  changed_files: number;
}

interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

function githubHeaders(accept: string): Record<string, string> {
  return {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
    Accept: accept,
    "User-Agent": "pr-review-agent",
  };
}

async function fetchPrInfo(
  owner: string,
  repo: string,
  number: number
): Promise<PrInfo> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  const res = await fetch(url, {
    headers: githubHeaders("application/vnd.github.v3+json"),
  });

  if (res.status === 404) {
    console.error(`❌ Pull request not found: ${owner}/${repo}#${number}`);
    process.exit(1);
  }
  if (res.status === 401) {
    console.error("❌ GitHub authentication failed. Check your GITHUB_TOKEN.");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`❌ GitHub API error: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  return (await res.json()) as PrInfo;
}

async function fetchPrDiff(
  owner: string,
  repo: string,
  number: number
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  const res = await fetch(url, {
    headers: githubHeaders("application/vnd.github.v3.diff"),
  });
  if (!res.ok) {
    console.error(`❌ Failed to fetch diff: ${res.status}`);
    process.exit(1);
  }

  let diff = await res.text();
  if (diff.length > MAX_DIFF_LENGTH) {
    log("⚠️", `Diff truncated from ${diff.length} to ${MAX_DIFF_LENGTH} chars`);
    diff = diff.slice(0, MAX_DIFF_LENGTH) + "\n\n... (diff truncated -- too large)";
  }
  return diff;
}

async function fetchPrFiles(
  owner: string,
  repo: string,
  number: number
): Promise<PrFile[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files`;
  const res = await fetch(url, {
    headers: githubHeaders("application/vnd.github.v3+json"),
  });
  if (!res.ok) {
    console.error(`❌ Failed to fetch file list: ${res.status}`);
    process.exit(1);
  }
  return (await res.json()) as PrFile[];
}

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

function parsePrRef(args: string[]): { owner: string; repo: string; number: number } {
  if (args.length === 0) {
    console.log("Usage: npx tsx index.ts owner/repo 123");
    console.log("       npx tsx index.ts https://github.com/owner/repo/pull/123");
    process.exit(1);
  }

  // Try URL format
  const match = args[0].match(GITHUB_PR_URL_PATTERN);
  if (match) {
    return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
  }

  // Try owner/repo number format
  if (args.length >= 2 && args[0].includes("/")) {
    const [owner, repo] = args[0].split("/", 2);
    const num = parseInt(args[1], 10);
    if (!isNaN(num)) {
      return { owner, repo, number: num };
    }
  }

  console.error("❌ Could not parse PR reference.");
  console.error("   Usage: npx tsx index.ts owner/repo 123");
  console.error("          npx tsx index.ts https://github.com/owner/repo/pull/123");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build review context
// ---------------------------------------------------------------------------

function buildFileSummary(files: PrFile[]): string {
  return files
    .map((f) => `  ${f.status}: ${f.filename} (+${f.additions} -${f.deletions})`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior software engineer conducting a thorough code review of a pull request. You have deep expertise in security, performance, reliability, and software design.

Review the PR diff carefully and produce a structured review. Be specific -- reference exact file names and line numbers from the diff. Do not invent issues that are not visible in the diff.

Your review must follow this exact format:

## Overall Assessment
[1-2 sentences summarizing the PR quality and readiness to merge]

## Score: X/10
[Single line with numeric score]

## Critical Issues (must fix before merge)
[Each issue on its own line with this format:]
- **[FILE:LINE]** CATEGORY: Description of the issue and why it matters
  Fix: Specific suggestion for how to resolve it

## Warnings (should fix)
[Same format as critical issues]

## Suggestions (nice to have)
[Same format]

## What's Good
[2-3 bullet points about what the PR does well]

Categories to check:
- SECURITY: SQL injection, XSS, auth bypasses, secret exposure, path traversal
- BUG: Logic errors, off-by-one, null/undefined handling, race conditions
- PERFORMANCE: N+1 queries, unnecessary allocations, missing indexes, blocking I/O
- ERROR HANDLING: Swallowed errors, missing validation, unclear error messages
- DESIGN: Code duplication, tight coupling, unclear naming, missing abstractions
- TESTING: Missing tests, untested edge cases, flaky test patterns
- TYPES: Missing or incorrect type annotations, unsafe casts

Rules:
- Only flag real issues visible in the diff. Do not speculate about code you cannot see.
- Be constructive. Every criticism must include a concrete fix suggestion.
- Severity matters: Critical means "this will cause a bug or security vulnerability in production."
  Warning means "this will cause problems eventually." Suggestion means "this would be better."
- If the PR looks good, say so. Not every PR has critical issues.
- Keep the review concise. Quality over quantity.`;

// ---------------------------------------------------------------------------
// Review agent
// ---------------------------------------------------------------------------

async function reviewPr(
  prInfo: PrInfo,
  diff: string,
  fileSummary: string,
  model: string
): Promise<string> {
  const client = new Anthropic();

  const prTitle = prInfo.title || "Untitled";
  const prBody = (prInfo.body || "(no description)").slice(0, 2000);
  const prAuthor = prInfo.user?.login || "unknown";
  const prBase = prInfo.base?.ref || "main";
  const prHead = prInfo.head?.ref || "unknown";

  const userMessage = `Review this pull request.

**PR Title:** ${prTitle}
**Author:** ${prAuthor}
**Branch:** ${prHead} -> ${prBase}

**PR Description:**
${prBody}

**Changed Files:**
${fileSummary}

**Diff:**
\`\`\`diff
${diff}
\`\`\`

Produce your structured review now.`;

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

  return "Error: Failed to get review after multiple retries.";
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npx tsx index.ts owner/repo 123");
    console.log("       npx tsx index.ts https://github.com/owner/repo/pull/123");
    console.log();
    console.log("Reviews a GitHub pull request like a senior engineer.");
    process.exit(0);
  }

  const { owner, repo, number } = parsePrRef(args);

  log("🚀", "Starting PR review agent...");
  log("🤖", `Model: ${model}`);
  log("📋", `Reviewing: ${owner}/${repo}#${number}`);
  console.log();

  // Fetch PR data in parallel
  log("🔍", "Fetching PR data from GitHub...");
  const [prInfo, diff, files] = await Promise.all([
    fetchPrInfo(owner, repo, number),
    fetchPrDiff(owner, repo, number),
    fetchPrFiles(owner, repo, number),
  ]);

  log("📄", `PR: ${prInfo.title}`);
  log(
    "📊",
    `Stats: ${prInfo.changed_files} files changed, +${prInfo.additions} -${prInfo.deletions}`
  );
  console.log();

  const fileSummary = buildFileSummary(files);
  log("📝", `Diff size: ${diff.length} chars`);
  log("🧠", "Sending to Claude for review...");
  console.log();

  const review = await reviewPr(prInfo, diff, fileSummary, model);

  console.log("=".repeat(60));
  console.log(`📊 Code Review: ${owner}/${repo}#${number}`);
  console.log("=".repeat(60));
  console.log();
  console.log(review);
  console.log();
  console.log("=".repeat(60));
  log("✅", "Review complete!");
}

main().catch((e) => {
  console.error(`\n❌ Error: ${e}`);
  process.exit(1);
});
