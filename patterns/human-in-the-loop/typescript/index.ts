/**
 * Human-in-the-Loop Agent
 *
 * An agent that pauses for human approval before executing risky actions.
 * Safe actions (search, draft) run automatically. Dangerous actions (send email)
 * require explicit user confirmation before execution.
 *
 * Usage:
 *   npx tsx index.ts
 */

import "dotenv/config";
import OpenAI from "openai";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const MODEL = process.env.MODEL ?? "gpt-4o-mini";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(emoji: string, message: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] ${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["OPENAI_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** Actions that require human approval before execution. */
const REQUIRES_APPROVAL = new Set(["send_email"]);

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "Search the web for information. Returns a list of relevant results.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_email",
      description:
        "Draft an email. This does NOT send the email -- it only creates a draft for review. Use send_email to actually send it.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Email subject line." },
          body: { type: "string", description: "Email body text." },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description:
        "Send an email to the specified recipient. This is an irreversible action that actually delivers the email.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Email subject line." },
          body: { type: "string", description: "Email body text." },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Simulated tool implementations
// ---------------------------------------------------------------------------

interface ToolArgs {
  query?: string;
  to?: string;
  subject?: string;
  body?: string;
}

function executeSearchWeb(query: string): string {
  log("🌐", `Searching the web for: ${query}`);
  const results = [
    {
      title: `Result 1 for '${query}'`,
      url: `https://example.com/result-1?q=${query.replace(/ /g, "+")}`,
      snippet: `This is a relevant result about ${query}. It contains useful information.`,
    },
    {
      title: `Result 2 for '${query}'`,
      url: `https://example.com/result-2?q=${query.replace(/ /g, "+")}`,
      snippet: `Another perspective on ${query} with additional details and data.`,
    },
    {
      title: `Result 3 for '${query}'`,
      url: `https://example.com/result-3?q=${query.replace(/ /g, "+")}`,
      snippet: `Expert analysis of ${query} from a trusted source.`,
    },
  ];
  return JSON.stringify(results, null, 2);
}

function executeDraftEmail(to: string, subject: string, body: string): string {
  log("📝", `Drafting email to ${to}`);
  const draft = {
    status: "drafted",
    to,
    subject,
    body,
    message: "Email drafted successfully. Use send_email to deliver it.",
  };
  return JSON.stringify(draft, null, 2);
}

function executeSendEmail(to: string, subject: string, body: string): string {
  log("📧", `Sending email to ${to}`);
  const result = {
    status: "sent",
    to,
    subject,
    message_id: "msg_abc123",
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

async function requestHumanApproval(
  rl: readline.Interface,
  toolName: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  console.log();
  console.log("=".repeat(60));
  console.log(`  APPROVAL REQUIRED: ${toolName}`);
  console.log("=".repeat(60));
  console.log();
  for (const [key, value] of Object.entries(args)) {
    const valueStr = String(value);
    if (valueStr.includes("\n")) {
      const indented = valueStr.replace(/\n/g, "\n      ");
      console.log(`  ${key}: ${indented}`);
    } else {
      console.log(`  ${key}: ${valueStr}`);
    }
  }
  console.log();
  console.log("-".repeat(60));

  while (true) {
    const choice = (await rl.question("  Do you approve this action? [y/n]: "))
      .trim()
      .toLowerCase();
    if (choice === "y" || choice === "yes") return true;
    if (choice === "n" || choice === "no") return false;
    console.log("  Please enter 'y' or 'n'.");
  }
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

async function executeTool(
  rl: readline.Interface,
  toolName: string,
  args: ToolArgs,
): Promise<string> {
  // Gate: check if this action requires human approval
  if (REQUIRES_APPROVAL.has(toolName)) {
    const approved = await requestHumanApproval(
      rl,
      toolName,
      args as Record<string, unknown>,
    );
    if (!approved) {
      log("🚫", `User denied ${toolName} -- action cancelled`);
      return JSON.stringify({
        status: "cancelled",
        reason: "User denied approval for this action.",
      });
    }
    log("✅", `User approved ${toolName}`);
  }

  switch (toolName) {
    case "search_web":
      return executeSearchWeb(args.query ?? "");
    case "draft_email":
      return executeDraftEmail(
        args.to ?? "",
        args.subject ?? "",
        args.body ?? "",
      );
    case "send_email":
      return executeSendEmail(
        args.to ?? "",
        args.subject ?? "",
        args.body ?? "",
      );
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a helpful assistant that can search the web, draft emails, and send emails.

When the user asks you to send an email:
1. First draft the email using draft_email so the user can review it.
2. Then use send_email to actually deliver it.

Be conversational and helpful. Summarize search results clearly.
When drafting emails, write professional, concise content.`;

async function runAgentTurn(
  client: OpenAI,
  messages: OpenAI.ChatCompletionMessageParam[],
  rl: readline.Interface,
): Promise<string> {
  while (true) {
    let response: OpenAI.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log("❌", `API error: ${errorMsg}`);
      return `Sorry, I encountered an error: ${errorMsg}`;
    }

    const choice = response.choices[0];
    const message = choice.message;

    // Append assistant message to conversation
    messages.push(message);

    // If the model wants to call tools, process them
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function") continue;
        const fnName = toolCall.function.name;
        let fnArgs: ToolArgs;
        try {
          fnArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          fnArgs = {};
        }

        if (REQUIRES_APPROVAL.has(fnName)) {
          log("⚠️", `Risky action detected: ${fnName} -- requesting approval`);
        } else {
          log("⚙️", `Executing safe action: ${fnName}`);
        }

        const result = await executeTool(rl, fnName, fnArgs);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
      // Continue loop so model can process tool results
      continue;
    }

    return message.content ?? "";
  }
}

// ---------------------------------------------------------------------------
// Chat loop
// ---------------------------------------------------------------------------

async function chatLoop(): Promise<void> {
  const client = new OpenAI();
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  const rl = readline.createInterface({ input, output });

  console.log();
  console.log("Human-in-the-Loop Agent");
  console.log("=".repeat(40));
  console.log("This agent can search the web, draft emails, and send emails.");
  console.log("Sending emails requires your explicit approval.");
  console.log("Type 'quit' or 'exit' to stop.");
  console.log();

  try {
    while (true) {
      let userInput: string;
      try {
        userInput = (await rl.question("You: ")).trim();
      } catch {
        break;
      }

      if (!userInput) continue;
      if (["quit", "exit", "q"].includes(userInput.toLowerCase())) break;

      messages.push({ role: "user", content: userInput });

      log("🤖", "Thinking...");
      const reply = await runAgentTurn(client, messages, rl);

      console.log(`\nAssistant: ${reply}\n`);
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();
  log("🚀", "Starting human-in-the-loop agent...");
  log("🔒", `Actions requiring approval: ${[...REQUIRES_APPROVAL].join(", ")}`);
  await chatLoop();
  log("👋", "Goodbye!");
}

main().catch(console.error);
