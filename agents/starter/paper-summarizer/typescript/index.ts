/**
 * Paper Summarizer Agent -- Reads research papers via URLs and produces structured summaries.
 *
 * This agent uses Reader (https://reader.dev) to convert web pages to clean markdown.
 * The free endpoint at r.reader.dev requires no API key or signup.
 */

import "dotenv/config";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["OPENAI_API_KEY"];
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
// Reader -- fetch web pages as clean markdown
// ---------------------------------------------------------------------------

const READER_BASE_URL = "https://r.reader.dev/";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPaper(url: string): Promise<string> {
  /**
   * Fetch a paper URL via Reader and return its markdown content.
   * Reader converts any web page into clean markdown, which is exactly
   * what LLMs need for comprehension. No HTML parsing required.
   */
  const readerUrl = `${READER_BASE_URL}${url}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(readerUrl, {
        headers: { Accept: "text/markdown" },
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const content = await response.text();

      if (!content.trim()) {
        throw new Error("Reader returned empty content");
      }

      return content;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        log("⚠️", `Attempt ${attempt} failed for ${url}: ${e}`);
        log("   ", `Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      } else {
        throw new Error(
          `Failed to fetch ${url} after ${MAX_RETRIES} attempts: ${e}`
        );
      }
    }
  }

  throw new Error(`Failed to fetch ${url}`);
}

// ---------------------------------------------------------------------------
// Summarization via OpenAI
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert academic paper summarizer. Given the markdown content of a research paper or article, produce a structured summary.

Your summary MUST include these sections in this exact order:

## Title
The full title of the paper.

## Authors
List all authors. If not found in the content, write "Not available".

## Publication Info
Publication date, venue, or journal if mentioned. If not found, write "Not available".

## Research Question
The core problem or question the paper addresses (1-2 sentences).

## Methodology
What approach or methods the researchers used (1 short paragraph).

## Key Findings
3-5 bullet points summarizing the main results and contributions.

## Limitations
Any limitations the authors acknowledge or that are apparent (2-3 bullet points). If none mentioned, note that.

## Significance
Why this work matters -- its implications and potential impact (1-2 sentences).

## Related Work
Key prior work or references mentioned that provide context (2-3 bullet points). If not available, write "Not discussed in detail".

Rules:
- Be concise but precise. Prefer specifics over vague statements.
- Use the paper's own terminology.
- If the content is not a research paper (e.g., a blog post or article), adapt the sections accordingly but keep the same structure.
- Do NOT invent information. If something is not in the content, say so.
- Write in plain academic English. No hype words.`;

async function summarizeContent(
  content: string,
  url: string,
  client: OpenAI,
  model: string
): Promise<string> {
  /** Send paper content to OpenAI for structured summarization. */

  // Truncate very long content to stay within context limits.
  const maxChars = 80_000;
  let truncated = content;
  if (truncated.length > maxChars) {
    truncated =
      truncated.slice(0, maxChars) + "\n\n[Content truncated due to length]";
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Summarize this paper/article from ${url}:\n\n${truncated}`,
        },
      ];

      const response = await client.chat.completions.create({
        model,
        messages,
        temperature: 0.2,
      });

      const result = response.choices[0].message.content;
      if (!result) {
        throw new Error("Model returned empty response");
      }
      return result;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        log("⚠️", `Summarization attempt ${attempt} failed: ${e}`);
        log("   ", `Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      } else {
        throw new Error(
          `Failed to summarize after ${MAX_RETRIES} attempts: ${e}`
        );
      }
    }
  }

  throw new Error("Failed to summarize");
}

// ---------------------------------------------------------------------------
// Paper processing pipeline
// ---------------------------------------------------------------------------

interface PaperResult {
  url: string;
  summary: string;
  error: string | null;
}

async function processPaper(
  url: string,
  index: number,
  total: number,
  client: OpenAI,
  model: string
): Promise<PaperResult> {
  /** Fetch and summarize a single paper. */
  const label = `[${index}/${total}]`;

  log("📄", `${label} Fetching: ${url}`);
  const content = await fetchPaper(url);

  log("   ", `${label} Got ${content.length.toLocaleString()} chars of markdown`);

  log("🤖", `${label} Summarizing...`);
  const summary = await summarizeContent(content, url, client, model);

  log("✅", `${label} Done`);
  return { url, summary, error: null };
}

async function processAllPapers(
  urls: string[],
  client: OpenAI,
  model: string
): Promise<PaperResult[]> {
  /** Process all papers sequentially and return results. */
  const results: PaperResult[] = [];
  const total = urls.length;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const result = await processPaper(url, i + 1, total, client, model);
      results.push(result);
    } catch (e) {
      const errorMsg = String(e);
      log("❌", `[${i + 1}/${total}] Failed: ${url} -- ${errorMsg}`);
      results.push({ url, summary: "", error: errorMsg });
    }
  }

  return results;
}

function formatOutput(results: PaperResult[]): string {
  /** Format all summaries into a single markdown document. */
  const parts: string[] = [];

  if (results.length === 1) {
    const { url, summary, error } = results[0];
    if (error) {
      parts.push(`# Error\n\nFailed to summarize ${url}: ${error}`);
    } else {
      parts.push(summary);
    }
    parts.push(`\n---\n*Source: ${url}*`);
  } else {
    parts.push("# Paper Summaries\n");
    for (let i = 0; i < results.length; i++) {
      const { url, summary, error } = results[i];
      parts.push(`---\n\n## Paper ${i + 1}\n**Source:** ${url}\n`);
      if (error) {
        parts.push(`**Error:** ${error}\n`);
      } else {
        parts.push(summary);
      }
      parts.push("");
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { urls: string[]; outputFile: string | null } {
  const urls: string[] = [];
  let outputFile: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output" && i + 1 < argv.length) {
      outputFile = argv[i + 1];
      i++;
    } else {
      urls.push(argv[i]);
    }
  }

  return { urls, outputFile };
}

async function promptForUrls(): Promise<string[]> {
  /** Interactive mode: prompt the user for paper URLs. */
  console.log("📎 Enter paper URLs (one per line, empty line to finish):");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const urls: string[] = [];

  return new Promise((resolve) => {
    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        rl.close();
        resolve(urls);
      } else {
        urls.push(trimmed);
        process.stdout.write("   > ");
      }
    });

    rl.on("close", () => {
      resolve(urls);
    });

    process.stdout.write("   > ");
  });
}

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || "gpt-4o-mini";
  const client = new OpenAI();

  const { urls: cliUrls, outputFile } = parseArgs(process.argv.slice(2));

  // Interactive mode if no URLs given
  const urls = cliUrls.length > 0 ? cliUrls : await promptForUrls();

  if (urls.length === 0) {
    console.error("❌ No URLs provided.");
    process.exit(1);
  }

  log("🚀", "Starting paper summarizer...");
  log("📋", `Papers to summarize: ${urls.length}`);
  log("🤖", `Model: ${model}`);
  console.log();

  const results = await processAllPapers(urls, client, model);

  const successes = results.filter((r) => r.error === null).length;
  const failures = results.length - successes;

  const output = formatOutput(results);

  console.log("\n" + "=".repeat(60));
  log("✅", `Complete! ${successes} summarized, ${failures} failed.\n`);
  console.log(output);

  if (outputFile) {
    await writeFile(outputFile, output, "utf8");
    log("💾", `Saved to ${outputFile}`);
  }
}

main().catch(console.error);
