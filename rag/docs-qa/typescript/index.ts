/**
 * Documentation Q&A -- Crawl any docs site via Reader, build a RAG index,
 * and answer questions interactively.
 *
 * Usage:
 *   npx tsx index.ts --url "https://docs.example.com"
 */

import "dotenv/config";
import * as readline from "node:readline";
import { ChromaClient, type Collection } from "chromadb";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL = process.env.MODEL ?? "gpt-4o-mini";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const READER_API_URL = "https://api.reader.dev/v1/read";
const TEMPERATURE = 0.3;
const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 64;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const TOP_K = 5;
const CONCURRENCY = 5;

let maxPages = 20;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string, level: string = "INFO"): void {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  process.stderr.write(`[${timestamp}] [${level}] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY environment variable is required.");
    console.error("Copy .env.example to .env and add your key.");
    process.exit(1);
  }
  const readerKey = process.env.READER_API_KEY;
  if (!readerKey) {
    console.error("Error: READER_API_KEY environment variable is required.");
    console.error("Get your Reader API key at https://reader.dev");
    process.exit(1);
  }
  return apiKey;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function getDomain(url: string): string {
  const parsed = new URL(url);
  return parsed.hostname;
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  return `${parsed.protocol}//${parsed.hostname}${path}`;
}

function isSameDomain(url: string, domain: string): boolean {
  try {
    return getDomain(url) === domain;
  } catch {
    return false;
  }
}

function isDocLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const skipExtensions = [
      ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
      ".css", ".js", ".woff", ".woff2", ".ttf", ".eot",
      ".pdf", ".zip", ".tar", ".gz",
    ];
    if (skipExtensions.some((ext) => path.endsWith(ext))) {
      return false;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reader integration
// ---------------------------------------------------------------------------

async function readPage(url: string): Promise<string | null> {

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(READER_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.READER_API_KEY}`,
        },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) {
        const respData = await response.json() as { data: { markdown: string } };
        const content = (respData.data.markdown || "").trim();
        return content || null;
      }

      if (response.status === 429) {
        const wait = RETRY_DELAY_MS * (attempt + 1) * 2;
        log(`Rate limited, waiting ${wait}ms...`, "WARN");
        await sleep(wait);
        continue;
      }

      log(`Reader returned ${response.status} for ${url}`, "WARN");
      return null;
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        log(`Request error (attempt ${attempt + 1}): ${err}`, "WARN");
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      } else {
        log(`Failed to read ${url} after ${MAX_RETRIES} attempts`, "ERROR");
        return null;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

function extractLinks(markdown: string, baseUrl: string, domain: string): string[] {
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  const seen = new Set<string>();
  const links: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(markdown)) !== null) {
    let href = match[2];

    // Skip anchor-only links
    if (href.startsWith("#")) continue;

    // Resolve relative URLs
    if (!href.startsWith("http://") && !href.startsWith("https://")) {
      try {
        href = new URL(href, baseUrl).href;
      } catch {
        continue;
      }
    }

    // Strip fragment
    href = href.split("#")[0];
    if (!href) continue;

    let normalized: string;
    try {
      normalized = normalizeUrl(href);
    } catch {
      continue;
    }

    if (seen.has(normalized)) continue;
    seen.add(normalized);

    if (isSameDomain(normalized, domain) && isDocLink(normalized)) {
      links.push(normalized);
    }
  }

  return links;
}

// ---------------------------------------------------------------------------
// Crawling
// ---------------------------------------------------------------------------

interface Page {
  url: string;
  content: string;
}

async function crawlDocs(startUrl: string): Promise<Page[]> {
  const domain = getDomain(startUrl);
  log(`Starting crawl from ${startUrl} (domain: ${domain})`);

  const pages: Page[] = [];
  const visited = new Set<string>([normalizeUrl(startUrl)]);

  // Step 1: Read the start page
  log("Reading start page...");
  const startContent = await readPage(startUrl);
  if (!startContent) {
    log("Failed to read the start page. Check the URL and try again.", "ERROR");
    process.exit(1);
  }

  pages.push({ url: startUrl, content: startContent });
  log(`Start page loaded (${startContent.length} chars)`);

  // Step 2: Extract links
  const discoveredLinks = extractLinks(startContent, startUrl, domain);
  log(`Found ${discoveredLinks.length} same-domain links`);

  // Deduplicate against visited
  const toVisit = discoveredLinks
    .filter((link) => !visited.has(normalizeUrl(link)))
    .slice(0, maxPages - 1);

  log(`Will read ${toVisit.length} linked pages (max ${maxPages} total)`);

  // Mark all as visited
  for (const link of toVisit) {
    visited.add(normalizeUrl(link));
  }

  // Step 3: Read pages in parallel with concurrency limit
  const total = toVisit.length;
  let completed = 0;

  async function readWithLimit(url: string, index: number): Promise<Page | null> {
    log(`Reading page ${index + 1}/${total}: ${url}`);
    const content = await readPage(url);
    completed++;
    if (content) {
      return { url, content };
    }
    return null;
  }

  // Process in batches to respect concurrency
  for (let i = 0; i < toVisit.length; i += CONCURRENCY) {
    const batch = toVisit.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((url, j) => readWithLimit(url, i + j))
    );
    for (const result of results) {
      if (result) {
        pages.push(result);
      }
    }
  }

  log(`Crawl complete: ${pages.length} pages loaded`);
  return pages;
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

function chunkText(
  text: string,
  chunkSize: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = start + chunkSize;
    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    start += chunkSize - overlap;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

async function buildVectorStore(
  pages: Page[],
  client: OpenAI
): Promise<Collection> {
  log("Building vector store...");

  const chroma = new ChromaClient();
  try {
    await chroma.deleteCollection({ name: "docs" });
  } catch {
    // Collection may not exist yet
  }
  const collection = await chroma.createCollection({
    name: "docs",
    metadata: { "hnsw:space": "cosine" },
  });

  const allChunks: string[] = [];
  const allIds: string[] = [];
  const allMetadata: Array<{ url: string; chunk_index: string }> = [];

  for (const page of pages) {
    const chunks = chunkText(page.content);
    for (let i = 0; i < chunks.length; i++) {
      allChunks.push(chunks[i]);
      allIds.push(`${page.url}::chunk_${i}`);
      allMetadata.push({ url: page.url, chunk_index: String(i) });
    }
  }

  log(`Created ${allChunks.length} chunks from ${pages.length} pages`);

  // Embed in batches
  const batchSize = 100;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < allChunks.length; i += batchSize) {
    const batch = allChunks.slice(i, i + batchSize);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await client.embeddings.create({
          model: EMBEDDING_MODEL,
          input: batch,
        });
        for (const item of response.data) {
          allEmbeddings.push(item.embedding);
        }
        break;
      } catch (err) {
        if (attempt < MAX_RETRIES - 1) {
          log(`Embedding API error (attempt ${attempt + 1}): ${err}`, "WARN");
          await sleep(RETRY_DELAY_MS * (attempt + 1));
        } else {
          throw err;
        }
      }
    }
  }

  await collection.add({
    ids: allIds,
    documents: allChunks,
    embeddings: allEmbeddings,
    metadatas: allMetadata,
  });

  log(`Indexed ${allChunks.length} chunks into vector store`);
  return collection;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function searchDocs(
  query: string,
  collection: Collection,
  client: OpenAI
): Promise<string> {
  let queryEmbedding: number[];
  try {
    const embeddingResp = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: query,
    });
    queryEmbedding = embeddingResp.data[0].embedding;
  } catch (err) {
    return `Error generating query embedding: ${err}`;
  }

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: TOP_K,
  });

  if (!results.documents?.[0]?.length) {
    return "No relevant documentation found.";
  }

  const chunks = results.documents[0];
  const metadatas = results.metadatas?.[0] ?? [];
  const distances = results.distances?.[0] ?? [];

  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const source =
      metadatas[i] && typeof metadatas[i] === "object"
        ? (metadatas[i] as Record<string, string>).url ?? "Unknown"
        : "Unknown";
    const dist = i < distances.length ? ` (distance: ${distances[i].toFixed(3)})` : "";
    parts.push(`--- Source: ${source}${dist} ---\n${chunks[i]}`);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Q&A loop
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a helpful documentation assistant. You answer questions based on \
the documentation that has been indexed from a docs site.

When answering:
- Base your answers strictly on the provided documentation context
- Cite the source URL when referencing specific information
- If the context does not contain enough information to answer, say so honestly
- Keep answers clear and concise
- Use code examples from the docs when relevant`;

async function answerQuestion(
  question: string,
  collection: Collection,
  client: OpenAI,
  conversation: ChatCompletionMessageParam[]
): Promise<string> {
  const context = await searchDocs(question, collection, client);
  log(`Retrieved ${context.length} chars of context`);

  const userMessage =
    `Documentation context:\n\n${context}\n\n` +
    `Question: ${question}\n\n` +
    `Answer based on the documentation above.`;

  conversation.push({ role: "user", content: userMessage });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        messages: conversation,
      });
      const answer = response.choices[0].message.content ?? "";
      conversation.push({ role: "assistant", content: answer });
      return answer;
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        log(`Chat API error (attempt ${attempt + 1}): ${err}`, "WARN");
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      } else {
        const errorMsg = `Sorry, I encountered an API error: ${err}`;
        conversation.push({ role: "assistant", content: errorMsg });
        return errorMsg;
      }
    }
  }

  return "Unexpected error.";
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { url: string; maxPages: number } {
  const args = process.argv.slice(2);
  let url = "";
  let pages = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && i + 1 < args.length) {
      url = args[i + 1];
      i++;
    } else if (args[i] === "--max-pages" && i + 1 < args.length) {
      pages = parseInt(args[i + 1], 10);
      i++;
    }
  }

  if (!url) {
    console.error('Usage: npx tsx index.ts --url "https://docs.example.com"');
    process.exit(1);
  }

  return { url, maxPages: pages };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { url, maxPages: mp } = parseArgs();
  const apiKey = validateEnv();
  maxPages = mp;

  const client = new OpenAI({ apiKey });

  // Phase 1: Crawl
  console.log("\n=== Documentation Q&A ===");
  console.log(`Crawling: ${url}`);
  console.log(`Max pages: ${maxPages}\n`);

  const pages = await crawlDocs(url);

  if (pages.length === 0) {
    console.log("No pages were loaded. Exiting.");
    process.exit(1);
  }

  // Phase 2: Index
  const collection = await buildVectorStore(pages, client);

  // Phase 3: Interactive Q&A
  const conversation: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  console.log(`\nReady! ${pages.length} pages indexed.`);
  console.log("Ask questions about the documentation.");
  console.log("Type 'quit' or 'exit' to end the session.\n");

  while (true) {
    let userInput: string;
    try {
      userInput = (await prompt("You: ")).trim();
    } catch {
      console.log("\nGoodbye!");
      break;
    }

    if (!userInput) continue;
    if (userInput.toLowerCase() === "quit" || userInput.toLowerCase() === "exit") {
      console.log("Goodbye!");
      break;
    }

    const answer = await answerQuestion(userInput, collection, client, conversation);
    console.log(`\nAssistant: ${answer}\n`);
  }

  rl.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
