/**
 * OpenAI Agents SDK Quickstart -- Example Runner
 *
 * Entry point for running individual examples.
 *
 * Usage:
 *   npx tsx index.ts        # List all examples
 *   npx tsx index.ts 1      # Run 01-basic-agent
 *   npx tsx index.ts 3      # Run 03-handoffs
 */

interface ExampleEntry {
  module: string;
  description: string;
}

const examples: Record<string, ExampleEntry> = {
  "1": {
    module: "./01-basic-agent.js",
    description: "Basic Agent -- system prompt + user input",
  },
  "2": {
    module: "./02-tools.js",
    description: "Agent with Tools -- function calling",
  },
  "3": {
    module: "./03-handoffs.js",
    description: "Multi-Agent Handoffs -- triage routing",
  },
  "4": {
    module: "./04-guardrails.js",
    description: "Input/Output Guardrails -- safety checks",
  },
  "5": {
    module: "./05-full-example.js",
    description: "Full Example -- all patterns combined",
  },
};

function showMenu(): void {
  console.log("OpenAI Agents SDK Quickstart Examples");
  console.log("=".repeat(45));
  console.log();
  for (const [key, entry] of Object.entries(examples)) {
    console.log(`  ${key}. ${entry.description}`);
  }
  console.log();
  console.log("Usage: npx tsx index.ts <number>");
  console.log("Example: npx tsx index.ts 1");
}

async function main(): Promise<void> {
  const choice = process.argv[2];

  if (!choice) {
    showMenu();
    return;
  }

  const entry = examples[choice];
  if (!entry) {
    console.error(`Unknown example: ${choice}`);
    console.error(`Valid choices: ${Object.keys(examples).join(", ")}`);
    process.exit(1);
  }

  console.log(`Running: ${entry.description}`);
  console.log();

  const mod = (await import(entry.module)) as { main: () => Promise<void> };
  await mod.main();
}

main();
