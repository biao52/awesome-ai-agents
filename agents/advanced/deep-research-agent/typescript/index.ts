/**
 * Deep Research Agent -- Multi-step research agent that decomposes questions,
 * executes parallel web searches, evaluates source credibility, identifies gaps,
 * and produces comprehensive reports with citations and cost tracking.
 *
 * Uses Anthropic Claude (Sonnet for reasoning, Haiku for extraction) and Tavily for search.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_REASONING_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_EXTRACTION_MODEL = "claude-haiku-4-5-20251001";
const MAX_SOURCES_PER_QUESTION = 5;
const MAX_FOLLOW_UP_ROUNDS = 2;
const MAX_PAGE_LENGTH = 8000;
const REQUEST_TIMEOUT_MS = 20_000;

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
};

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY", "TAVILY_API_KEY"];
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
// Token and cost tracking
// ---------------------------------------------------------------------------

class UsageTracker {
  inputTokens: Record<string, number> = {};
  outputTokens: Record<string, number> = {};

  add(model: string, inputToks: number, outputToks: number): void {
    this.inputTokens[model] = (this.inputTokens[model] || 0) + inputToks;
    this.outputTokens[model] = (this.outputTokens[model] || 0) + outputToks;
  }

  totalCost(): number {
    let cost = 0;
    const models = new Set([
      ...Object.keys(this.inputTokens),
      ...Object.keys(this.outputTokens),
    ]);
    for (const model of models) {
      const pricing = PRICING[model] || { input: 3.0, output: 15.0 };
      const inp = this.inputTokens[model] || 0;
      const out = this.outputTokens[model] || 0;
      cost += (inp / 1_000_000) * pricing.input;
      cost += (out / 1_000_000) * pricing.output;
    }
    return cost;
  }

  summary(): string {
    const lines = ["Token Usage:"];
    const models = [
      ...new Set([
        ...Object.keys(this.inputTokens),
        ...Object.keys(this.outputTokens),
      ]),
    ].sort();
    for (const model of models) {
      const inp = this.inputTokens[model] || 0;
      const out = this.outputTokens[model] || 0;
      lines.push(
        `  ${model}: ${inp.toLocaleString()} input + ${out.toLocaleString()} output`
      );
    }
    lines.push(`  Estimated cost: $${this.totalCost().toFixed(4)}`);
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Web search and page reading
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchWeb(
  query: string,
  maxResults: number = MAX_SOURCES_PER_QUESTION
): Promise<SearchResult[]> {
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: maxResults,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Tavily: ${response.status}`);
    const data = (await response.json()) as {
      results: Array<{ title: string; url: string; content: string }>;
    };
    return (data.results || []).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.content || "",
    }));
  } catch (e) {
    log("⚠️", `Search failed for '${query}': ${e}`);
    return [];
  }
}

async function readPage(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; DeepResearchAgent/1.0)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return `[Error: HTTP ${response.status}]`;
    const text = await response.text();
    return text.slice(0, MAX_PAGE_LENGTH);
  } catch (e) {
    return `[Error reading page: ${e}]`;
  }
}

// ---------------------------------------------------------------------------
// LLM helpers
// ---------------------------------------------------------------------------

async function callLLM(
  client: Anthropic,
  model: string,
  system: string,
  userMessage: string,
  tracker: UsageTracker,
  maxTokens: number = 4096,
  temperature: number = 0.3
): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userMessage }],
    temperature,
  });
  tracker.add(model, response.usage.input_tokens, response.usage.output_tokens);
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => {
      if (b.type === "text") return b.text;
      return "";
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Research phases
// ---------------------------------------------------------------------------

async function planResearch(
  client: Anthropic,
  topic: string,
  model: string,
  tracker: UsageTracker
): Promise<string[]> {
  const system = `You are a research planning expert. Given a topic, decompose it into 5-8 specific, searchable sub-questions that together provide comprehensive coverage.

Output ONLY a JSON array of strings. No explanation, no markdown.
Example: ["What is X?", "How does Y work?", "What are the benefits of Z?"]`;

  let result = await callLLM(client, model, system, `Topic: ${topic}`, tracker);
  result = result.trim();
  if (result.startsWith("```")) {
    result = result.split("\n").slice(1).join("\n").replace(/```\s*$/, "");
  }

  try {
    const questions = JSON.parse(result);
    if (Array.isArray(questions)) return questions.map(String);
  } catch {
    // Fallback
  }
  return result
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.replace(/^[\d.\-)\s]+/, "").trim());
}

interface ResearchResult {
  question: string;
  findings: string[];
  sources: Array<{ title: string; url: string }>;
  credibility: string;
}

async function researchSubQuestion(
  client: Anthropic,
  question: string,
  extractionModel: string,
  tracker: UsageTracker
): Promise<ResearchResult> {
  log("🌐", `Researching: ${question}`);

  const searchResults = await searchWeb(question);
  if (searchResults.length === 0) {
    return { question, findings: [], sources: [], credibility: "low" };
  }

  log("   ", `Found ${searchResults.length} results, reading top pages...`);

  const pageContents = await Promise.all(
    searchResults.slice(0, 3).map((r) => readPage(r.url))
  );

  let sourcesText = "";
  const sources: Array<{ title: string; url: string }> = [];
  searchResults.slice(0, 3).forEach((r, i) => {
    sourcesText += `\n--- Source ${i + 1}: ${r.title} (${r.url}) ---\n${pageContents[i]}\n`;
    sources.push({ title: r.title, url: r.url });
  });

  const system = `You are a research extraction expert. Given web sources and a question, extract the key findings.

Output a JSON object with:
- "findings": array of strings, each a specific fact/insight from the sources
- "credibility": "high", "medium", or "low" based on source quality

Be specific. Include data, dates, and numbers when available. Do NOT make up information.`;

  let extraction = await callLLM(
    client,
    extractionModel,
    system,
    `Question: ${question}\n\nSources:\n${sourcesText}`,
    tracker,
    2048
  );

  try {
    extraction = extraction.trim();
    if (extraction.startsWith("```")) {
      extraction = extraction.split("\n").slice(1).join("\n").replace(/```\s*$/, "");
    }
    const parsed = JSON.parse(extraction);
    const findings = parsed.findings || [];
    const credibility = parsed.credibility || "medium";
    log("   ", `Extracted ${findings.length} findings (credibility: ${credibility})`);
    return { question, findings, sources, credibility };
  } catch {
    log("   ", "Extracted findings (raw format)");
    return { question, findings: [extraction], sources, credibility: "medium" };
  }
}

async function identifyGaps(
  client: Anthropic,
  topic: string,
  results: ResearchResult[],
  model: string,
  tracker: UsageTracker
): Promise<string[]> {
  const summary = JSON.stringify(
    results.map((r) => ({
      question: r.question,
      findings_count: r.findings.length,
    })),
    null,
    2
  );

  const system = `You are a research quality analyst. Given a topic and initial research results, identify 2-3 follow-up questions that would fill gaps in the research.

Output ONLY a JSON array of strings. If the research is comprehensive, return an empty array [].`;

  let result = await callLLM(
    client,
    model,
    system,
    `Topic: ${topic}\n\nResearch so far:\n${summary}`,
    tracker,
    1024
  );

  try {
    result = result.trim();
    if (result.startsWith("```")) {
      result = result.split("\n").slice(1).join("\n").replace(/```\s*$/, "");
    }
    const questions = JSON.parse(result);
    if (Array.isArray(questions)) return questions.slice(0, 3).map(String);
  } catch {
    // No follow-ups
  }
  return [];
}

async function synthesizeReport(
  client: Anthropic,
  topic: string,
  allResults: ResearchResult[],
  model: string,
  tracker: UsageTracker
): Promise<string> {
  const system = `You are an expert research report writer. Given research findings from multiple sub-questions, synthesize them into a comprehensive, well-structured markdown report.

Report structure:
1. Title (# heading)
2. Executive Summary (2-3 sentences)
3. Key Findings sections (## headings, organized by theme, not by sub-question)
4. Analysis and Implications
5. Sources (numbered list of all URLs referenced)

Rules:
- Cite sources inline as [1], [2], etc.
- Resolve contradictions between sources (note when sources disagree)
- Include specific data, dates, and numbers
- Write 2000-4000 words
- Be objective and balanced
- Note source credibility where relevant`;

  return callLLM(
    client,
    model,
    system,
    `Topic: ${topic}\n\nResearch Data:\n${JSON.stringify(allResults, null, 2)}`,
    tracker,
    8192,
    0.4
  );
}

// ---------------------------------------------------------------------------
// Main research pipeline
// ---------------------------------------------------------------------------

async function deepResearch(topic: string): Promise<string> {
  const client = new Anthropic();
  const tracker = new UsageTracker();
  const reasoningModel =
    process.env.REASONING_MODEL || DEFAULT_REASONING_MODEL;
  const extractionModel =
    process.env.EXTRACTION_MODEL || DEFAULT_EXTRACTION_MODEL;
  const maxFollowUps = parseInt(
    process.env.MAX_FOLLOW_UP_ROUNDS || String(MAX_FOLLOW_UP_ROUNDS)
  );

  const startTime = Date.now();

  // Phase 1: Plan
  log("📋", "Phase 1: Creating research plan...");
  const subQuestions = await planResearch(
    client,
    topic,
    reasoningModel,
    tracker
  );
  subQuestions.forEach((q, i) => log("   ", `${i + 1}. ${q}`));
  console.log();

  // Phase 2: Research (parallel)
  log("🔬", "Phase 2: Researching sub-questions in parallel...");
  const allResults: ResearchResult[] = await Promise.all(
    subQuestions.map((q) =>
      researchSubQuestion(client, q, extractionModel, tracker)
    )
  );
  console.log();

  // Phase 3: Follow-up research
  for (let round = 1; round <= maxFollowUps; round++) {
    log("🔄", `Phase 3: Follow-up round ${round}...`);
    const followUps = await identifyGaps(
      client,
      topic,
      allResults,
      reasoningModel,
      tracker
    );

    if (followUps.length === 0) {
      log("   ", "No gaps identified. Research is comprehensive.");
      break;
    }

    followUps.forEach((q) => log("   ", `Follow-up: ${q}`));
    const followUpResults = await Promise.all(
      followUps.map((q) =>
        researchSubQuestion(client, q, extractionModel, tracker)
      )
    );
    allResults.push(...followUpResults);
    console.log();
  }

  // Phase 4: Synthesize
  log("📝", "Phase 4: Synthesizing report...");
  const report = await synthesizeReport(
    client,
    topic,
    allResults,
    reasoningModel,
    tracker
  );

  const elapsed = (Date.now() - startTime) / 1000;
  const totalSources = allResults.reduce(
    (sum, r) => sum + r.sources.length,
    0
  );
  const totalFindings = allResults.reduce(
    (sum, r) => sum + r.findings.length,
    0
  );

  console.log();
  log("📊", "Research stats:");
  log(
    "   ",
    `Sub-questions: ${subQuestions.length} + ${allResults.length - subQuestions.length} follow-ups`
  );
  log("   ", `Sources consulted: ${totalSources}`);
  log("   ", `Findings extracted: ${totalFindings}`);
  log("   ", `Time: ${elapsed.toFixed(1)}s`);
  tracker
    .summary()
    .split("\n")
    .forEach((line) => log("   ", line));

  return report;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const args = process.argv.slice(2);
  let outputFile: string | null = null;
  const topicParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && i + 1 < args.length) {
      outputFile = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [TOPIC] [--output FILE]");
      console.log();
      console.log("Arguments:");
      console.log("  TOPIC          Research topic (prompts if not given)");
      console.log("  --output FILE  Save report to a file");
      console.log();
      console.log("Examples:");
      console.log(
        '  npx tsx index.ts "Impact of AI on drug discovery"'
      );
      console.log(
        '  npx tsx index.ts "Future of quantum computing" --output report.md'
      );
      process.exit(0);
    } else {
      topicParts.push(args[i]);
    }
  }

  let topic = topicParts.join(" ");
  if (!topic) {
    process.stdout.write(
      "🔬 What would you like to research in depth? "
    );
    topic = await new Promise<string>((resolve) => {
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

  if (!topic.trim()) {
    console.error("❌ Please provide a research topic.");
    process.exit(1);
  }

  log("🚀", "Starting deep research agent...");
  log("📋", `Topic: ${topic}`);
  console.log();

  try {
    const report = await deepResearch(topic);

    console.log("\n" + "=".repeat(60));
    log("✅", "Research complete!\n");
    console.log(report);

    if (outputFile) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputFile, report, "utf8");
      log("💾", `Report saved to ${outputFile}`);
    }
  } catch (e) {
    console.error(`\n❌ Error: ${e}`);
    process.exit(1);
  }
}

main().catch(console.error);
