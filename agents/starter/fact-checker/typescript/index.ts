/**
 * Fact-Checker Agent - Verifies claims by searching the web and reading sources.
 *
 * Uses Anthropic Claude for reasoning, Tavily for web search, and Reader for
 * reading source pages as clean markdown.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const READER_BASE_URL = "https://r.reader.dev";
const TAVILY_API_URL = "https://api.tavily.com/search";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY", "TAVILY_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

interface Source {
  url: string;
  title: string;
  snippet: string;
  content: string;
  credibility: string;
  relevance: string;
}

interface FactCheckResult {
  claim: string;
  verdict: string;
  confidence: string;
  summary: string;
  supportingEvidence: string[];
  contradictingEvidence: string[];
  sources: Source[];
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface AnalysisResponse {
  verdict: string;
  confidence: string;
  summary: string;
  supporting_evidence: string[];
  contradicting_evidence: string[];
  source_assessments: Array<{
    url: string;
    credibility: string;
    relevance: string;
  }>;
}

// ---------------------------------------------------------------------------
// Step 1: Search for relevant sources
// ---------------------------------------------------------------------------

async function searchForSources(
  claim: string,
  client: Anthropic,
  model: string,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  log("🧠", "Generating search queries for the claim...");

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content:
          `I need to fact-check this claim: "${claim}"\n\n` +
          "Generate 2-3 search queries that would help verify or debunk " +
          "this claim. Return ONLY a JSON array of query strings, nothing else.\n\n" +
          'Example: ["query one", "query two", "query three"]',
      },
    ],
  });

  const responseText =
    response.content[0].type === "text" ? response.content[0].text.trim() : "";

  let queries: string[];
  try {
    queries = JSON.parse(responseText) as string[];
    if (!Array.isArray(queries)) {
      queries = [claim];
    }
  } catch {
    queries = [claim];
  }

  log("🔍", `Search queries: ${JSON.stringify(queries)}`);

  const allResults: Array<{ title: string; url: string; snippet: string }> = [];
  const seenUrls = new Set<string>();

  for (const query of queries.slice(0, 3)) {
    try {
      const resp = await fetch(TAVILY_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          max_results: 5,
          include_raw_content: false,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        log("   ", `Search error for '${query}': ${resp.status} ${resp.statusText}`);
        continue;
      }

      const data = (await resp.json()) as { results: TavilyResult[] };

      for (const item of data.results || []) {
        const url = item.url || "";
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          allResults.push({
            title: item.title || "",
            url,
            snippet: item.content || "",
          });
        }
      }
    } catch (e) {
      log("   ", `Search error for '${query}': ${e}`);
    }
  }

  log("   ", `Found ${allResults.length} unique sources`);
  return allResults;
}

// ---------------------------------------------------------------------------
// Step 2: Read source pages using Reader
// ---------------------------------------------------------------------------

async function readSource(url: string): Promise<string> {
  /** Read a web page using Reader and return its markdown content. */
  const readerUrl = `${READER_BASE_URL}/${url}`;
  try {
    const resp = await fetch(readerUrl, {
      headers: {
        Accept: "text/markdown",
        "User-Agent": "FactCheckerAgent/1.0",
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      return `Error reading page: ${resp.status} ${resp.statusText}`;
    }

    const text = await resp.text();
    return text.slice(0, 8000);
  } catch (e) {
    return `Error reading page: ${e}`;
  }
}

async function readSources(
  searchResults: Array<{ title: string; url: string; snippet: string }>,
  maxSources: number = 5,
): Promise<Source[]> {
  /** Read the top sources in parallel using Reader. */
  const topResults = searchResults.slice(0, maxSources);
  log("📖", `Reading ${topResults.length} sources with Reader...`);

  const contentPromises = topResults.map((result) => readSource(result.url));
  const contents = await Promise.allSettled(contentPromises);

  const sources: Source[] = [];

  for (let i = 0; i < topResults.length; i++) {
    const result = topResults[i];
    const settled = contents[i];
    let content: string;

    if (settled.status === "fulfilled") {
      content = settled.value;
    } else {
      content = `Error: ${settled.reason}`;
    }

    const domain = result.url.split("/")[2] || result.url;
    const hasContent = !content.startsWith("Error");
    const status = hasContent ? "read" : "failed";
    log("   ", `[${status}] ${domain}`);

    sources.push({
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      content,
      credibility: "",
      relevance: "",
    });
  }

  return sources;
}

// ---------------------------------------------------------------------------
// Step 3: Analyze sources and determine verdict
// ---------------------------------------------------------------------------

const ANALYSIS_PROMPT = `You are a rigorous fact-checker. Analyze the following claim against the provided sources and produce a structured fact-check verdict.

CLAIM: "{claim}"

SOURCES:
{sources_text}

Analyze each source for relevance and credibility. Then determine your verdict.

Respond with ONLY a JSON object in this exact format:
{{
    "verdict": "TRUE" | "FALSE" | "PARTIALLY TRUE" | "UNVERIFIABLE",
    "confidence": "HIGH" | "MEDIUM" | "LOW",
    "summary": "A 2-3 sentence summary of your findings",
    "supporting_evidence": ["Evidence point 1 that supports the claim", "..."],
    "contradicting_evidence": ["Evidence point 1 that contradicts the claim", "..."],
    "source_assessments": [
        {{
            "url": "source url",
            "credibility": "HIGH | MEDIUM | LOW",
            "relevance": "HIGH | MEDIUM | LOW"
        }}
    ]
}}

Rules:
- Base your verdict ONLY on evidence found in the sources
- If sources conflict, weigh more credible sources higher
- If sources are insufficient to verify, use UNVERIFIABLE
- Be specific in your evidence points, citing facts and data
- Assess source credibility based on domain reputation and content quality`;

async function analyzeSources(
  claim: string,
  sources: Source[],
  client: Anthropic,
  model: string,
): Promise<FactCheckResult> {
  log("🧪", "Analyzing sources and determining verdict...");

  const sourcesTextParts: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const content = !source.content.startsWith("Error")
      ? source.content
      : source.snippet;
    sourcesTextParts.push(
      `--- Source ${i + 1} ---\nTitle: ${source.title}\nURL: ${source.url}\nContent:\n${content}\n`,
    );
  }

  const sourcesText = sourcesTextParts.join("\n");
  const prompt = ANALYSIS_PROMPT.replace("{claim}", claim).replace(
    "{sources_text}",
    sourcesText,
  );

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  let responseText =
    response.content[0].type === "text" ? response.content[0].text.trim() : "";

  let analysis: AnalysisResponse;
  try {
    // Handle markdown code block wrapping
    if (responseText.startsWith("```")) {
      const lines = responseText.split("\n");
      const jsonLines = lines.filter((l) => !l.startsWith("```"));
      responseText = jsonLines.join("\n");
    }
    analysis = JSON.parse(responseText) as AnalysisResponse;
  } catch {
    return {
      claim,
      verdict: "UNVERIFIABLE",
      confidence: "LOW",
      summary: "Analysis could not be completed due to a parsing error.",
      supportingEvidence: [],
      contradictingEvidence: [],
      sources,
    };
  }

  // Apply source assessments
  for (const assessment of analysis.source_assessments || []) {
    const source = sources.find((s) => s.url === assessment.url);
    if (source) {
      source.credibility = assessment.credibility || "MEDIUM";
      source.relevance = assessment.relevance || "MEDIUM";
    }
  }

  return {
    claim,
    verdict: analysis.verdict || "UNVERIFIABLE",
    confidence: analysis.confidence || "LOW",
    summary: analysis.summary || "",
    supportingEvidence: analysis.supporting_evidence || [],
    contradictingEvidence: analysis.contradicting_evidence || [],
    sources,
  };
}

// ---------------------------------------------------------------------------
// Step 4: Format and display the report
// ---------------------------------------------------------------------------

const VERDICT_EMOJI: Record<string, string> = {
  TRUE: "✅",
  FALSE: "❌",
  "PARTIALLY TRUE": "🟡",
  UNVERIFIABLE: "❓",
};

const CONFIDENCE_BAR: Record<string, string> = {
  HIGH: "███████████ HIGH",
  MEDIUM: "███████░░░░ MEDIUM",
  LOW: "████░░░░░░░ LOW",
};

function formatReport(result: FactCheckResult): string {
  const verdictEmoji = VERDICT_EMOJI[result.verdict] || "❓";
  const confidenceBar = CONFIDENCE_BAR[result.confidence] || "░░░░░░░░░░░ ???";

  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(64));
  lines.push("  FACT-CHECK REPORT");
  lines.push("=".repeat(64));
  lines.push("");
  lines.push(`  Claim: "${result.claim}"`);
  lines.push("");
  lines.push(`  Verdict:    ${verdictEmoji} ${result.verdict}`);
  lines.push(`  Confidence: ${confidenceBar}`);
  lines.push("");
  lines.push("-".repeat(64));
  lines.push("  Summary");
  lines.push("-".repeat(64));
  lines.push(`  ${result.summary}`);
  lines.push("");

  if (result.supportingEvidence.length > 0) {
    lines.push("-".repeat(64));
    lines.push("  Supporting Evidence");
    lines.push("-".repeat(64));
    result.supportingEvidence.forEach((evidence, i) => {
      lines.push(`  ${i + 1}. ${evidence}`);
    });
    lines.push("");
  }

  if (result.contradictingEvidence.length > 0) {
    lines.push("-".repeat(64));
    lines.push("  Contradicting Evidence");
    lines.push("-".repeat(64));
    result.contradictingEvidence.forEach((evidence, i) => {
      lines.push(`  ${i + 1}. ${evidence}`);
    });
    lines.push("");
  }

  lines.push("-".repeat(64));
  lines.push("  Sources");
  lines.push("-".repeat(64));
  result.sources.forEach((source, i) => {
    const cred = source.credibility ? ` (credibility: ${source.credibility})` : "";
    lines.push(`  [${i + 1}] ${source.title}${cred}`);
    lines.push(`      ${source.url}`);
  });
  lines.push("");
  lines.push("=".repeat(64));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Agent orchestration
// ---------------------------------------------------------------------------

async function factCheck(claim: string, model: string): Promise<FactCheckResult> {
  /** Run the full fact-checking pipeline on a claim. */
  const client = new Anthropic();

  // Step 1: Search for relevant sources
  const searchResults = await searchForSources(claim, client, model);

  if (searchResults.length === 0) {
    return {
      claim,
      verdict: "UNVERIFIABLE",
      confidence: "LOW",
      summary: "No relevant sources could be found for this claim.",
      supportingEvidence: [],
      contradictingEvidence: [],
      sources: [],
    };
  }

  // Step 2: Read the top sources using Reader
  const sources = await readSources(searchResults, 5);

  // Step 3: Analyze and produce verdict
  const result = await analyzeSources(claim, sources, client, model);

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || "claude-sonnet-4-20250514";
  const args = process.argv.slice(2);

  let claim = "";
  let outputFile: string | null = null;

  // Parse CLI args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && i + 1 < args.length) {
      outputFile = args[i + 1];
      i++;
    } else {
      claim += (claim ? " " : "") + args[i];
    }
  }

  // Interactive mode if no claim provided
  if (!claim) {
    process.stdout.write("🔎 Enter a claim to fact-check: ");
    claim = await new Promise<string>((resolve) => {
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        input += chunk;
        if (input.includes("\n")) {
          process.stdin.pause();
          resolve(input.trim());
        }
      });
      process.stdin.resume();
    });
  }

  if (!claim.trim()) {
    console.error("Please provide a claim to verify.");
    process.exit(1);
  }

  log("🚀", "Starting fact-checker agent...");
  log("📋", `Claim: "${claim}"`);
  log("🤖", `Model: ${model}`);
  console.log();

  try {
    const result = await factCheck(claim, model);
    const report = formatReport(result);
    console.log(report);

    if (outputFile) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputFile, report, "utf8");
      log("💾", `Report saved to ${outputFile}`);
    }
  } catch (e) {
    console.error(`\nError during fact-check: ${e}`);
    process.exit(1);
  }
}

main().catch(console.error);
