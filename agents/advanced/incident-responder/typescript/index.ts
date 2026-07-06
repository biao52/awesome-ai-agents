/**
 * Incident Responder Agent -- Takes alert descriptions and context, then produces
 * a structured incident response plan with triage, actions, and communication templates.
 *
 * Uses OpenAI GPT-4o for analysis and response generation.
 */

import "dotenv/config";
import OpenAI from "openai";
import { createInterface } from "node:readline/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-4o";
const MAX_RETRIES = 3;
const SEVERITY_LEVELS = ["critical", "high", "medium", "low"] as const;

// ---------------------------------------------------------------------------
// Environment validation
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
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior Site Reliability Engineer and Incident Commander with 15+ years of experience managing production incidents at large-scale distributed systems. You have handled thousands of incidents across cloud infrastructure, databases, networking, and application layers.

Given an alert description and optional context, produce a comprehensive incident response plan. Be specific and actionable -- generic advice is not helpful during an incident.

Your response must follow this exact format:

## Triage Assessment
[2-3 sentences: what is likely happening, how confident you are, and what the blast radius is]

## Severity Classification
**Recommended Severity:** [SEV-1 / SEV-2 / SEV-3 / SEV-4]
**Justification:** [Why this severity level]
**User Impact:** [Estimated scope of user impact]

## Immediate Actions (first 15 minutes)
[Numbered list of concrete steps to take RIGHT NOW, in priority order]
1. **[ACTION]:** Specific command, check, or action with details
2. ...

## Investigation Steps
[Ordered steps to identify root cause]
1. **Check [SYSTEM]:** What to look for and what it means
   - Command/query: \`specific command to run\`
   - Expected vs. concerning output
2. ...

## Likely Root Causes
[Ranked by probability]
1. **[CAUSE]** (probability: High/Medium/Low)
   - Why: Reasoning based on the alert
   - Verify: How to confirm or rule out
   - Fix: Steps to resolve if confirmed
2. ...

## Mitigation Options
[If root cause is not yet confirmed, what can we do to reduce impact?]
1. **[OPTION]:** Description, trade-offs, and rollback plan
2. ...

## Communication Template

### Internal (Slack/Teams)
\`\`\`
[Ready-to-paste incident notification for engineering channel]
\`\`\`

### Status Page (if customer-facing)
\`\`\`
[Ready-to-paste status page update]
\`\`\`

### Escalation (if needed)
\`\`\`
[Ready-to-paste escalation message with context for on-call]
\`\`\`

## Escalation Criteria
[When to escalate to the next level]
- Escalate to SEV-[N-1] if: [condition]
- Page [TEAM] if: [condition]
- Engage vendor support if: [condition]

## Post-Incident
[What to do after the incident is resolved]
1. Verify: How to confirm the fix is working
2. Monitor: What metrics to watch for the next 24 hours
3. Follow-up: Action items for the post-mortem

Rules:
- Be specific to the alert described. Do not give generic incident response advice.
- Include actual commands, queries, and URLs where possible.
- Consider cascading failures and downstream effects.
- Always include a rollback option if a change was recently deployed.
- Time is critical during incidents -- prioritize speed over perfection.
- If the alert description is vague, state your assumptions explicitly.`;

// ---------------------------------------------------------------------------
// Incident response agent
// ---------------------------------------------------------------------------

interface IncidentContext {
  alert: string;
  severity?: string;
  service?: string;
  runbook?: string;
}

async function generateResponsePlan(
  ctx: IncidentContext,
  model: string
): Promise<string> {
  const client = new OpenAI();

  const parts: string[] = [`**Alert:** ${ctx.alert}`];
  if (ctx.severity) parts.push(`**Reported Severity:** ${ctx.severity}`);
  if (ctx.service) parts.push(`**Affected Service:** ${ctx.service}`);
  if (ctx.runbook) parts.push(`**Runbook URL:** ${ctx.runbook}`);
  parts.push("\nProduce a complete incident response plan now.");

  const userMessage = parts.join("\n");

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 4096,
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      });

      return response.choices[0]?.message?.content || "Error: Empty response from model.";
    } catch (e) {
      const errorStr = String(e).toLowerCase();
      if (errorStr.includes("rate") || errorStr.includes("overloaded")) {
        const wait = Math.pow(2, attempt + 1);
        log("⏳", `API rate limit, retrying in ${wait}s...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw e;
    }
  }

  return "Error: Failed to generate response plan after multiple retries.";
}

// ---------------------------------------------------------------------------
// Interactive mode
// ---------------------------------------------------------------------------

async function interactiveMode(model: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log();
  console.log("📋 Incident Responder -- Interactive Mode");
  console.log("=".repeat(50));
  console.log();

  const alert = (await rl.question("🚨 Describe the alert or incident:\n> ")).trim();
  if (!alert) {
    console.error("❌ Alert description is required.");
    rl.close();
    process.exit(1);
  }

  console.log();
  const severityInput = (
    await rl.question("⚡ Severity (critical/high/medium/low) [press Enter to auto-detect]: ")
  ).trim().toLowerCase();

  let severity: string | undefined;
  if (severityInput && (SEVERITY_LEVELS as readonly string[]).includes(severityInput)) {
    severity = severityInput;
  } else if (severityInput) {
    console.log(`⚠️  Unknown severity '${severityInput}', will auto-detect.`);
  }

  const service = (await rl.question("🔧 Affected service [press Enter to skip]: ")).trim() || undefined;
  const runbook = (await rl.question("📖 Runbook URL [press Enter to skip]: ")).trim() || undefined;

  rl.close();

  console.log();
  log("🧠", "Generating incident response plan...");
  console.log();

  const plan = await generateResponsePlan({ alert, severity, service, runbook }, model);

  console.log("=".repeat(60));
  console.log("🚨 Incident Response Plan");
  console.log("=".repeat(60));
  console.log();
  console.log(plan);
  console.log();
  console.log("=".repeat(60));
  log("✅", "Response plan complete!");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log('Usage: npx tsx index.ts "Alert description" [options]');
    console.log("       npx tsx index.ts  (interactive mode)");
    console.log();
    console.log("Options:");
    console.log("  --severity LEVEL   Severity level: critical, high, medium, low");
    console.log("  --service NAME     Name of the affected service");
    console.log("  --runbook URL      URL to the relevant runbook");
    process.exit(0);
  }

  // Parse args
  const alertParts: string[] = [];
  let severity: string | undefined;
  let service: string | undefined;
  let runbook: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--severity" && i + 1 < args.length) {
      const val = args[++i].toLowerCase();
      if ((SEVERITY_LEVELS as readonly string[]).includes(val)) {
        severity = val;
      } else {
        console.log(`⚠️  Unknown severity '${val}', will auto-detect.`);
      }
    } else if (args[i] === "--service" && i + 1 < args.length) {
      service = args[++i];
    } else if (args[i] === "--runbook" && i + 1 < args.length) {
      runbook = args[++i];
    } else {
      alertParts.push(args[i]);
    }
  }

  const alert = alertParts.join(" ").trim();

  // If no alert provided, enter interactive mode
  if (!alert) {
    await interactiveMode(model);
    return;
  }

  log("🚀", "Starting incident responder...");
  log("🤖", `Model: ${model}`);
  log("🚨", `Alert: ${alert}`);
  if (severity) log("⚡", `Severity: ${severity}`);
  if (service) log("🔧", `Service: ${service}`);
  if (runbook) log("📖", `Runbook: ${runbook}`);
  console.log();

  log("🧠", "Generating incident response plan...");
  console.log();

  const plan = await generateResponsePlan({ alert, severity, service, runbook }, model);

  console.log("=".repeat(60));
  console.log("🚨 Incident Response Plan");
  console.log("=".repeat(60));
  console.log();
  console.log(plan);
  console.log();
  console.log("=".repeat(60));
  log("✅", "Response plan complete!");
}

main().catch((e) => {
  console.error(`\n❌ Error: ${e}`);
  process.exit(1);
});
