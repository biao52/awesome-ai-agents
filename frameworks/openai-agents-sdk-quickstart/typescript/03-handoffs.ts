/**
 * 03 - Multi-Agent Handoffs
 *
 * A triage agent analyzes user intent and routes (hands off) the conversation
 * to a specialized agent -- either sales or support. Each agent has its own
 * system prompt and tools.
 *
 * This demonstrates the handoff pattern that the Agents SDK provides via
 * Agent.handoff(). Under the hood, handoffs are just tool calls that switch
 * the active agent.
 *
 * Pattern: Triage agent -> detect intent -> hand off to specialist agent
 *          -> specialist responds with domain-specific behavior
 */

import "dotenv/config";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

function validateEnv(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY is not set.");
    console.error("Copy .env.example to .env and add your key.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

interface AgentConfig {
  name: string;
  instructions: string;
  tools: ChatCompletionTool[] | null;
}

const triageTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "handoff_to_sales",
      description:
        "Route the user to the sales agent for purchasing, pricing, or product questions",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why this handoff is appropriate",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "handoff_to_support",
      description:
        "Route the user to the support agent for technical issues or account problems",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why this handoff is appropriate",
          },
        },
        required: ["reason"],
      },
    },
  },
];

const salesTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "check_pricing",
      description: "Look up pricing details for a specific plan",
      parameters: {
        type: "object",
        properties: {
          plan: { type: "string", enum: ["starter", "pro", "enterprise"] },
        },
        required: ["plan"],
      },
    },
  },
];

const supportTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "lookup_account",
      description: "Look up account details by email",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string", description: "User's email address" },
        },
        required: ["email"],
      },
    },
  },
];

const agents: Record<string, AgentConfig> = {
  triage: {
    name: "Triage Agent",
    instructions:
      "You are a triage agent. Analyze the user's message and decide which " +
      "specialist to route them to. Use the handoff_to_sales tool for purchase, " +
      "pricing, or product inquiries. Use handoff_to_support for technical issues, " +
      "bugs, or account problems. Always hand off -- do not answer directly.",
    tools: triageTools,
  },
  sales: {
    name: "Sales Agent",
    instructions:
      "You are a sales specialist for a SaaS product. You help users with " +
      "pricing, plans, and purchasing decisions. Be enthusiastic but honest. " +
      "Available plans: Starter ($29/mo), Pro ($99/mo), Enterprise (custom). " +
      "Use the check_pricing tool to look up specific plan details.",
    tools: salesTools,
  },
  support: {
    name: "Support Agent",
    instructions:
      "You are a technical support specialist. Help users troubleshoot issues, " +
      "explain features, and resolve account problems. Be patient and thorough. " +
      "Use the lookup_account tool to check account status.",
    tools: supportTools,
  },
};

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

interface PlanInfo {
  name: string;
  price: string;
  features: string[];
}

function checkPricing(plan: string): PlanInfo | { error: string } {
  const plans: Record<string, PlanInfo> = {
    starter: {
      name: "Starter",
      price: "$29/mo",
      features: ["5 users", "10GB storage", "Email support"],
    },
    pro: {
      name: "Pro",
      price: "$99/mo",
      features: [
        "25 users",
        "100GB storage",
        "Priority support",
        "API access",
      ],
    },
    enterprise: {
      name: "Enterprise",
      price: "Custom",
      features: [
        "Unlimited users",
        "Unlimited storage",
        "24/7 support",
        "SLA",
        "SSO",
      ],
    },
  };
  return plans[plan] ?? { error: "Unknown plan" };
}

function lookupAccount(email: string): Record<string, string> {
  return {
    email,
    plan: "Pro",
    status: "active",
    created: "2024-06-15",
    usage: "67% of storage limit",
  };
}

const toolFunctions: Record<
  string,
  (args: Record<string, string>) => unknown
> = {
  check_pricing: (args) => checkPricing(args.plan),
  lookup_account: (args) => lookupAccount(args.email),
};

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

async function runAgent(
  agentKey: string,
  userMessage: string,
  client: OpenAI,
  model: string
): Promise<string> {
  const agent = agents[agentKey];
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: agent.instructions },
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: agent.tools ?? undefined,
      temperature: 0.3,
    });

    const choice = response.choices[0];
    if (!choice.message.tool_calls?.length) {
      return choice.message.content ?? "";
    }

    messages.push(choice.message);
    for (const toolCall of choice.message.tool_calls) {
      const fnName = toolCall.function.name;
      const fnArgs = JSON.parse(toolCall.function.arguments) as Record<
        string,
        string
      >;
      const fn = toolFunctions[fnName];
      const result = fn ? fn(fnArgs) : { error: `Unknown tool: ${fnName}` };
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }
}

async function runWithHandoffs(userMessage: string): Promise<string> {
  const client = new OpenAI();
  const model = process.env.MODEL ?? "gpt-4o-mini";

  // Step 1: Triage
  const triage = agents.triage;
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: triage.instructions },
    { role: "user", content: userMessage },
  ];

  const response = await client.chat.completions.create({
    model,
    messages,
    tools: triage.tools ?? undefined,
    temperature: 0.1,
  });

  const choice = response.choices[0];

  // Step 2: Detect handoff
  if (choice.message.tool_calls?.length) {
    const toolCall = choice.message.tool_calls[0];
    const fnName = toolCall.function.name;
    const fnArgs = JSON.parse(toolCall.function.arguments) as {
      reason: string;
    };

    const handoffMap: Record<string, string> = {
      handoff_to_sales: "sales",
      handoff_to_support: "support",
    };

    const target = handoffMap[fnName];
    if (!target) return `Unknown handoff: ${fnName}`;

    console.log(
      `  [Handoff] Triage -> ${agents[target].name} (reason: ${fnArgs.reason})`
    );

    // Step 3: Run target agent
    return runAgent(target, userMessage, client, model);
  }

  return choice.message.content ?? "";
}

export async function main(): Promise<void> {
  validateEnv();

  console.log("=== Multi-Agent Handoffs ===");
  console.log();

  const queries = [
    "How much does the Pro plan cost? I'm thinking of upgrading.",
    "My API calls are returning 500 errors since yesterday. My email is alice@example.com.",
    "I want to buy the Enterprise plan for my team of 50 people.",
  ];

  for (const query of queries) {
    console.log(`User: ${query}`);
    const result = await runWithHandoffs(query);
    console.log(`Agent: ${result}`);
    console.log();
  }
}

const isDirectRun =
  process.argv[1]?.endsWith("03-handoffs.ts") ||
  process.argv[1]?.endsWith("03-handoffs.js");
if (isDirectRun) {
  main();
}
