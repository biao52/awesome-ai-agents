/**
 * Email Drafter Agent -- Drafts professional emails based on a situation description,
 * with tone control and support for multiple draft variations.
 *
 * Uses Anthropic Claude for writing (best-in-class for natural language generation).
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_RETRIES = 3;
const VALID_TONES = ["formal", "casual", "friendly", "assertive", "professional"] as const;
type Tone = (typeof VALID_TONES)[number];
const DEFAULT_TONE: Tone = "professional";
const DEFAULT_DRAFTS = 1;
const MAX_DRAFTS = 5;

interface EmailDraft {
  subject: string;
  body: string;
}

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
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert email writer who crafts clear, effective emails for professional contexts. You adapt your writing style to match the requested tone while keeping emails concise and actionable.

When drafting an email, you MUST output exactly this format:

SUBJECT: <subject line>

<email body>

Rules:
- Write a clear, specific subject line (not generic like "Follow Up" -- include context)
- Open with an appropriate greeting for the tone
- Get to the point quickly -- no filler sentences
- Include a clear call to action or next step when appropriate
- Close with an appropriate sign-off for the tone
- Keep emails concise: 3-6 short paragraphs maximum
- Use bullet points or numbered lists when presenting multiple items
- Never use placeholder names like [Name] -- if recipient info is provided, use it; otherwise use a natural greeting without a name
- Match the tone exactly:
  - formal: Conservative language, full titles, structured paragraphs
  - professional: Business-appropriate but not stiff, balanced warmth
  - friendly: Warm and personable while still clear and purposeful
  - casual: Relaxed language, conversational, but still coherent
  - assertive: Direct, confident, clear expectations and deadlines`;

// ---------------------------------------------------------------------------
// Email drafting via Anthropic Claude
// ---------------------------------------------------------------------------

function parseEmailResponse(response: string): EmailDraft {
  const lines = response.trim().split("\n");
  let subject = "";
  let bodyStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.toUpperCase().startsWith("SUBJECT:")) {
      subject = stripped.slice("SUBJECT:".length).trim();
      bodyStart = i + 1;
      break;
    }
  }

  // Skip blank lines between subject and body
  while (bodyStart < lines.length && !lines[bodyStart].trim()) {
    bodyStart++;
  }

  const body = lines.slice(bodyStart).join("\n").trim();

  if (!subject && body) {
    subject = "(No subject generated)";
  }

  return { subject, body };
}

async function draftEmail(
  situation: string,
  tone: Tone,
  recipient: string,
  model: string,
  draftNumber?: number,
  totalDrafts: number = 1
): Promise<EmailDraft> {
  const client = new Anthropic();

  // Build the user prompt with all available context
  const parts: string[] = [];
  parts.push(`Situation: ${situation}`);

  if (recipient) {
    parts.push(`Recipient: ${recipient}`);
  }

  parts.push(`Tone: ${tone}`);

  if (totalDrafts > 1 && draftNumber !== undefined) {
    parts.push(
      `This is draft ${draftNumber} of ${totalDrafts}. ` +
        "Make this variation meaningfully different from other drafts -- " +
        "try a different angle, structure, or emphasis while keeping " +
        "the same core message and tone."
    );
  }

  const userMessage = parts.join("\n");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        temperature: totalDrafts > 1 ? 0.7 : 0.4,
      });

      let result = "";
      for (const block of response.content) {
        if (block.type === "text") {
          result += block.text;
        }
      }

      return parseEmailResponse(result);
    } catch (e) {
      const errorStr = String(e);
      const isTransient =
        errorStr.toLowerCase().includes("rate") ||
        errorStr.toLowerCase().includes("overloaded") ||
        errorStr.includes("529") ||
        errorStr.includes("500");

      if (attempt < MAX_RETRIES && isTransient) {
        const waitTime = Math.pow(2, attempt);
        log(
          "...",
          `API error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${waitTime}s...`
        );
        await new Promise((r) => setTimeout(r, waitTime * 1000));
      } else {
        throw e;
      }
    }
  }

  throw new Error("Unreachable: max retries exceeded");
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatDraft(draft: EmailDraft, draftNumber?: number): string {
  const lines: string[] = [];

  if (draftNumber !== undefined) {
    lines.push("");
    lines.push("=".repeat(60));
    lines.push(`  DRAFT ${draftNumber}`);
    lines.push("=".repeat(60));
  } else {
    lines.push("");
    lines.push("=".repeat(60));
  }

  lines.push(`  Subject: ${draft.subject}`);
  lines.push("-".repeat(60));
  lines.push("");
  lines.push(draft.body);
  lines.push("");
  lines.push("=".repeat(60));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Interactive mode
// ---------------------------------------------------------------------------

async function interactiveMode(model: string): Promise<void> {
  log("💬", "Interactive mode -- describe the email you need to write.");
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const situation = (await rl.question("Situation: ")).trim();
    if (!situation) {
      console.log("Please describe the situation for the email.");
      process.exit(1);
    }

    const recipient = (
      await rl.question("Recipient (optional, press Enter to skip): ")
    ).trim();

    console.log(`Available tones: ${VALID_TONES.join(", ")}`);
    const toneInput = (
      await rl.question(`Tone (default: ${DEFAULT_TONE}): `)
    )
      .trim()
      .toLowerCase();

    const tone: Tone = isValidTone(toneInput) ? toneInput : DEFAULT_TONE;

    const draftsInput = (
      await rl.question("Number of drafts (default: 1): ")
    ).trim();

    let numDrafts = DEFAULT_DRAFTS;
    if (draftsInput) {
      const parsed = parseInt(draftsInput, 10);
      if (!isNaN(parsed)) {
        numDrafts = Math.max(1, Math.min(parsed, MAX_DRAFTS));
      }
    }

    rl.close();
    await generateAndDisplay(situation, tone, recipient, numDrafts, model);
  } catch {
    rl.close();
    console.log("\nCancelled.");
    process.exit(0);
  }
}

function isValidTone(value: string): value is Tone {
  return (VALID_TONES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Core generation logic
// ---------------------------------------------------------------------------

async function generateAndDisplay(
  situation: string,
  tone: Tone,
  recipient: string,
  numDrafts: number,
  model: string
): Promise<void> {
  log(
    "📧",
    `Drafting ${numDrafts === 1 ? "email" : `${numDrafts} email variations`}...`
  );
  log("🎨", `Tone: ${tone}`);
  if (recipient) {
    log("👤", `Recipient: ${recipient}`);
  }
  log("🤖", `Model: ${model}`);
  console.log();

  try {
    if (numDrafts === 1) {
      log("✍️", "Generating draft...");
      const draft = await draftEmail(situation, tone, recipient, model);
      console.log(formatDraft(draft));
    } else {
      log("✍️", `Generating ${numDrafts} drafts...`);
      const promises = Array.from({ length: numDrafts }, (_, i) =>
        draftEmail(situation, tone, recipient, model, i + 1, numDrafts)
      );
      const drafts = await Promise.all(promises);

      for (let i = 0; i < drafts.length; i++) {
        console.log(formatDraft(drafts[i], i + 1));
      }
    }
  } catch (e) {
    console.error(`\nError generating email: ${e}`);
    console.error("   Check your ANTHROPIC_API_KEY and network connection.");
    process.exit(1);
  }

  log("✅", "Done!");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  // No arguments -- enter interactive mode
  if (args.length === 0) {
    await interactiveMode(model);
    return;
  }

  // Parse CLI arguments
  const situationParts: string[] = [];
  let tone: Tone = DEFAULT_TONE;
  let recipient = "";
  let numDrafts = DEFAULT_DRAFTS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tone" && i + 1 < args.length) {
      const toneArg = args[i + 1].toLowerCase();
      if (!isValidTone(toneArg)) {
        console.error(`Invalid tone: ${args[i + 1]}`);
        console.error(`   Valid tones: ${VALID_TONES.join(", ")}`);
        process.exit(1);
      }
      tone = toneArg;
      i++;
    } else if (args[i] === "--recipient" && i + 1 < args.length) {
      recipient = args[i + 1];
      i++;
    } else if (args[i] === "--drafts" && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (isNaN(parsed) || parsed < 1 || parsed > MAX_DRAFTS) {
        console.error(
          `Invalid number of drafts: ${args[i + 1]} (must be 1-${MAX_DRAFTS})`
        );
        process.exit(1);
      }
      numDrafts = parsed;
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [SITUATION] [OPTIONS]");
      console.log();
      console.log("Arguments:");
      console.log(
        '  SITUATION             Describe the email situation (in quotes)'
      );
      console.log();
      console.log("Options:");
      console.log(
        `  --tone TONE           Email tone: ${VALID_TONES.join(", ")} (default: ${DEFAULT_TONE})`
      );
      console.log(
        '  --recipient INFO      Recipient context (e.g. "John, VP of Engineering")'
      );
      console.log(
        `  --drafts N            Generate N draft variations, 1-${MAX_DRAFTS} (default: ${DEFAULT_DRAFTS})`
      );
      console.log("  --help, -h            Show this help message");
      console.log();
      console.log("Examples:");
      console.log(
        '  npx tsx index.ts "Follow up with client who hasn\'t responded in 2 weeks"'
      );
      console.log(
        '  npx tsx index.ts "Request a deadline extension" --tone formal --recipient "Professor Smith"'
      );
      console.log(
        '  npx tsx index.ts "Decline a meeting invitation politely" --tone friendly --drafts 3'
      );
      console.log();
      console.log(
        "If no arguments are provided, the agent runs in interactive mode."
      );
      process.exit(0);
    } else {
      situationParts.push(args[i]);
    }
  }

  const situation = situationParts.join(" ").trim();
  if (!situation) {
    console.error("Please provide a situation description.");
    console.error("   Use --help for usage information.");
    process.exit(1);
  }

  log("🚀", "Starting email drafter agent...");
  await generateAndDisplay(situation, tone, recipient, numDrafts, model);
}

main().catch(console.error);
