/**
 * Software Dev Team -- Multi-Agent Pipeline
 * ==========================================
 * A 4-agent pipeline (PM -> Architect -> Developer -> Reviewer) that takes
 * a feature request and produces implemented code through specialized AI agents.
 *
 * Each agent has a distinct role and personality. Context flows forward through
 * the pipeline, and the Reviewer can send code back to the Developer for
 * revision (up to 2 rounds).
 *
 * Usage:
 *   npx tsx index.ts "Build a REST API for a blog with posts and comments"
 *   npx tsx index.ts "Build a CLI task manager" --output ./artifacts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import "dotenv/config";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let MODEL = process.env["MODEL"] ?? "gpt-4o";
const MAX_REVISION_ROUNDS = 2;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const TEMPERATURES: Record<string, number> = {
  pm: 0.4,
  architect: 0.3,
  developer: 0.2,
  reviewer: 0.3,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Artifacts {
  featureRequest: string;
  pmSpecification: string;
  architectureDesign: string;
  codeVersions: string[];
  reviews: string[];
  finalCode: string;
}

// ---------------------------------------------------------------------------
// System Prompts
// ---------------------------------------------------------------------------

const PM_SYSTEM_PROMPT = `You are a seasoned Product Manager with 15 years of experience shipping \
software products. Your job is to take a raw feature request and turn it \
into a clear, actionable specification.

Your responsibilities:
- Break the feature into user stories using the format: "As a [user], I want \
[capability] so that [benefit]"
- Define acceptance criteria for each story (Given/When/Then format)
- Identify edge cases and error scenarios
- Prioritize stories using MoSCoW (Must/Should/Could/Won't)
- Consider security, performance, and accessibility implications
- Estimate relative complexity (S/M/L/XL) for each story

Output format:
1. Feature Overview (2-3 sentences)
2. User Stories (numbered, with acceptance criteria)
3. Priority Matrix (MoSCoW classification)
4. Edge Cases & Error Scenarios
5. Non-functional Requirements
6. Out of Scope (things explicitly excluded)

Be thorough but practical. Focus on what delivers user value.`;

const ARCHITECT_SYSTEM_PROMPT = `You are a Principal Software Architect with deep expertise in system design, \
API design, and software patterns. You receive product specifications and \
produce technical designs.

Your responsibilities:
- Choose appropriate technologies and justify decisions
- Define the project file structure with clear module boundaries
- Design interfaces, data models, and API contracts
- Identify integration points and external dependencies
- Plan for error handling, logging, and observability
- Consider scalability, maintainability, and testability

Output format:
1. Technical Summary (approach in 2-3 sentences)
2. Technology Choices (with brief justifications)
3. File Structure (tree format with descriptions)
4. Data Models / Schemas (with field types)
5. API Contracts / Interfaces (with request/response shapes)
6. Key Design Decisions (numbered, with rationale)
7. Error Handling Strategy
8. Testing Strategy

Be opinionated about best practices. Prefer simplicity over cleverness. \
Choose battle-tested libraries over novel ones.`;

const DEVELOPER_SYSTEM_PROMPT = `You are a Senior Full-Stack Developer with expertise in writing clean, \
production-quality code. You receive a technical design and implement it \
completely.

Your responsibilities:
- Implement ALL files specified in the architecture
- Write complete, runnable code (never use placeholders or TODOs)
- Follow the language's idioms and best practices
- Include proper error handling and input validation
- Add clear comments for complex logic (but avoid obvious comments)
- Implement proper logging where appropriate
- Follow the data models and interfaces exactly as designed

Output format:
For each file, use this exact format:

=== FILE: path/to/file.ext ===
\`\`\`language
<complete file contents>
\`\`\`

Rules:
- Every file must be complete and self-contained
- Include all imports and dependencies
- Handle edge cases identified by the PM
- Follow the error handling strategy from the architecture
- Use consistent naming conventions throughout
- Do NOT use placeholder comments like "// TODO" or "// implement later"
- The code must be ready to run with no modifications`;

const REVIEWER_SYSTEM_PROMPT = `You are a Staff Engineer and Code Reviewer known for thorough, constructive \
reviews. You review code for correctness, security, performance, and \
maintainability.

Your responsibilities:
- Check that all requirements from the PM spec are implemented
- Verify the code follows the architecture design
- Look for security vulnerabilities (injection, auth issues, data exposure)
- Identify performance problems (N+1 queries, memory leaks, blocking ops)
- Check error handling completeness
- Verify input validation and sanitization
- Assess code readability and maintainability
- Check for missing edge case handling

Output format:
1. Overall Assessment (1-2 sentences)
2. Verdict: APPROVED or CHANGES_NEEDED
3. Issues Found (if any):
   - [CRITICAL] Must fix before shipping
   - [MAJOR] Should fix, significant impact
   - [MINOR] Nice to fix, low impact
   - [NIT] Style/preference suggestions
4. Specific Feedback (reference file names and describe the issue clearly)
5. What Was Done Well (positive feedback)

If verdict is CHANGES_NEEDED, be very specific about what needs to change \
and why. Reference file names and describe the problem precisely so the \
developer can act on it without ambiguity.

If the code is solid, say APPROVED and highlight what was done well.`;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(emoji: string, message: string): void {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`  ${emoji}  [${timestamp}] ${message}`);
}

function validateEnv(): void {
  if (!process.env["OPENAI_API_KEY"]) {
    console.error("\nError: OPENAI_API_KEY is not set.");
    console.error("  1. Copy .env.example to .env");
    console.error("  2. Add your OpenAI API key");
    console.error("  3. Get a key at: https://platform.openai.com/api-keys\n");
    process.exit(1);
  }
}

async function saveArtifact(
  outputDir: string,
  filename: string,
  content: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const filepath = join(outputDir, filename);
  await writeFile(filepath, content, "utf-8");
  log("💾", `Saved ${filepath}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// OpenAI Call with Retry
// ---------------------------------------------------------------------------

async function callAgent(
  client: OpenAI,
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  model: string = MODEL,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("Received empty response from API");
      }
      return content;
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `API call failed after ${MAX_RETRIES} attempts: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      log(
        "🔄",
        `Retry ${attempt}/${MAX_RETRIES} after error: ${error instanceof Error ? error.message : String(error)}`,
      );
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error("Unexpected: exhausted retries without raising");
}

// ---------------------------------------------------------------------------
// Agent Functions
// ---------------------------------------------------------------------------

async function runPmAgent(
  client: OpenAI,
  featureRequest: string,
): Promise<string> {
  log("📋", "PM Agent: Analyzing feature request...");

  const prompt =
    `Feature Request:\n\n${featureRequest}\n\n` +
    "Break this down into a complete product specification with user " +
    "stories, acceptance criteria, and priority rankings.";

  const result = await callAgent(
    client,
    PM_SYSTEM_PROMPT,
    prompt,
    TEMPERATURES["pm"],
  );

  log("✅", "PM Agent: Specification complete");
  return result;
}

async function runArchitectAgent(
  client: OpenAI,
  pmOutput: string,
  featureRequest: string,
): Promise<string> {
  log("🏗️", "Architect Agent: Designing technical architecture...");

  const prompt =
    `Original Feature Request:\n${featureRequest}\n\n` +
    `Product Specification (from PM):\n\n${pmOutput}\n\n` +
    "Design a complete technical architecture for this feature. " +
    "Include file structure, data models, API contracts, and key " +
    "design decisions.";

  const result = await callAgent(
    client,
    ARCHITECT_SYSTEM_PROMPT,
    prompt,
    TEMPERATURES["architect"],
  );

  log("✅", "Architect Agent: Architecture design complete");
  return result;
}

async function runDeveloperAgent(
  client: OpenAI,
  architectOutput: string,
  pmOutput: string,
  featureRequest: string,
  revisionFeedback?: string,
): Promise<string> {
  let prompt: string;

  if (revisionFeedback) {
    log("🔧", "Developer Agent: Revising code based on review feedback...");
    prompt =
      `Original Feature Request:\n${featureRequest}\n\n` +
      `Product Specification:\n\n${pmOutput}\n\n` +
      `Architecture Design:\n\n${architectOutput}\n\n` +
      "Your previous implementation received review feedback. " +
      "Please revise the code to address these issues:\n\n" +
      `Review Feedback:\n${revisionFeedback}\n\n` +
      "Provide the complete updated implementation for ALL files. " +
      "Do not skip files that were not mentioned in the feedback.";
  } else {
    log("💻", "Developer Agent: Implementing code...");
    prompt =
      `Original Feature Request:\n${featureRequest}\n\n` +
      `Product Specification:\n\n${pmOutput}\n\n` +
      `Architecture Design:\n\n${architectOutput}\n\n` +
      "Implement the complete code for this project. Output every " +
      "file with its full contents. The code must be production-ready " +
      "and runnable without modifications.";
  }

  const result = await callAgent(
    client,
    DEVELOPER_SYSTEM_PROMPT,
    prompt,
    TEMPERATURES["developer"],
  );

  log("✅", "Developer Agent: Implementation complete");
  return result;
}

async function runReviewerAgent(
  client: OpenAI,
  developerOutput: string,
  architectOutput: string,
  pmOutput: string,
): Promise<string> {
  log("🔍", "Reviewer Agent: Reviewing code...");

  const prompt =
    `Product Specification:\n\n${pmOutput}\n\n` +
    `Architecture Design:\n\n${architectOutput}\n\n` +
    `Implementation to Review:\n\n${developerOutput}\n\n` +
    "Review this implementation thoroughly. Check that all requirements " +
    "are met, the architecture is followed, and the code is production-ready. " +
    "Provide your verdict (APPROVED or CHANGES_NEEDED) with specific feedback.";

  const result = await callAgent(
    client,
    REVIEWER_SYSTEM_PROMPT,
    prompt,
    TEMPERATURES["reviewer"],
  );

  log("✅", "Reviewer Agent: Review complete");
  return result;
}

function reviewNeedsChanges(reviewOutput: string): boolean {
  return reviewOutput.toUpperCase().includes("CHANGES_NEEDED");
}

// ---------------------------------------------------------------------------
// Pipeline Orchestration
// ---------------------------------------------------------------------------

async function runPipeline(
  featureRequest: string,
  outputDir?: string,
): Promise<Artifacts> {
  const client = new OpenAI();

  const artifacts: Artifacts = {
    featureRequest,
    pmSpecification: "",
    architectureDesign: "",
    codeVersions: [],
    reviews: [],
    finalCode: "",
  };

  console.log("\n" + "=".repeat(60));
  console.log("  Software Dev Team -- Multi-Agent Pipeline");
  console.log("=".repeat(60));
  console.log(`\n  Feature: ${featureRequest}\n`);

  // --- Phase 1: Product Management ---
  console.log("-".repeat(40));
  artifacts.pmSpecification = await runPmAgent(client, featureRequest);

  // --- Phase 2: Architecture ---
  console.log("-".repeat(40));
  artifacts.architectureDesign = await runArchitectAgent(
    client,
    artifacts.pmSpecification,
    featureRequest,
  );

  // --- Phase 3 & 4: Development + Review (with revision loop) ---
  console.log("-".repeat(40));
  let developerOutput = await runDeveloperAgent(
    client,
    artifacts.architectureDesign,
    artifacts.pmSpecification,
    featureRequest,
  );
  artifacts.codeVersions.push(developerOutput);

  let approved = false;

  for (let revision = 1; revision <= MAX_REVISION_ROUNDS; revision++) {
    console.log("-".repeat(40));
    const reviewOutput = await runReviewerAgent(
      client,
      developerOutput,
      artifacts.architectureDesign,
      artifacts.pmSpecification,
    );
    artifacts.reviews.push(reviewOutput);

    if (!reviewNeedsChanges(reviewOutput)) {
      log("🎉", "Code APPROVED by Reviewer!");
      approved = true;
      break;
    }

    log("🔁", `Revision round ${revision}/${MAX_REVISION_ROUNDS}`);

    if (revision < MAX_REVISION_ROUNDS) {
      console.log("-".repeat(40));
      developerOutput = await runDeveloperAgent(
        client,
        artifacts.architectureDesign,
        artifacts.pmSpecification,
        featureRequest,
        reviewOutput,
      );
      artifacts.codeVersions.push(developerOutput);
    } else {
      log("⚠️", "Max revision rounds reached. Proceeding with latest code.");
    }
  }

  if (!approved && artifacts.codeVersions.length > 1) {
    // Run a final review after the last revision
    console.log("-".repeat(40));
    const finalReview = await runReviewerAgent(
      client,
      developerOutput,
      artifacts.architectureDesign,
      artifacts.pmSpecification,
    );
    artifacts.reviews.push(finalReview);

    if (!reviewNeedsChanges(finalReview)) {
      log("🎉", "Code APPROVED by Reviewer after revisions!");
    } else {
      log("⚠️", "Reviewer still has concerns. Manual review recommended.");
    }
  }

  artifacts.finalCode = developerOutput;

  // --- Save artifacts ---
  if (outputDir) {
    await saveArtifact(
      outputDir,
      "01_pm_specification.md",
      artifacts.pmSpecification,
    );
    await saveArtifact(
      outputDir,
      "02_architecture_design.md",
      artifacts.architectureDesign,
    );

    for (let i = 0; i < artifacts.codeVersions.length; i++) {
      await saveArtifact(
        outputDir,
        `03_code_v${i + 1}.md`,
        artifacts.codeVersions[i],
      );
    }

    for (let i = 0; i < artifacts.reviews.length; i++) {
      await saveArtifact(
        outputDir,
        `04_review_v${i + 1}.md`,
        artifacts.reviews[i],
      );
    }

    await saveArtifact(outputDir, "05_final_code.md", developerOutput);

    const manifest = {
      featureRequest,
      model: MODEL,
      artifactCount:
        2 + artifacts.codeVersions.length + artifacts.reviews.length + 1,
      timestamp: new Date().toISOString(),
    };
    await saveArtifact(
      outputDir,
      "manifest.json",
      JSON.stringify(manifest, null, 2),
    );
  }

  // --- Print summary ---
  console.log("\n" + "=".repeat(60));
  console.log("  Pipeline Complete!");
  console.log("=".repeat(60));
  const totalArtifacts =
    2 + artifacts.codeVersions.length + artifacts.reviews.length + 1;
  console.log(`\n  Artifacts produced: ${totalArtifacts}`);
  if (outputDir) {
    console.log(`  Output directory:   ${outputDir}`);
  }
  console.log();

  return artifacts;
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      model: { type: "string", short: "m" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(
      "Usage: npx tsx index.ts <feature-request> [--output DIR] [--model MODEL]",
    );
    console.log(
      '\nExample: npx tsx index.ts "Build a REST API for a blog"',
    );
    process.exit(positionals.length === 0 ? 1 : 0);
  }

  validateEnv();

  if (values.model) {
    MODEL = values.model;
  }

  const featureRequest = positionals.join(" ");

  try {
    await runPipeline(featureRequest, values.output);
  } catch (error) {
    log(
      "❌",
      `Pipeline failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

main();
