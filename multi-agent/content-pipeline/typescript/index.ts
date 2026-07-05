/**
 * Content Pipeline -- Multi-agent content creation system with
 * Researcher, Writer, and Editor agents in a sequential pipeline with revision loops.
 *
 * Uses Anthropic Claude for all agents and Tavily for web research.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_REVISION_ROUNDS = 2;
const REQUEST_TIMEOUT_MS = 20_000;

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
// Web research
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

async function searchWeb(
  query: string,
  maxResults: number = 5
): Promise<SearchResult[]> {
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: maxResults,
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
      content: r.content || "",
    }));
  } catch (e) {
    log("⚠️", `Search failed: ${e}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Agent base
// ---------------------------------------------------------------------------

async function callAgent(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 4096,
  temperature: number = 0.5
): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    temperature,
  });
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

const RESEARCHER_PROMPT = `You are a Research Specialist. Your job is to gather current, accurate information on a topic to support content creation.

Given a content brief, you must:
1. Identify 3-5 key aspects of the topic to research
2. Use the provided search results to extract relevant facts, statistics, quotes, and insights
3. Organize findings into a structured research brief

Output format:
## Research Brief

### Key Facts
- Bullet points of important facts with sources

### Statistics & Data
- Any relevant numbers, percentages, trends

### Expert Perspectives
- Notable quotes or viewpoints from the sources

### Current Context
- What's happening right now related to this topic

### Suggested Angles
- 2-3 angles the writer could take based on the research

Be factual. Cite sources. Do NOT make up statistics or quotes.`;

const WRITER_PROMPT = `You are a Professional Content Writer. You produce engaging, well-structured content tailored to a specific audience and format.

Given a content brief and research brief, you must:
1. Write content in the specified format and tone
2. Incorporate key facts and data from the research
3. Structure the content with clear headings and logical flow
4. Make it engaging and valuable for the target audience

Rules:
- Match the requested format (blog post, newsletter, tutorial, etc.)
- Match the requested tone (professional, casual, technical, etc.)
- Use research data to support claims (cite where natural)
- Include an introduction that hooks the reader
- Include a conclusion with a takeaway or call to action
- Write the requested length (default: 800-1200 words)
- Use subheadings to break up the content
- No fluff -- every paragraph should add value`;

const EDITOR_PROMPT = `You are a Senior Content Editor. You review content for quality, accuracy, clarity, and engagement.

Given the original content brief, research brief, and a draft, you must:
1. Check facts against the research brief (flag any unsupported claims)
2. Evaluate structure, flow, and readability
3. Check tone matches the brief's target audience
4. Identify weak sections that need strengthening
5. Provide specific, actionable feedback

Output format:
## Editorial Review

### Overall Assessment
Score: X/10
One paragraph summary of the draft quality.

### Accuracy Check
- List any factual issues or unsupported claims

### Structural Feedback
- Issues with flow, organization, or missing sections

### Style & Tone
- Does it match the audience? Any tone inconsistencies?

### Specific Line Edits
- "Original text" -> "Suggested revision" (with reason)

### Verdict
Either "APPROVED" or "NEEDS REVISION" with a summary of required changes.

Be constructive but honest. If the draft is good, say so. If it needs work, be specific about what to fix.`;

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function runPipeline(
  topic: string,
  audience: string,
  formatType: string,
  tone: string
): Promise<Record<string, string>> {
  const client = new Anthropic();
  const model = process.env.MODEL || DEFAULT_MODEL;
  const maxRounds = parseInt(
    process.env.MAX_REVISION_ROUNDS || String(MAX_REVISION_ROUNDS)
  );

  const contentBrief = `Topic: ${topic}
Target Audience: ${audience}
Format: ${formatType}
Tone: ${tone}
Length: 800-1200 words`;

  const artifacts: Record<string, string> = { content_brief: contentBrief };

  // Phase 1: Research
  log("🔬", "Phase 1: Researcher Agent gathering information...");
  const queries = [topic, `${topic} latest trends`, `${topic} statistics data`];
  const allResults: SearchResult[] = [];
  for (const query of queries) {
    const results = await searchWeb(query, 3);
    allResults.push(...results);
    log("   ", `Searched: '${query}' -> ${results.length} results`);
  }

  const searchData = allResults
    .map((r) => `- ${r.title}: ${r.content.slice(0, 300)} (${r.url})`)
    .join("\n");

  const researchBrief = await callAgent(
    client,
    model,
    RESEARCHER_PROMPT,
    `Content Brief:\n${contentBrief}\n\nSearch Results:\n${searchData}`,
    3000,
    0.3
  );
  artifacts.research_brief = researchBrief;
  log("✓", "Research brief complete");
  console.log();

  // Phase 2: Write first draft
  log("✍️", "Phase 2: Writer Agent creating first draft...");
  const draft = await callAgent(
    client,
    model,
    WRITER_PROMPT,
    `Content Brief:\n${contentBrief}\n\nResearch Brief:\n${researchBrief}`,
    4096,
    0.6
  );
  artifacts.first_draft = draft;
  log("✓", `First draft complete (${draft.split(/\s+/).length} words)`);
  console.log();

  // Phase 3: Edit and revise loop
  let currentDraft = draft;
  for (let round = 1; round <= maxRounds; round++) {
    log("📝", `Phase 3: Editor Agent reviewing (round ${round})...`);
    const review = await callAgent(
      client,
      model,
      EDITOR_PROMPT,
      `Content Brief:\n${contentBrief}\n\nResearch Brief:\n${researchBrief}\n\nDraft:\n${currentDraft}`,
      3000,
      0.3
    );
    artifacts[`review_round_${round}`] = review;

    if (review.toUpperCase().includes("APPROVED")) {
      log("✅", `Editor approved the draft in round ${round}!`);
      break;
    }

    log("🔄", "Editor requested revisions. Writer revising...");
    const revisionPrompt = `Content Brief:\n${contentBrief}

Research Brief:\n${researchBrief}

Your Previous Draft:\n${currentDraft}

Editor's Feedback:\n${review}

Please revise your draft based on the editor's feedback. Address every point raised. Keep the parts that were praised.`;

    currentDraft = await callAgent(
      client,
      model,
      WRITER_PROMPT,
      revisionPrompt,
      4096,
      0.5
    );
    artifacts[`revision_${round}`] = currentDraft;
    log(
      "✓",
      `Revision ${round} complete (${currentDraft.split(/\s+/).length} words)`
    );
    console.log();
  }

  artifacts.final_draft = currentDraft;
  return artifacts;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function readLine(prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    process.stdout.write(prompt);
    let input = "";
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string | Buffer) => {
      input += String(chunk);
      if (input.includes("\n")) {
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        resolve(input.trim());
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  validateEnv();

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: npx tsx index.ts [--topic TOPIC] [--audience AUDIENCE] [--format FORMAT] [--tone TONE] [--output FILE]"
    );
    console.log();
    console.log(
      "All arguments are optional. The agent will prompt for missing values."
    );
    process.exit(0);
  }

  const args = process.argv.slice(2);
  let topic: string | null = null;
  let audience: string | null = null;
  let formatType: string | null = null;
  let tone: string | null = null;
  let outputFile: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--topic" && i + 1 < args.length) {
      topic = args[++i];
    } else if (args[i] === "--audience" && i + 1 < args.length) {
      audience = args[++i];
    } else if (args[i] === "--format" && i + 1 < args.length) {
      formatType = args[++i];
    } else if (args[i] === "--tone" && i + 1 < args.length) {
      tone = args[++i];
    } else if (args[i] === "--output" && i + 1 < args.length) {
      outputFile = args[++i];
    }
  }

  if (!topic) topic = await readLine("📝 Topic: ");
  if (!audience) audience = (await readLine("👥 Target audience: ")) || "general audience";
  if (!formatType) formatType = (await readLine("📄 Format (blog post, newsletter, tutorial): ")) || "blog post";
  if (!tone) tone = (await readLine("🎭 Tone (professional, casual, technical): ")) || "professional";

  if (!topic.trim()) {
    console.error("❌ Please provide a topic.");
    process.exit(1);
  }

  log("🚀", "Starting content pipeline...");
  log("📋", `Topic: ${topic}`);
  log("👥", `Audience: ${audience}`);
  log("📄", `Format: ${formatType}`);
  log("🎭", `Tone: ${tone}`);
  console.log();

  try {
    const artifacts = await runPipeline(topic, audience, formatType, tone);

    console.log("\n" + "=".repeat(60));
    log("✅", "Content pipeline complete!\n");
    console.log(artifacts.final_draft);

    if (outputFile) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputFile, artifacts.final_draft, "utf8");
      log("💾", `Final draft saved to ${outputFile}`);
    }
  } catch (e) {
    console.error(`\n❌ Error: ${e}`);
    process.exit(1);
  }
}

main().catch(console.error);
