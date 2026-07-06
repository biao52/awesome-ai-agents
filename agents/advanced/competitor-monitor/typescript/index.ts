/**
 * Competitor Monitor Agent
 *
 * Crawls competitor websites using Reader, diffs content against previous
 * snapshots, and uses Claude to analyze what changed and why it matters.
 *
 * Usage:
 *   npx tsx index.ts "https://competitor.com/pricing" "https://competitor.com/features"
 *   npx tsx index.ts --reset
 */

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import "dotenv/config";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SNAPSHOTS_DIR = join(__dirname, "snapshots");
const READER_API_URL = "https://api.reader.dev/v1/read";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Snapshot {
  url: string;
  content: string;
  capturedAt: string;
  title: string;
  wordCount: number;
}

interface DiffResult {
  url: string;
  isFirstRun: boolean;
  addedLines: string[];
  removedLines: string[];
  addedBlocks: string[];
  removedBlocks: string[];
  summary: string;
}

interface ChangeReport {
  url: string;
  analysis: string;
  capturedAt: string;
  diffStats: {
    addedLines: number;
    removedLines: number;
    addedBlocks: number;
    removedBlocks: number;
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string, level: string = "info"): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  const prefixes: Record<string, string> = {
    info: "   ",
    ok: " + ",
    warn: " ! ",
    error: " X ",
    step: ">> ",
  };
  const prefix = prefixes[level] ?? "   ";
  console.log(`[${timestamp}]${prefix}${message}`);
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    log("ANTHROPIC_API_KEY is not set. Add it to .env or export it.", "error");
    process.exit(1);
  }
  const readerKey = process.env.READER_API_KEY ?? "";
  if (!readerKey) {
    log("READER_API_KEY is not set. Get one at https://reader.dev", "error");
    process.exit(1);
  }
  log("Environment validated", "ok");
  return apiKey;
}

// ---------------------------------------------------------------------------
// Snapshot storage
// ---------------------------------------------------------------------------

function urlToFilename(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return `snapshot_${hash}.json`;
}

function loadSnapshot(url: string): Snapshot | null {
  const filepath = join(SNAPSHOTS_DIR, urlToFilename(url));
  if (!existsSync(filepath)) return null;

  try {
    const data = JSON.parse(readFileSync(filepath, "utf-8"));
    return data as Snapshot;
  } catch (err) {
    log(`Corrupt snapshot for ${url}: ${err}`, "warn");
    return null;
  }
}

function saveSnapshot(snapshot: Snapshot): string {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const filepath = join(SNAPSHOTS_DIR, urlToFilename(snapshot.url));
  writeFileSync(filepath, JSON.stringify(snapshot, null, 2), "utf-8");
  return filepath;
}

function clearSnapshots(): number {
  if (!existsSync(SNAPSHOTS_DIR)) return 0;

  let count = 0;
  for (const file of readdirSync(SNAPSHOTS_DIR)) {
    if (file.startsWith("snapshot_") && file.endsWith(".json")) {
      unlinkSync(join(SNAPSHOTS_DIR, file));
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Reader integration
// ---------------------------------------------------------------------------

async function readPage(url: string): Promise<Snapshot> {
  log(`Reading ${url} via Reader...`, "step");

  const response = await fetch(READER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.READER_API_KEY}`,
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Reader API error: ${response.status} reading ${url}`);
  }

  const respData = await response.json() as { data: { markdown: string } };
  const content = (respData.data.markdown || "").trim();
  const title = extractTitle(content);
  const wordCount = content.split(/\s+/).length;

  log(`Got ${wordCount} words from ${url}`, "ok");

  return {
    url,
    content,
    capturedAt: new Date().toISOString(),
    title,
    wordCount,
  };
}

function extractTitle(markdown: string): string {
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.replace(/^#+\s*/, "").trim();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Diff logic
// ---------------------------------------------------------------------------

function computeDiff(
  previous: Snapshot | null,
  current: Snapshot,
): DiffResult {
  if (previous === null) {
    return {
      url: current.url,
      isFirstRun: true,
      addedLines: [],
      removedLines: [],
      addedBlocks: [],
      removedBlocks: [],
      summary: "First capture, baseline snapshot saved.",
    };
  }

  const oldLines = previous.content.split("\n");
  const newLines = current.content.split("\n");

  // Simple line-level diff using LCS approach
  const { added, removed } = simpleDiff(oldLines, newLines);

  const addedBlocks = groupIntoBlocks(added);
  const removedBlocks = groupIntoBlocks(removed);

  const hasChanges = added.length > 0 || removed.length > 0;
  const summary = hasChanges
    ? `${added.length} lines added, ${removed.length} lines removed ` +
      `(${addedBlocks.length} new blocks, ${removedBlocks.length} removed blocks)`
    : "No changes detected since last snapshot.";

  return {
    url: current.url,
    isFirstRun: false,
    addedLines: added,
    removedLines: removed,
    addedBlocks,
    removedBlocks,
    summary,
  };
}

function simpleDiff(
  oldLines: string[],
  newLines: string[],
): { added: string[]; removed: string[] } {
  const oldSet = new Map<string, number>();
  for (const line of oldLines) {
    oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  }

  const newSet = new Map<string, number>();
  for (const line of newLines) {
    newSet.set(line, (newSet.get(line) ?? 0) + 1);
  }

  const removed: string[] = [];
  for (const [line, count] of oldSet) {
    const newCount = newSet.get(line) ?? 0;
    for (let i = 0; i < count - newCount; i++) {
      removed.push(line);
    }
  }

  const added: string[] = [];
  for (const [line, count] of newSet) {
    const oldCount = oldSet.get(line) ?? 0;
    for (let i = 0; i < count - oldCount; i++) {
      added.push(line);
    }
  }

  return { added, removed };
}

function groupIntoBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let currentBlock: string[] = [];

  for (const line of lines) {
    if (line.trim()) {
      currentBlock.push(line);
    } else if (currentBlock.length > 0) {
      blocks.push(currentBlock.join("\n"));
      currentBlock = [];
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock.join("\n"));
  }

  return blocks;
}

function formatDiffForClaude(diff: DiffResult): string {
  const parts: string[] = [];
  parts.push(`URL: ${diff.url}`);
  parts.push(`Change summary: ${diff.summary}`);
  parts.push("");

  if (diff.addedBlocks.length > 0) {
    parts.push("=== NEW CONTENT ===");
    diff.addedBlocks.forEach((block, i) => {
      parts.push(`\n[Added block ${i + 1}]`);
      parts.push(block);
    });
  }

  if (diff.removedBlocks.length > 0) {
    parts.push("\n=== REMOVED CONTENT ===");
    diff.removedBlocks.forEach((block, i) => {
      parts.push(`\n[Removed block ${i + 1}]`);
      parts.push(block);
    });
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Claude analysis
// ---------------------------------------------------------------------------

const ANALYSIS_SYSTEM = `You are a competitive intelligence analyst. You analyze
changes detected on competitor websites and produce actionable reports.

Focus on:
- What specifically changed (pricing, features, messaging, positioning)
- Why this change likely matters (market signal, competitive move, customer feedback response)
- What actions the reader should consider in response

Be specific and concise. Reference the actual content that changed.`;

const ANALYSIS_PROMPT = `Analyze the following changes detected on a competitor's website.

{diff_content}

Produce a structured change report with these sections:

1. **Change Summary** - One paragraph overview of what changed
2. **Key Changes** - Bullet points of each significant change
3. **Competitive Implications** - What this signals about the competitor's strategy
4. **Recommended Actions** - What you should do in response

If the changes are minor (formatting, typos), say so briefly and skip the detailed analysis.`;

async function analyzeChanges(
  apiKey: string,
  diffs: DiffResult[],
): Promise<ChangeReport[]> {
  const client = new Anthropic({ apiKey });
  const reports: ChangeReport[] = [];

  const actionable = diffs.filter((d) => !d.isFirstRun && (d.addedLines.length > 0 || d.removedLines.length > 0));

  if (actionable.length === 0) {
    log("No changes to analyze", "info");
    return reports;
  }

  log(`Analyzing ${actionable.length} page(s) with Claude...`, "step");

  for (const diff of actionable) {
    const diffContent = formatDiffForClaude(diff);

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: ANALYSIS_SYSTEM,
      messages: [
        {
          role: "user",
          content: ANALYSIS_PROMPT.replace("{diff_content}", diffContent),
        },
      ],
    });

    const analysisText =
      response.content[0].type === "text" ? response.content[0].text : "";

    reports.push({
      url: diff.url,
      analysis: analysisText,
      capturedAt: new Date().toISOString(),
      diffStats: {
        addedLines: diff.addedLines.length,
        removedLines: diff.removedLines.length,
        addedBlocks: diff.addedBlocks.length,
        removedBlocks: diff.removedBlocks.length,
      },
    });

    log(`Analysis complete for ${diff.url}`, "ok");
  }

  return reports;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function printReport(reports: ChangeReport[], diffs: DiffResult[]): void {
  const separator = "=".repeat(70);
  console.log(`\n${separator}`);
  console.log("  COMPETITOR MONITOR REPORT");
  console.log(
    `  Generated at ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
  );
  console.log(separator);

  const firstRuns = diffs.filter((d) => d.isFirstRun);
  if (firstRuns.length > 0) {
    console.log("\n--- Baseline Captures (first run) ---");
    for (const d of firstRuns) {
      console.log(`  Captured: ${d.url}`);
    }
  }

  const unchanged = diffs.filter(
    (d) => !d.isFirstRun && d.addedLines.length === 0 && d.removedLines.length === 0,
  );
  if (unchanged.length > 0) {
    console.log("\n--- No Changes Detected ---");
    for (const d of unchanged) {
      console.log(`  Unchanged: ${d.url}`);
    }
  }

  for (const report of reports) {
    const divider = "- ".repeat(35);
    console.log(`\n${divider}`);
    console.log(`  ${report.url}`);
    console.log(
      `  +${report.diffStats.addedLines} lines / -${report.diffStats.removedLines} lines`,
    );
    console.log(`${divider}\n`);
    console.log(report.analysis);
  }

  console.log(`\n${separator}`);
}

function saveReport(reports: ChangeReport[]): string | null {
  if (reports.length === 0) return null;

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 15);
  const filepath = join(SNAPSHOTS_DIR, `report_${timestamp}.json`);
  writeFileSync(filepath, JSON.stringify(reports, null, 2), "utf-8");
  log(`Report saved to ${filepath}`, "ok");
  return filepath;
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

async function monitor(urls: string[], apiKey: string): Promise<void> {
  log(`Monitoring ${urls.length} URL(s)`, "step");
  const start = Date.now();

  const diffs: DiffResult[] = [];

  for (const url of urls) {
    try {
      const current = await readPage(url);
      const previous = loadSnapshot(url);
      const diff = computeDiff(previous, current);
      diffs.push(diff);

      if (diff.isFirstRun) {
        log(`First run for ${url}, saving baseline`, "info");
      } else if (diff.addedLines.length > 0 || diff.removedLines.length > 0) {
        log(`Changes detected on ${url}: ${diff.summary}`, "warn");
      } else {
        log(`No changes on ${url}`, "ok");
      }

      saveSnapshot(current);
    } catch (err) {
      log(`Failed to read ${url}: ${err}`, "error");
    }
  }

  const reports = await analyzeChanges(apiKey, diffs);

  printReport(reports, diffs);
  saveReport(reports);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`Done in ${elapsed}s`, "ok");
}

function parseArgs(): { urls: string[]; reset: boolean } {
  const args = process.argv.slice(2);

  if (args.includes("--reset")) {
    return { urls: [], reset: true };
  }

  const urls = args
    .filter((a) => !a.startsWith("--"))
    .map((url) => (url.startsWith("http") ? url : `https://${url}`));

  return { urls, reset: false };
}

async function main(): Promise<void> {
  const { urls, reset } = parseArgs();

  if (reset) {
    const count = clearSnapshots();
    log(`Cleared ${count} snapshot(s)`, "ok");
    return;
  }

  if (urls.length === 0) {
    log(
      "No URLs provided. Usage: npx tsx index.ts <url1> [url2] ...",
      "error",
    );
    process.exit(1);
  }

  const apiKey = validateEnv();

  log("Competitor Monitor starting", "step");
  await monitor(urls, apiKey);
}

main().catch((err) => {
  log(`Fatal error: ${err}`, "error");
  process.exit(1);
});
