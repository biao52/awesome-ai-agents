/**
 * Lead Enrichment Agent -- Takes one or more company website URLs, reads
 * multiple pages per company via Reader, and uses Claude to extract structured
 * company intelligence including products, pricing, team, tech stack, and
 * contact info.
 *
 * This agent uses Reader (https://reader.dev) to convert web pages to clean
 * markdown. The free endpoint at r.reader.dev requires no API key or signup.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const READER_BASE_URL = "https://r.reader.dev/";
const MAX_CONTENT_LENGTH = 40_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

/** Common paths to try on each company website. */
const COMPANY_PATHS = [
  "/",
  "/about",
  "/about-us",
  "/pricing",
  "/team",
  "/careers",
  "/jobs",
  "/contact",
  "/products",
  "/services",
];

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
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
// Types
// ---------------------------------------------------------------------------

interface ProductInfo {
  name: string;
  description: string;
  category: string;
}

interface PricingTier {
  name: string;
  price: string;
  highlights: string[];
}

interface PricingInfo {
  model: string;
  tiers: PricingTier[];
}

interface KeyPerson {
  name: string;
  role: string;
}

interface TeamIndicators {
  team_size_estimate: string;
  key_people: KeyPerson[];
  hiring: boolean;
}

interface ContactInfo {
  email: string | null;
  phone: string | null;
  address: string | null;
  demo_url: string | null;
}

interface SocialMedia {
  twitter: string | null;
  linkedin: string | null;
  github: string | null;
  youtube: string | null;
  other: string[];
}

interface FundingIndicators {
  stage: string;
  investors: string[];
  signals: string[];
}

interface CompanyData {
  company_name: string;
  description: string;
  industry: string;
  products_and_services: ProductInfo[];
  pricing: PricingInfo;
  team_indicators: TeamIndicators;
  technology_stack: string[];
  contact: ContactInfo;
  social_media: SocialMedia;
  funding_indicators: FundingIndicators;
  website: string;
  _error?: string;
  _raw_output?: string;
}

// ---------------------------------------------------------------------------
// Reader -- fetch pages as markdown
// ---------------------------------------------------------------------------

/**
 * Fetch a single page as clean markdown using Reader.
 *
 * Reader (reader.dev) converts any web page into clean, readable markdown.
 * The r.reader.dev endpoint is free and requires no API key.
 *
 * Returns null if the page cannot be fetched (404, timeout, etc.).
 */
async function readPage(url: string): Promise<string | null> {
  const readerUrl = `${READER_BASE_URL}${url}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(readerUrl, {
        headers: {
          Accept: "text/markdown",
          "User-Agent": "LeadEnrichmentAgent/1.0",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // Gracefully handle pages that don't exist
      if ([404, 403, 410].includes(response.status)) {
        return null;
      }

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }

      if (!response.ok) {
        return null;
      }

      let content = (await response.text()).trim();

      if (!content) {
        return null;
      }

      if (content.length > MAX_CONTENT_LENGTH) {
        content =
          content.slice(0, MAX_CONTENT_LENGTH) + "\n\n[Content truncated]";
      }

      return content;
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      return null;
    }
  }

  return null;
}

/** Normalize a company URL to its base domain. */
function normalizeBaseUrl(url: string): string {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Read multiple pages for a single company in parallel.
 *
 * Tries common paths (homepage, about, pricing, etc.) and returns a map
 * of path names to their markdown content. Pages that return 404 or fail
 * to load are silently skipped.
 */
async function readCompanyPages(
  baseUrl: string
): Promise<Record<string, string>> {
  const pages: Record<string, string> = {};
  const base = baseUrl.replace(/\/+$/, "");

  const urls = COMPANY_PATHS.map((path) => `${base}${path}`);
  const results = await Promise.all(urls.map((u) => readPage(u)));

  for (let i = 0; i < COMPANY_PATHS.length; i++) {
    const content = results[i];
    if (content !== null) {
      pages[COMPANY_PATHS[i]] = content;
      log(
        "  ",
        `  Read ${base}${COMPANY_PATHS[i]} (${content.length.toLocaleString()} chars)`
      );
    }
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Claude -- extract structured company data
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a lead enrichment expert. Given markdown content scraped from multiple pages of a company's website, you extract comprehensive, structured data about the company.

Your output must be a single JSON object with these fields:

{
  "company_name": "string",
  "description": "string (2-3 sentence summary of what the company does)",
  "industry": "string (e.g., 'Developer Tools', 'FinTech', 'Healthcare')",
  "products_and_services": [
    {
      "name": "string",
      "description": "string (1 sentence)",
      "category": "string (e.g., 'SaaS', 'API', 'Platform', 'Consulting')"
    }
  ],
  "pricing": {
    "model": "string (e.g., 'freemium', 'subscription', 'usage-based', 'enterprise', 'unknown')",
    "tiers": [
      {
        "name": "string",
        "price": "string (e.g., '$29/mo', 'Custom', 'Free')",
        "highlights": ["string"]
      }
    ]
  },
  "team_indicators": {
    "team_size_estimate": "string (e.g., '10-50', '50-200', 'unknown')",
    "key_people": [
      {
        "name": "string",
        "role": "string"
      }
    ],
    "hiring": "boolean (true if actively hiring)"
  },
  "technology_stack": ["string (technologies mentioned on site, job postings, etc.)"],
  "contact": {
    "email": "string or null",
    "phone": "string or null",
    "address": "string or null",
    "demo_url": "string or null (link to schedule a demo or sales call)"
  },
  "social_media": {
    "twitter": "string or null",
    "linkedin": "string or null",
    "github": "string or null",
    "youtube": "string or null",
    "other": ["string"]
  },
  "funding_indicators": {
    "stage": "string (e.g., 'Seed', 'Series A', 'Public', 'Bootstrapped', 'unknown')",
    "investors": ["string"],
    "signals": ["string (any mentions of funding, revenue, growth)"]
  },
  "website": "string (the company URL)"
}

Rules:
- Output ONLY valid JSON. No markdown, no explanation, no code fences.
- Use null for fields where no data is available. Do not guess or hallucinate.
- For arrays, use an empty array [] when no items are found.
- Extract only what is actually present in the page content.
- If a pricing page was not available, set pricing.model to "unknown" and tiers to [].
- Technology stack should include languages, frameworks, cloud providers, and tools mentioned.
- For team_size_estimate, infer from team pages, about pages, or job posting volume.
- Social media links should be full URLs when found, null otherwise.`;

/**
 * Send all page content to Claude and extract structured company data.
 */
async function extractCompanyData(
  pages: Record<string, string>,
  baseUrl: string,
  model: string
): Promise<CompanyData> {
  const client = new Anthropic();

  // Build a combined document from all pages
  let combined = `Company website: ${baseUrl}\n\n`;
  for (const [path, content] of Object.entries(pages)) {
    combined += `=== PAGE: ${path} ===\n${content}\n\n`;
  }

  const maxCombined = 150_000;
  if (combined.length > maxCombined) {
    combined =
      combined.slice(0, maxCombined) + "\n\n[Content truncated for length]";
  }

  const userMessage = `Analyze the following company website pages and extract structured company intelligence.

${combined}

Extract all available data into the JSON schema described in your instructions. Be thorough but only include data that is actually present in the content above.`;

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

      // Strip markdown code fences if present
      result = result.trim();
      if (result.startsWith("```json")) result = result.slice(7);
      if (result.startsWith("```")) result = result.slice(3);
      if (result.endsWith("```")) result = result.slice(0, -3);
      result = result.trim();

      try {
        const parsed = JSON.parse(result) as CompanyData;
        const tokensIn = response.usage.input_tokens;
        const tokensOut = response.usage.output_tokens;
        log(
          "  ",
          `  Tokens: ${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out`
        );
        return parsed;
      } catch {
        if (attempt < MAX_RETRIES) {
          log(
            "  ",
            `  Invalid JSON (attempt ${attempt}/${MAX_RETRIES}), retrying...`
          );
          continue;
        }
        return {
          company_name: baseUrl,
          description: "Failed to extract structured data.",
          website: baseUrl,
          _error: "Claude returned invalid JSON after all attempts.",
          _raw_output: result.slice(0, 500),
        } as CompanyData;
      }
    } catch (e) {
      const errorStr = String(e).toLowerCase();
      const isTransient =
        errorStr.includes("rate") ||
        errorStr.includes("overloaded") ||
        String(e).includes("529");

      if (attempt < MAX_RETRIES && isTransient) {
        const wait = Math.pow(2, attempt);
        log(
          "  ",
          `  API error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${wait}s...`
        );
        await sleep(wait * 1000);
      } else {
        throw e;
      }
    }
  }

  throw new Error("Max retries exceeded during extraction");
}

// ---------------------------------------------------------------------------
// Enrichment pipeline
// ---------------------------------------------------------------------------

/** Full enrichment pipeline for a single company URL. */
async function enrichCompany(
  baseUrl: string,
  model: string
): Promise<CompanyData> {
  log("🏢", `Enriching: ${baseUrl}`);

  // Step 1: Read multiple pages via Reader
  log("📖", "Reading pages via Reader...");
  const pages = await readCompanyPages(baseUrl);

  if (Object.keys(pages).length === 0) {
    log("  ", "  No pages could be read. Skipping.");
    return {
      company_name: baseUrl,
      description: "Could not read any pages from this website.",
      website: baseUrl,
      _error: "No pages were accessible.",
    } as CompanyData;
  }

  log("  ", `  Successfully read ${Object.keys(pages).length} page(s)`);

  // Step 2: Extract structured data with Claude
  log("🤖", "Extracting company intelligence with Claude...");
  const data = await extractCompanyData(pages, baseUrl, model);

  // Ensure website field is always set
  if (!data.website) {
    data.website = baseUrl;
  }

  log("  ", `  Extracted: ${data.company_name || "Unknown"}`);

  const productsCount = data.products_and_services?.length ?? 0;
  const tiersCount = data.pricing?.tiers?.length ?? 0;
  const peopleCount = data.team_indicators?.key_people?.length ?? 0;
  const techCount = data.technology_stack?.length ?? 0;

  log(
    "  ",
    `  Products: ${productsCount}, Pricing tiers: ${tiersCount}, People: ${peopleCount}, Tech: ${techCount}`
  );

  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let outputFile: string | null = null;
  const urls: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && i + 1 < args.length) {
      outputFile = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts <URL> [URL...] [OPTIONS]");
      console.log();
      console.log("Arguments:");
      console.log(
        "  URL              One or more company website URLs to enrich"
      );
      console.log();
      console.log("Options:");
      console.log("  --output FILE    Save enrichment JSON to a file");
      console.log();
      console.log("Examples:");
      console.log('  npx tsx index.ts "https://stripe.com"');
      console.log(
        '  npx tsx index.ts "https://stripe.com" "https://vercel.com" --output leads.json'
      );
      console.log();
      console.log("Environment:");
      console.log("  ANTHROPIC_API_KEY    Required. Your Anthropic API key.");
      console.log(
        "  MODEL                Optional. Default: claude-sonnet-4-20250514"
      );
      process.exit(0);
    } else {
      urls.push(args[i]);
    }
  }

  if (urls.length === 0) {
    console.error("Please provide at least one company URL.");
    console.error('Example: npx tsx index.ts "https://stripe.com"');
    process.exit(1);
  }

  // Normalize all URLs
  const normalized = urls.map(normalizeBaseUrl);

  log("🚀", "Starting lead enrichment agent...");
  log("🤖", `Model: ${model}`);
  log("🏢", `Companies: ${normalized.length}`);
  for (const u of normalized) {
    log("  ", `  ${u}`);
  }
  console.error();

  // Enrich each company sequentially to avoid rate limits
  const results: CompanyData[] = [];
  for (let idx = 0; idx < normalized.length; idx++) {
    log("", `[${idx + 1}/${normalized.length}]`);
    try {
      const data = await enrichCompany(normalized[idx], model);
      results.push(data);
    } catch (e) {
      log("  ", `  Error enriching ${normalized[idx]}: ${e}`);
      results.push({
        company_name: normalized[idx],
        website: normalized[idx],
        _error: String(e),
      } as CompanyData);
    }
    console.error();
  }

  log("✅", `Enrichment complete! ${results.length} company/companies processed.`);
  console.error();

  // Output JSON to stdout
  const output = results.length > 1 ? results : results[0];
  const outputJson = JSON.stringify(output, null, 2);
  console.log(outputJson);

  if (outputFile) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputFile, outputJson + "\n", "utf8");
    log("💾", `Saved to ${outputFile}`);
  }
}

main().catch(console.error);
