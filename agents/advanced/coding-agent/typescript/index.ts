/**
 * Coding Agent -- Reads a codebase, plans changes, writes code, and runs tests
 * in a plan-code-test-fix loop.
 *
 * Uses Anthropic Claude with filesystem and command tools.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { Tool, ContentBlock, ToolUseBlock, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_ITERATIONS = 30;
const COMMAND_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY"];
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
// Sandbox validation
// ---------------------------------------------------------------------------

function isWithinProject(path: string, projectDir: string): boolean {
  const absPath = resolve(join(projectDir, path));
  const absProject = resolve(projectDir);
  return absPath.startsWith(absProject);
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function toolReadDirectory(projectDir: string, path: string): string {
  if (!isWithinProject(path, projectDir))
    return "Error: Path is outside the project directory.";

  const target = join(projectDir, path);
  if (!existsSync(target) || !statSync(target).isDirectory())
    return `Error: Not a directory: ${path}`;

  const skip = new Set([
    "node_modules",
    ".git",
    "__pycache__",
    "dist",
    ".env",
  ]);

  try {
    const entries = readdirSync(target)
      .filter((e) => !skip.has(e))
      .sort()
      .map((e) => {
        const type = statSync(join(target, e)).isDirectory() ? "dir" : "file";
        return `  ${type}: ${e}`;
      });
    return entries.length > 0
      ? `Directory: ${path}\n${entries.join("\n")}`
      : `Directory: ${path} (empty)`;
  } catch {
    return `Error: Permission denied: ${path}`;
  }
}

function toolReadFile(projectDir: string, path: string): string {
  if (!isWithinProject(path, projectDir))
    return "Error: Path is outside the project directory.";

  const target = join(projectDir, path);
  if (!existsSync(target) || !statSync(target).isFile())
    return `Error: File not found: ${path}`;

  try {
    let content = readFileSync(target, "utf-8");
    if (content.length > 50_000) content = content.slice(0, 50_000) + "\n... (truncated)";
    return content;
  } catch {
    return `Error: Permission denied: ${path}`;
  }
}

function toolWriteFile(
  projectDir: string,
  path: string,
  content: string
): string {
  if (!isWithinProject(path, projectDir))
    return "Error: Path is outside the project directory.";

  const target = join(projectDir, path);
  mkdirSync(dirname(target), { recursive: true });

  try {
    writeFileSync(target, content, "utf-8");
    return `File written: ${path} (${content.length} chars)`;
  } catch {
    return `Error: Permission denied: ${path}`;
  }
}

function toolRunCommand(projectDir: string, command: string): string {
  const dangerous = ["rm -rf /", "rm -rf ~", "sudo", "mkfs", "dd if="];
  for (const d of dangerous) {
    if (command.includes(d))
      return `Error: Blocked dangerous command: ${command}`;
  }

  try {
    const stdout = execSync(command, {
      cwd: projectDir,
      timeout: COMMAND_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return (stdout || "(no output)").slice(0, 10_000) + "\n\nExit code: 0";
  } catch (e) {
    const err = e as {
      stdout?: string;
      stderr?: string;
      status?: number;
      killed?: boolean;
    };
    if (err.killed)
      return `Error: Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s`;
    let output = "";
    if (err.stdout) output += err.stdout;
    if (err.stderr) output += (output ? "\n" : "") + err.stderr;
    return (
      (output || String(e)).slice(0, 10_000) +
      `\n\nExit code: ${err.status || 1}`
    );
  }
}

// ---------------------------------------------------------------------------
// Tool definitions for Anthropic
// ---------------------------------------------------------------------------

const tools: Tool[] = [
  {
    name: "read_directory",
    description:
      "List files and directories at a path within the project. Use '.' for the root.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative path within the project (e.g., '.', 'src', 'src/routes')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file within the project.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative file path (e.g., 'index.js', 'src/app.py')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative file path to write",
        },
        content: {
          type: "string",
          description: "The full file content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the project directory. Use for: installing deps (npm install), running tests (npm test), starting servers, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description:
            "Shell command to execute (e.g., 'npm test', 'npm install express')",
        },
      },
      required: ["command"],
    },
  },
];

const SYSTEM_PROMPT = `You are an expert coding agent. You can read, write, and execute code within a project directory.

Your workflow:
1. EXPLORE: First, read the directory structure and key files to understand the project
2. PLAN: Describe what changes you'll make and why (show the plan to the user)
3. IMPLEMENT: Write the code changes using write_file
4. TEST: Run tests using run_command to verify your changes work
5. FIX: If tests fail, read the errors, fix the code, and test again (max 3 retries)

Rules:
- Always explore the project structure before making changes
- Read existing files before modifying them to understand the current code
- Write complete file contents (not patches) when using write_file
- Run tests after every change to verify nothing is broken
- If tests fail, read the error carefully and fix the specific issue
- Keep your changes minimal and focused on the task
- Follow the project's existing code style and conventions
- Don't modify files outside the project directory
- Explain your changes as you make them

When you're done, provide a summary of all changes made.`;

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

async function runAgent(
  task: string,
  projectDir: string,
  model: string
): Promise<string> {
  const client = new Anthropic();
  const absProject = resolve(projectDir);

  type MessageParam = Anthropic.MessageParam;
  const messages: MessageParam[] = [
    {
      role: "user",
      content: `Project directory: ${absProject}\n\nTask: ${task}`,
    },
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages,
        tools,
        temperature: 0.2,
      });
    } catch (e) {
      const errorStr = String(e).toLowerCase();
      if (errorStr.includes("rate") || errorStr.includes("overloaded")) {
        const wait = Math.pow(2, (iteration % 3) + 1);
        log("⏳", `API rate limit, retrying in ${wait}s...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw e;
    }

    const assistantContent = response.content;

    // Print text blocks
    for (const block of assistantContent) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`\n${block.text}`);
      }
    }

    messages.push({ role: "assistant", content: assistantContent });

    if (response.stop_reason === "end_turn") {
      return assistantContent
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
    }

    // Process tool calls
    const toolResults: ToolResultBlockParam[] = [];
    for (const block of assistantContent) {
      if (block.type !== "tool_use") continue;
      const tb = block as ToolUseBlock;
      const input = tb.input as Record<string, string>;

      let result: string;

      if (tb.name === "read_directory") {
        log("📂", `Reading directory: ${input.path}`);
        result = toolReadDirectory(absProject, input.path);
      } else if (tb.name === "read_file") {
        log("📄", `Reading file: ${input.path}`);
        result = toolReadFile(absProject, input.path);
      } else if (tb.name === "write_file") {
        log("✏️", `Writing file: ${input.path}`);
        result = toolWriteFile(absProject, input.path, input.content);
      } else if (tb.name === "run_command") {
        log("🔧", `Running: ${input.command}`);
        result = toolRunCommand(absProject, input.command);
        result
          .split("\n")
          .slice(0, 20)
          .forEach((line) => console.log(`   ${line}`));
        if (result.split("\n").length > 20) console.log("   ... (output truncated)");
      } else {
        result = `Unknown tool: ${tb.name}`;
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: tb.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return "Agent reached maximum iterations.";
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npx tsx index.ts [--project DIR] [TASK]");
    console.log();
    console.log("Arguments:");
    console.log(
      "  --project DIR  Path to the project directory (default: ../sample_project)"
    );
    console.log(
      "  TASK           Description of the coding task (prompts if not given)"
    );
    process.exit(0);
  }

  let projectDir: string | null = null;
  const taskParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && i + 1 < args.length) {
      projectDir = args[++i];
    } else {
      taskParts.push(args[i]);
    }
  }

  if (!projectDir) {
    const defaultDir = join(import.meta.dirname ?? ".", "..", "sample_project");
    if (existsSync(defaultDir)) {
      projectDir = defaultDir;
    } else {
      console.error(
        "❌ Please specify a project directory with --project DIR"
      );
      process.exit(1);
    }
  }

  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    console.error(`❌ Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  let task = taskParts.join(" ");
  if (!task) {
    process.stdout.write("💻 What coding task should I do? ");
    task = await new Promise<string>((resolve) => {
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

  if (!task.trim()) {
    console.error("❌ Please provide a task description.");
    process.exit(1);
  }

  log("🚀", "Starting coding agent...");
  log("🤖", `Model: ${model}`);
  log("📁", `Project: ${resolve(projectDir)}`);
  log("📋", `Task: ${task}`);
  console.log();

  try {
    await runAgent(task, projectDir, model);
  } catch (e) {
    console.error(`\n❌ Error: ${e}`);
    process.exit(1);
  }

  console.log("\n" + "=".repeat(60));
  log("✅", "Coding agent complete!");
}

main().catch(console.error);
