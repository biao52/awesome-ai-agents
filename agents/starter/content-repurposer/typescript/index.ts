/**
 * Content Repurposer -- Takes a blog post URL, reads it with Reader, and uses
 * Claude to repurpose it into multiple content formats (Twitter thread, LinkedIn
 * post, email newsletter, key takeaways).
 *
 * This agent uses Reader (https://reader.dev) to convert web pages to clean markdown.
 * Web reading powered by Reader (https://reader.dev) -- get your API key at reader.dev
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Supported output formats
// ---------------------------------------------------------------------------

const ALL_FORMATS = ["twitter", "linkedin", "email", "takeaways"] as const;
type ContentFormat = (typeof ALL_FORMATS)[number];

const FORMAT_DESCRIPTIONS: Record<ContentFormat, string> = {
  twitter: "Twitter/X thread (5-10 tweets)",
  linkedin: "LinkedIn post (professional tone, 200-300 words)",
  email: "Email newsletter excerpt with subject line",
  takeaways: "Key takeaways as a bullet list",
};

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY", "READER_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Error: Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Reader -- fetch article as markdown
// ---------------------------------------------------------------------------

const READER_API_URL = "https://api.reader.dev/v1/read";

/**
 * Fetch a web page as clean markdown using Reader.
 *
 * Reader (reader.dev) converts any web page into clean, readable markdown.
 * Uses the Reader API at api.reader.dev/v1/read.
 */
async function fetchArticle(url: string): Promise<string> {
  log("📖", `Fetching article via Reader: ${url}`);

  const response = await fetch(READER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.READER_API_KEY}`,
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Reader API error: ${response.status}`);
  }

  const data = await response.json() as { data: { markdown: string } };
  let markdown = data.data.markdown || "";

  if (!markdown.trim()) {
    throw new Error("Reader returned empty content. Check that the URL points to a readable article.");
  }

  // Truncate very long articles to avoid exceeding context limits
  const maxChars = 50_000;
  if (markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars) + "\n\n[Content truncated for length]";
    log("✂️", `Article truncated to ${maxChars} characters`);
  }

  const wordCount = markdown.split(/\s+/).length;
  log("✅", `Article fetched: ~${wordCount} words`);
  return markdown;
}

// ---------------------------------------------------------------------------
// Repurposing prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(formats: ContentFormat[]): string {
  const formatInstructions: string[] = [];

  if (formats.includes("twitter")) {
    formatInstructions.push(`## TWITTER THREAD
Create a Twitter/X thread of 5-10 tweets that captures the key ideas of the article.
- Each tweet must be under 280 characters
- Start with a hook tweet that grabs attention
- Number each tweet (1/, 2/, etc.)
- End with a call-to-action tweet linking back to the original
- Use line breaks between tweets for readability
- Include relevant hashtags on the last tweet only`);
  }

  if (formats.includes("linkedin")) {
    formatInstructions.push(`## LINKEDIN POST
Write a LinkedIn post (200-300 words) that shares the article's insights professionally.
- Open with a bold statement or question
- Use short paragraphs (1-2 sentences each)
- Include 2-3 key insights from the article
- End with a question to drive engagement
- Add 3-5 relevant hashtags at the bottom
- Tone: professional but conversational, not corporate`);
  }

  if (formats.includes("email")) {
    formatInstructions.push(`## EMAIL NEWSLETTER
Create an email newsletter excerpt with:
- **Subject line:** A compelling subject line (under 60 characters)
- **Preview text:** One sentence that appears in email preview (under 100 characters)
- **Body:** 150-250 word summary that makes readers want to click through
- Include a clear call-to-action linking to the original article
- Tone: friendly, informative, like writing to a smart friend`);
  }

  if (formats.includes("takeaways")) {
    formatInstructions.push(`## KEY TAKEAWAYS
Extract 5-8 key takeaways from the article as a bullet list.
- Each takeaway should be a complete, standalone insight (1-2 sentences)
- Order from most important to least important
- Focus on actionable insights, not just facts
- Prefix each with a relevant emoji`);
  }

  const sections = formatInstructions.join("\n\n");

  return `You are a content repurposing expert. Given a blog post or article in markdown format,
you transform it into multiple content formats while preserving the core message and key insights.

Your output must include the following sections, each clearly separated with a markdown heading:

${sections}

Important guidelines:
- Preserve the author's voice and key arguments
- Do not invent facts or statistics not present in the original
- Adapt tone for each platform (casual for Twitter, professional for LinkedIn, etc.)
- Each format should work as standalone content
- Use clear markdown formatting with headings to separate each section`;
}

// ---------------------------------------------------------------------------
// Claude -- repurpose content
// ---------------------------------------------------------------------------

async function repurposeContent(
  articleMarkdown: string,
  sourceUrl: string,
  formats: ContentFormat[],
  model: string,
): Promise<string> {
  const client = new Anthropic();

  const systemPrompt = buildSystemPrompt(formats);

  const userMessage = `Here is the article to repurpose. The original URL is: ${sourceUrl}

---

${articleMarkdown}

---

Please repurpose this article into the requested formats. Make sure each section is clearly
labeled with a markdown heading so they can be easily separated.`;

  log("🤖", `Sending to Claude (${model}) for repurposing...`);
  log("📝", `Requested formats: ${formats.join(", ")}`);

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    temperature: 0.7,
  });

  // Extract text from response
  let resultText = "";
  for (const block of response.content) {
    if (block.type === "text") {
      resultText += block.text;
    }
  }

  if (!resultText.trim()) {
    throw new Error("Claude returned empty content.");
  }

  const tokensIn = response.usage.input_tokens;
  const tokensOut = response.usage.output_tokens;
  log("📊", `Tokens used: ${tokensIn} in / ${tokensOut} out`);

  return resultText;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  url: string;
  formats: ContentFormat[];
  output: string | null;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);

  let url = "";
  let formatStr: string | null = null;
  let output: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" && i + 1 < args.length) {
      formatStr = args[i + 1];
      i++;
    } else if (args[i] === "--output" && i + 1 < args.length) {
      output = args[i + 1];
      i++;
    } else if (!args[i].startsWith("--")) {
      url = args[i];
    }
  }

  // Parse and validate formats
  let formats: ContentFormat[];
  if (formatStr) {
    const requested = formatStr.split(",").map((f) => f.trim().toLowerCase());
    const invalid = requested.filter((f) => !(ALL_FORMATS as readonly string[]).includes(f));
    if (invalid.length > 0) {
      console.error(`Error: Unknown format(s): ${invalid.join(", ")}`);
      console.error(`   Valid formats: ${ALL_FORMATS.join(", ")}`);
      process.exit(1);
    }
    formats = requested as ContentFormat[];
  } else {
    formats = [...ALL_FORMATS];
  }

  return { url, formats, output };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

async function saveOutput(content: string, outputPath: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outputPath, content, "utf8");
  log("💾", `Output saved to ${outputPath}`);
}

function printDivider(): void {
  console.log("\n" + "=".repeat(60) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const parsed = parseArgs();
  const model = process.env.MODEL || "claude-sonnet-4-20250514";

  // Get URL from args or prompt
  let url = parsed.url;
  if (!url) {
    process.stdout.write("🔗 Enter the URL of the article to repurpose: ");
    url = await new Promise<string>((resolve) => {
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

  if (!url) {
    console.error("Error: Please provide a URL.");
    process.exit(1);
  }

  // Validate URL format (basic check)
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  const formats = parsed.formats;

  log("🚀", "Starting content repurposer...");
  log("🔗", `Source URL: ${url}`);
  log("🤖", `Model: ${model}`);
  log("📋", `Formats: ${formats.map((f) => FORMAT_DESCRIPTIONS[f]).join(", ")}`);
  console.log();

  // Step 1: Fetch article via Reader
  let articleMarkdown: string;
  try {
    articleMarkdown = await fetchArticle(url);
  } catch (e) {
    console.error(`\nError: Failed to fetch article: ${e}`);
    process.exit(1);
  }

  // Step 2: Repurpose with Claude
  let repurposed: string;
  try {
    repurposed = await repurposeContent(articleMarkdown, url, formats, model);
  } catch (e) {
    console.error(`\nError: Failed to repurpose content: ${e}`);
    process.exit(1);
  }

  // Step 3: Output results
  printDivider();
  log("✅", "Content repurposed successfully!\n");
  console.log(repurposed);

  if (parsed.output) {
    printDivider();
    await saveOutput(repurposed, parsed.output);
  }

  printDivider();
  log("🎯", `Source: ${url}`);
  log("📄", `Generated ${formats.length} format(s): ${formats.join(", ")}`);
}

main().catch(console.error);
