/**
 * Computer Use Agent -- Browser automation powered by Claude's vision.
 *
 * Takes screenshots of a browser, sends them to Claude, and executes
 * the actions Claude decides on (click, type, scroll, navigate) until
 * the task is complete or the step limit is reached.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import {
  Browser,
  BrowserContext,
  Page,
  chromium,
} from "playwright";

config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_STEPS = 20;
const DEFAULT_HEADLESS = true;
const DEFAULT_START_URL = "https://www.google.com";
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

const SYSTEM_PROMPT = `You are a browser automation agent. You can see a screenshot of a web browser and must decide what action to take next to accomplish the user's task.

## Screenshot interpretation
- The screenshot is ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT} pixels.
- The coordinate system starts at (0, 0) in the top-left corner.
- X increases to the right, Y increases downward.
- When clicking, aim for the CENTER of the element you want to interact with.
- Text inputs, buttons, links, and other interactive elements are your targets.
- Look carefully at the page content, URL bar, and any visible text.

## Available actions
Respond with exactly ONE JSON object (no extra text, no markdown fences) describing your next action. The JSON must have an "action" field plus action-specific fields and a "description" field explaining your reasoning.

### click -- click at pixel coordinates
{"action": "click", "x": <int>, "y": <int>, "description": "<why>"}

### type -- type text (the currently focused element receives input)
{"action": "type", "text": "<string>", "description": "<why>"}

### scroll -- scroll the page
{"action": "scroll", "direction": "up" | "down", "description": "<why>"}

### navigate -- go to a URL directly
{"action": "navigate", "url": "<full URL>", "description": "<why>"}

### done -- the task is complete
{"action": "done", "result": "<your answer or summary>", "description": "<why>"}

## Rules
1. Return ONLY the JSON object. No commentary before or after.
2. Always include a "description" field so the user can follow along.
3. After clicking a text input, use "type" to enter text.
4. After typing a search query, you usually need to press Enter -- use {"action": "type", "text": "\\n", "description": "Press Enter"}.
5. If the page hasn't changed after an action, try a different approach.
6. If you are stuck or the task seems impossible, return "done" with an explanation.
7. Be precise with coordinates -- click the exact center of buttons and links.
8. Scroll if you need to see content below or above the current viewport.
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClickAction {
  action: "click";
  x: number;
  y: number;
  description: string;
}

interface TypeAction {
  action: "type";
  text: string;
  description: string;
}

interface ScrollAction {
  action: "scroll";
  direction: "up" | "down";
  description: string;
}

interface NavigateAction {
  action: "navigate";
  url: string;
  description: string;
}

interface DoneAction {
  action: "done";
  result: string;
  description: string;
}

type AgentAction =
  | ClickAction
  | TypeAction
  | ScrollAction
  | NavigateAction
  | DoneAction;

interface AgentConfig {
  model: string;
  maxSteps: number;
  headless: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(emoji: string, message: string): void {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${ts}] ${emoji}  ${message}`);
}

function validateEnv(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("Error: ANTHROPIC_API_KEY is not set.");
    console.error("Export it or add it to a .env file. See .env.example.");
    process.exit(1);
  }
  return key;
}

function getConfig(): AgentConfig {
  return {
    model: process.env.MODEL ?? DEFAULT_MODEL,
    maxSteps: parseInt(process.env.MAX_STEPS ?? String(DEFAULT_MAX_STEPS), 10),
    headless:
      (process.env.HEADLESS ?? String(DEFAULT_HEADLESS)).toLowerCase() !== "false",
  };
}

function parseAction(text: string): AgentAction {
  const trimmed = text.trim();

  // Try the whole string.
  try {
    return JSON.parse(trimmed) as AgentAction;
  } catch {
    // continue
  }

  // Try markdown code fence.
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?(.*?)\n?\s*```/s);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as AgentAction;
    } catch {
      // continue
    }
  }

  // Try first { ... } block.
  const braceMatch = trimmed.match(/\{[^{}]*\}/s);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as AgentAction;
    } catch {
      // continue
    }
  }

  throw new Error(
    `Could not parse action JSON from response:\n${trimmed.slice(0, 300)}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Core agent loop
// ---------------------------------------------------------------------------

async function takeScreenshot(page: Page): Promise<string> {
  const buffer = await page.screenshot({ type: "png" });
  return buffer.toString("base64");
}

async function executeAction(page: Page, action: AgentAction): Promise<void> {
  switch (action.action) {
    case "click": {
      log("\uD83D\uDDB1\uFE0F", `Click (${action.x}, ${action.y}) -- ${action.description}`);
      await page.mouse.click(action.x, action.y);
      await page.waitForTimeout(500);
      break;
    }
    case "type": {
      const display = action.text === "\n" ? repr("\\n") : action.text;
      log("\u2328\uFE0F", `Type ${display} -- ${action.description}`);
      if (action.text === "\n") {
        await page.keyboard.press("Enter");
      } else {
        await page.keyboard.type(action.text, { delay: 30 });
      }
      await page.waitForTimeout(500);
      break;
    }
    case "scroll": {
      const delta = action.direction === "up" ? -400 : 400;
      log("\uD83D\uDDB2\uFE0F", `Scroll ${action.direction} -- ${action.description}`);
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(500);
      break;
    }
    case "navigate": {
      log("\uD83C\uDF10", `Navigate to ${action.url} -- ${action.description}`);
      await page.goto(action.url, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await page.waitForTimeout(1000);
      break;
    }
    case "done": {
      log("\u2705", `Done -- ${action.description}`);
      break;
    }
    default: {
      log("\u26A0\uFE0F", `Unknown action: ${(action as { action: string }).action}`);
    }
  }
}

function repr(s: string): string {
  return JSON.stringify(s);
}

async function callClaude(
  client: Anthropic,
  model: string,
  system: string,
  messages: Anthropic.MessageParam[]
): Promise<string> {
  let delay = INITIAL_RETRY_DELAY;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: 1024,
        temperature: 0.2,
        system,
        messages,
      });
      const block = resp.content[0];
      if (block.type === "text") {
        return block.text;
      }
      throw new Error(`Unexpected content block type: ${block.type}`);
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      log(
        "\u26A0\uFE0F",
        `API error (attempt ${attempt}/${MAX_RETRIES}): ${err}`
      );
      await sleep(delay);
      delay *= 2;
    }
  }
  throw new Error("Unreachable");
}

async function runAgent(
  task: string,
  startUrl: string,
  agentConfig: AgentConfig
): Promise<string> {
  const apiKey = validateEnv();
  const client = new Anthropic({ apiKey });
  const { model, maxSteps, headless } = agentConfig;

  log("\uD83D\uDE80", `Starting browser (headless=${headless})`);
  log("\uD83D\uDCCB", `Task: ${task}`);
  log("\uD83C\uDF10", `Start URL: ${startUrl}`);
  log("\u2699\uFE0F", `Model: ${model} | Max steps: ${maxSteps}`);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless });
    context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    });
    const page = await context.newPage();

    log("\uD83C\uDF10", `Navigating to ${startUrl}`);
    await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await page.waitForTimeout(1000);

    const messages: Anthropic.MessageParam[] = [];

    for (let step = 1; step <= maxSteps; step++) {
      log("\uD83D\uDCF8", `Step ${step}/${maxSteps} -- capturing screenshot`);
      const screenshotB64 = await takeScreenshot(page);

      const userContent: Anthropic.ContentBlockParam[] = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: screenshotB64,
          },
        },
        {
          type: "text",
          text: `Task: ${task}\n\nThis is step ${step} of ${maxSteps}. What action should I take next?`,
        },
      ];

      messages.push({ role: "user", content: userContent });

      log("\uD83E\uDD16", "Asking Claude for next action...");
      const rawResponse = await callClaude(client, model, SYSTEM_PROMPT, messages);

      let action: AgentAction;
      try {
        action = parseAction(rawResponse);
      } catch (err) {
        log("\u26A0\uFE0F", String(err));
        messages.push({ role: "assistant", content: rawResponse });
        messages.push({
          role: "user",
          content:
            "I could not parse your response as a valid action JSON. Please respond with ONLY a JSON object.",
        });
        continue;
      }

      messages.push({ role: "assistant", content: rawResponse });

      if (action.action === "done") {
        const result = action.result ?? "Task completed.";
        log("\uD83C\uDF89", `Agent finished: ${result}`);
        return result;
      }

      await executeAction(page, action);
    }

    log("\u23F0", "Reached maximum steps without completing the task.");
    return "Reached maximum steps without completing the task.";
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    log("\uD83E\uDDF9", "Browser cleaned up.");
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(): { task: string; url: string } {
  const args = process.argv.slice(2);
  let url = DEFAULT_START_URL;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && i + 1 < args.length) {
      url = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        "Usage: tsx index.ts [--url <start-url>] <task>\n\n" +
          "Automate a browser with Claude's vision.\n\n" +
          "Arguments:\n" +
          "  task        Natural-language description of what the agent should do\n" +
          "  --url URL   Starting URL (default: https://www.google.com)\n"
      );
      process.exit(0);
    } else {
      positional.push(args[i]);
    }
  }

  const task = positional.join(" ");
  if (!task) {
    console.error("Error: Please provide a task description.");
    console.error('Usage: tsx index.ts "Search for something on Google"');
    process.exit(1);
  }

  return { task, url };
}

async function main(): Promise<void> {
  const { task, url } = parseArgs();
  const agentConfig = getConfig();
  const result = await runAgent(task, url, agentConfig);

  console.log(`\n${"=".repeat(60)}`);
  console.log("RESULT");
  console.log("=".repeat(60));
  console.log(result);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
