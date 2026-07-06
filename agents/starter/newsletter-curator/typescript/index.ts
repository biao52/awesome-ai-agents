/**
 * Newsletter Curator -- Reads multiple URLs, extracts key content, and generates a curated digest.
 *
 * Uses Reader (https://reader.dev) to fetch clean, readable content from any URL,
 * then OpenAI to analyze and curate the best items into a newsletter.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FetchResult {
  url: string;
  title: string;
  content: string;
  status: "ok" | "error";
}

interface AnalyzedArticle {
  url: string;
  title: string;
  summary: string;
  key_points: string[];
  relevance_score: number;
  relevance_reason: string;
  category: string;
  status: "ok" | "error";
}

interface ParsedArgs {
  urls: string[];
  topic: string | null;
  output: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
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
// Phase 1: Fetch URLs via Reader
// ---------------------------------------------------------------------------

const READER_BASE = "https://r.reader.dev/";

/**
 * Fetch a single URL through Reader and return the result.
 *
 * Reader converts any web page into clean, LLM-friendly markdown.
 * No API key required -- the free tier works for all public URLs.
 */
async function fetchUrl(url: string): Promise<FetchResult> {
  const readerUrl = `${READER_BASE}${url}`;
  try {
    const response = await fetch(readerUrl, {
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      log("⚠️", `HTTP error fetching ${url}: ${response.status}`);
      return { url, title: url, content: "", status: "error" };
    }

    const content = await response.text();

    // Reader returns markdown with a Title: header on the first line
    let title = "";
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.startsWith("Title:")) {
        title = line.slice("Title:".length).trim();
        break;
      }
    }

    return {
      url,
      title: title || url,
      content: content.slice(0, 8000), // Trim to keep within context limits
      status: "ok",
    };
  } catch (e) {
    log("⚠️", `Failed to fetch ${url}: ${e}`);
    return { url, title: url, content: "", status: "error" };
  }
}

/**
 * Fetch all URLs in parallel using Reader.
 *
 * Uses Promise.all to read all pages concurrently. Reader handles
 * JavaScript rendering, cookie banners, and paywall bypassing so the
 * content comes back as clean markdown every time.
 */
async function fetchAllUrls(urls: string[]): Promise<FetchResult[]> {
  log("📡", `Fetching ${urls.length} URLs via Reader...`);

  const results = await Promise.all(urls.map((url) => fetchUrl(url)));

  const successful = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "error");

  log("✅", `Successfully fetched ${successful.length} pages`);
  if (failed.length > 0) {
    log("⚠️", `Failed to fetch ${failed.length} pages: ${failed.map((r) => r.url).join(", ")}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Phase 2: Extract key points from each article
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are a content analyst. Given an article's content, extract structured information.

Return a JSON object with these fields:
- "title": The article title (use the provided one or extract a better one)
- "key_points": Array of 3-5 key takeaways from the article
- "summary": A 2-3 sentence summary of the article
- "relevance_score": A score from 1-10 indicating how interesting/valuable this content is for a newsletter audience
- "relevance_reason": One sentence explaining why this scored high or low
- "category": One of: "tech", "business", "science", "culture", "opinion", "tutorial", "news", "other"

Focus on what makes this article unique or noteworthy. Prioritize actionable insights
and surprising findings over general information.

If a topic filter is provided, score relevance higher for articles that match the topic.`;

async function extractArticleInfo(
  client: OpenAI,
  model: string,
  article: FetchResult,
  topic: string | null,
): Promise<AnalyzedArticle> {
  if (article.status === "error") {
    return {
      ...article,
      key_points: [],
      summary: "Failed to fetch this article.",
      relevance_score: 0,
      relevance_reason: "Could not retrieve content.",
      category: "other",
    };
  }

  let userContent = `Article title: ${article.title}\n\nArticle content:\n${article.content}`;
  if (topic) {
    userContent += `\n\nNewsletter topic filter: ${topic}`;
  }

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const result = JSON.parse(response.choices[0].message.content || "{}") as Record<string, unknown>;

    return {
      url: article.url,
      title: (result.title as string) || article.title,
      summary: (result.summary as string) || "",
      key_points: (result.key_points as string[]) || [],
      relevance_score: (result.relevance_score as number) || 0,
      relevance_reason: (result.relevance_reason as string) || "",
      category: (result.category as string) || "other",
      status: "ok",
    };
  } catch (e) {
    log("⚠️", `Extraction failed for ${article.url}: ${e}`);
    return {
      ...article,
      key_points: [],
      summary: "Failed to analyze this article.",
      relevance_score: 0,
      relevance_reason: "Analysis error.",
      category: "other",
    };
  }
}

async function extractAll(
  client: OpenAI,
  model: string,
  articles: FetchResult[],
  topic: string | null,
): Promise<AnalyzedArticle[]> {
  log("🔍", "Analyzing articles with AI...");

  const results = await Promise.all(
    articles.map((article) => extractArticleInfo(client, model, article, topic)),
  );

  // Sort by relevance score, highest first
  results.sort((a, b) => b.relevance_score - a.relevance_score);

  for (const r of results) {
    const title = (r.title || r.url).slice(0, 60);
    log("   ", `[${r.relevance_score}/10] ${title}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Phase 3: Curate the newsletter
// ---------------------------------------------------------------------------

const CURATION_PROMPT = `You are a professional newsletter curator. Given a set of analyzed articles
(already ranked by relevance), produce a polished newsletter digest.

Select the best 5-7 items from the provided articles. Skip any with a relevance score below 3.

Your output should be a complete newsletter in markdown format with:

1. **Subject line** -- a catchy, specific subject line (not generic clickbait)
2. **Intro paragraph** -- 2-3 sentences setting the theme and tone
3. **Items** -- for each selected article:
   - Title (as a heading)
   - 2-3 sentence summary of what it covers and why it matters
   - A "Why it matters" line with broader context or implications
   - Source link
4. **Closing** -- a brief sign-off with a call to action (share, reply, subscribe, etc.)

Style guidelines:
- Write in a conversational but professional tone
- Each item summary should tell the reader WHY they should care
- Vary your sentence structure -- do not start every item the same way
- Use specific details and numbers when available
- Keep the total newsletter under 1000 words
- Do not use em dashes -- use double hyphens instead if you need a pause

If a topic is specified, frame the newsletter around that theme.`;

async function curateNewsletter(
  client: OpenAI,
  model: string,
  articles: AnalyzedArticle[],
  topic: string | null,
): Promise<string> {
  log("📝", "Curating newsletter digest...");

  const articleData = articles
    .filter((a) => a.relevance_score >= 1)
    .map((article, i) => ({
      rank: i + 1,
      title: article.title,
      url: article.url,
      summary: article.summary,
      key_points: article.key_points,
      relevance_score: article.relevance_score,
      relevance_reason: article.relevance_reason,
      category: article.category,
    }));

  let userContent = `Here are the analyzed articles, ranked by relevance:\n\n${JSON.stringify(articleData, null, 2)}`;
  if (topic) {
    userContent += `\n\nNewsletter topic/theme: ${topic}`;
  }

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: CURATION_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0.7,
  });

  return response.choices[0].message.content || "";
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const urls: string[] = [];
  let topic: string | null = null;
  let output: string | null = null;
  let urlsFile: string | null = null;

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--topic" && i + 1 < args.length) {
      topic = args[i + 1];
      i += 2;
    } else if (args[i] === "--output" && i + 1 < args.length) {
      output = args[i + 1];
      i += 2;
    } else if (args[i] === "--urls" && i + 1 < args.length) {
      urlsFile = args[i + 1];
      i += 2;
    } else {
      urls.push(args[i]);
      i++;
    }
  }

  // Load URLs from file if specified
  if (urlsFile) {
    try {
      const fileContent = readFileSync(urlsFile, "utf8");
      for (const line of fileContent.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          urls.push(trimmed);
        }
      }
    } catch {
      console.error(`❌ URLs file not found: ${urlsFile}`);
      process.exit(1);
    }
  }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of urls) {
    if (!seen.has(url)) {
      seen.add(url);
      unique.push(url);
    }
  }

  return { urls: unique, topic, output };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const { urls, topic, output } = parseArgs();
  const model = process.env.MODEL || "gpt-4o-mini";

  if (urls.length === 0) {
    console.error("❌ No URLs provided.");
    console.error("   Usage: npx tsx index.ts URL1 URL2 URL3");
    console.error("   Or:    npx tsx index.ts --urls urls.txt");
    process.exit(1);
  }

  log("🚀", "Starting Newsletter Curator...");
  log("📋", `Processing ${urls.length} URLs`);
  if (topic) {
    log("🏷️", `Topic: ${topic}`);
  }
  log("🤖", `Model: ${model}`);
  console.log();

  try {
    // Phase 1: Fetch all URLs via Reader
    const articles = await fetchAllUrls(urls);
    console.log();

    // Phase 2: Extract and rank content
    const client = new OpenAI();
    const analyzed = await extractAll(client, model, articles, topic);
    console.log();

    // Phase 3: Curate the newsletter
    const newsletter = await curateNewsletter(client, model, analyzed, topic);

    // Output
    console.log("\n" + "=".repeat(60));
    log("✅", "Newsletter ready!\n");
    console.log(newsletter);

    if (output) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(output, newsletter, "utf8");
      log("💾", `Saved to ${output}`);
    }
  } catch (e) {
    console.error(`\n❌ Error: ${e}`);
    process.exit(1);
  }
}

main().catch(console.error);
