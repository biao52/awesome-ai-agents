/**
 * Web Scraping Agent -- Takes a URL and a description of what data to extract,
 * fetches the page, and returns structured JSON matching the user's intent.
 *
 * Uses Anthropic Claude for intelligent HTML-to-JSON extraction.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_HTML_LENGTH = 120_000; // ~120K chars
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;

// Realistic browser headers to avoid basic anti-scraping blocks
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/125.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

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
  console.error(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Page fetching
// ---------------------------------------------------------------------------

async function fetchPage(url: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: BROWSER_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        if (response.status === 403) {
          console.error(`❌ Access denied (403 Forbidden): ${url}`);
          console.error(
            "   The site is blocking automated requests."
          );
          process.exit(1);
        }
        if (response.status === 404) {
          console.error(`❌ Page not found (404): ${url}`);
          process.exit(1);
        }
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          const wait = Math.pow(2, attempt);
          log(
            "⏳",
            `Server error ${response.status} (attempt ${attempt}/${MAX_RETRIES}), retrying in ${wait}s...`
          );
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        console.error(`❌ HTTP error ${response.status}: ${url}`);
        process.exit(1);
      }

      let html = await response.text();

      if (html.length > MAX_HTML_LENGTH) {
        log(
          "⚠️",
          `Page is large (${html.length.toLocaleString()} chars). Trimming to ${MAX_HTML_LENGTH.toLocaleString()} chars.`
        );
        html = html.slice(0, MAX_HTML_LENGTH);
      }

      return html;
    } catch (e) {
      const isTimeout =
        e instanceof DOMException && e.name === "TimeoutError";

      if (attempt < MAX_RETRIES) {
        const wait = Math.pow(2, attempt);
        const reason = isTimeout ? "Timeout" : "Network error";
        log(
          "⏳",
          `${reason} (attempt ${attempt}/${MAX_RETRIES}), retrying in ${wait}s...`
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
      } else {
        if (isTimeout) {
          console.error(
            `❌ Request timed out after ${MAX_RETRIES} attempts: ${url}`
          );
          console.error(
            "   The site may be slow or blocking automated requests."
          );
        } else {
          console.error(
            `❌ Network error after ${MAX_RETRIES} attempts: ${e}`
          );
          console.error(
            "   Check your internet connection and the URL."
          );
        }
        process.exit(1);
      }
    }
  }

  console.error("❌ Failed to fetch page after all retries.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Extraction via Anthropic Claude
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a data extraction expert. Given raw HTML from a web page and a description of what data to extract, you produce clean, structured JSON.

Your process:
1. Analyze the HTML to understand the page structure
2. Identify the data matching the user's extraction goal
3. Design an appropriate JSON schema for the extracted data
4. Extract all matching data into that schema

Rules:
- Output ONLY valid JSON. No markdown, no explanation, no code fences.
- Use an array of objects when extracting multiple items (e.g., list of products).
- Use a single object when extracting one item (e.g., company info).
- Use descriptive, snake_case keys (e.g., "product_name", not "name" or "productName").
- Include ALL matching items found on the page. Do not truncate or sample.
- If a field is missing for an item, use null rather than omitting the key.
- Clean the data: strip extra whitespace, decode HTML entities, normalize URLs to absolute.
- For prices, keep the currency symbol and format as strings (e.g., "$29.99").
- For dates, use ISO 8601 format when possible (e.g., "2024-01-15").
- If no matching data is found, return an empty array [] or object {} with a "_note" field explaining why.
- Do NOT hallucinate data. Only extract what is actually present in the HTML.
- Do NOT include HTML tags in extracted values.`;

async function extractData(
  html: string,
  url: string,
  goal: string,
  model: string
): Promise<string> {
  const client = new Anthropic();

  const userMessage = `Extract data from this web page.

**URL:** ${url}
**Extraction goal:** ${goal}

**Raw HTML:**
${html}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        temperature: 0.0,
      });

      let result = "";
      for (const block of response.content) {
        if (block.type === "text") {
          result += block.text;
        }
      }

      // Strip any markdown code fences the model might add despite instructions
      result = result.trim();
      if (result.startsWith("```json")) result = result.slice(7);
      if (result.startsWith("```")) result = result.slice(3);
      if (result.endsWith("```")) result = result.slice(0, -3);
      result = result.trim();

      // Validate JSON
      try {
        const parsed = JSON.parse(result);
        return JSON.stringify(parsed, null, 2);
      } catch {
        if (attempt < MAX_RETRIES) {
          log(
            "⚠️",
            `Model returned invalid JSON (attempt ${attempt}/${MAX_RETRIES}), retrying...`
          );
          continue;
        }
        log(
          "⚠️",
          "Model returned invalid JSON after all attempts. Returning raw output."
        );
        return result;
      }
    } catch (e) {
      const errorStr = String(e).toLowerCase();
      const isTransient =
        errorStr.includes("rate") ||
        errorStr.includes("overloaded") ||
        String(e).includes("529") ||
        String(e).includes("500");

      if (attempt < MAX_RETRIES && isTransient) {
        const wait = Math.pow(2, attempt);
        log(
          "⏳",
          `API error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${wait}s...`
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
      } else {
        throw e;
      }
    }
  }

  throw new Error("Max retries exceeded");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let url: string | null = null;
  let goal: string | null = null;
  let outputFile: string | null = null;

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && i + 1 < args.length) {
      outputFile = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts <URL> <EXTRACTION_GOAL> [OPTIONS]");
      console.log();
      console.log("Arguments:");
      console.log("  URL              The web page URL to scrape");
      console.log(
        "  EXTRACTION_GOAL  What data to extract (in plain English)"
      );
      console.log();
      console.log("Options:");
      console.log("  --output FILE    Save extracted JSON to a file");
      console.log();
      console.log("Examples:");
      console.log(
        '  npx tsx index.ts "https://news.ycombinator.com" "Extract all story titles, links, and points"'
      );
      console.log(
        '  npx tsx index.ts "https://example.com/products" "Extract product names and prices" --output products.json'
      );
      process.exit(0);
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length >= 2) {
    url = positional[0];
    goal = positional.slice(1).join(" ");
  } else if (positional.length === 1) {
    url = positional[0];
  }

  // Interactive prompts for missing inputs
  if (!url) {
    process.stderr.write("🌐 URL to scrape: ");
    url = await readLine();
  }
  if (!url.trim()) {
    console.error("❌ Please provide a URL.");
    process.exit(1);
  }

  if (!goal) {
    process.stderr.write("🎯 What data do you want to extract? ");
    goal = await readLine();
  }
  if (!goal.trim()) {
    console.error("❌ Please describe what data to extract.");
    process.exit(1);
  }

  // Validate URL format
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  log("🚀", "Starting web scraping agent...");
  log("🤖", `Model: ${model}`);
  log("🌐", `URL: ${url}`);
  log("🎯", `Goal: ${goal}`);
  console.error();

  // Step 1: Fetch the page
  log("📥", "Fetching page...");
  const html = await fetchPage(url);
  log("✓", `Fetched ${html.length.toLocaleString()} chars of HTML`);

  // Step 2: Extract data
  log("🔍", "Extracting data...");
  try {
    const resultJson = await extractData(html, url, goal, model);
    log("✅", "Extraction complete!");
    console.error();

    // Output JSON to stdout (logs go to stderr so JSON can be piped)
    console.log(resultJson);

    if (outputFile) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputFile, resultJson + "\n", "utf8");
      log("💾", `Saved to ${outputFile}`);
    }
  } catch (e) {
    console.error(`\n❌ Error during extraction: ${e}`);
    console.error("   Check your ANTHROPIC_API_KEY and network connection.");
    process.exit(1);
  }
}

/** Read a single line from stdin. */
function readLine(): Promise<string> {
  return new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += String(chunk);
      if (input.includes("\n")) {
        process.stdin.pause();
        resolve(input.trim());
      }
    });
    process.stdin.resume();
  });
}

main().catch(console.error);
