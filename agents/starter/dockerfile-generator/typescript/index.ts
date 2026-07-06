/**
 * Dockerfile Generator Agent -- Reads a project directory and generates an
 * optimized multi-stage Dockerfile with best practices.
 *
 * Uses Anthropic Claude for intelligent Dockerfile generation.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_RETRIES = 3;
const MAX_FILE_SIZE = 50_000;

/** Files that indicate project language/framework */
const PROJECT_FILES = [
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg",
  "Cargo.toml", "Cargo.lock",
  "go.mod", "go.sum",
  "pom.xml", "build.gradle", "build.gradle.kts",
  "Gemfile", "Gemfile.lock",
  "composer.json",
  "mix.exs",
  "Makefile", "CMakeLists.txt",
  ".nvmrc", ".python-version", ".ruby-version", ".tool-versions",
  ".dockerignore", "Dockerfile",
  "tsconfig.json", "next.config.js", "next.config.mjs", "next.config.ts",
  "vite.config.ts", "vite.config.js",
  "nuxt.config.ts", "angular.json",
  "nginx.conf", "supervisord.conf",
];

/** Directories to skip when scanning */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", "env",
  "target", "dist", "build", ".next", ".nuxt", "vendor",
  ".tox", ".mypy_cache", ".pytest_cache", "coverage",
]);

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
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
// Project scanning
// ---------------------------------------------------------------------------

interface ProjectContext {
  path: string;
  tree: string;
  files: Record<string, string>;
}

function getDirectoryTree(projectPath: string, maxDepth: number = 3): string {
  const lines: string[] = [];

  function walk(dirPath: string, prefix: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dirPath).sort();
    } catch {
      return;
    }

    const dirs: string[] = [];
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory() && !SKIP_DIRS.has(entry)) {
          dirs.push(entry);
        } else if (stat.isFile()) {
          files.push(entry);
        }
      } catch {
        // Skip entries we can't stat
      }
    }

    for (const f of files) {
      lines.push(`${prefix}${f}`);
    }

    for (const d of dirs) {
      lines.push(`${prefix}${d}/`);
      walk(join(dirPath, d), prefix + "  ", depth + 1);
    }
  }

  lines.push(`${basename(projectPath)}/`);
  walk(projectPath, "  ", 1);

  return lines.slice(0, 200).join("\n");
}

function readProjectFile(projectPath: string, filename: string): string | null {
  const filePath = join(projectPath, filename);
  if (!existsSync(filePath)) return null;

  try {
    let content = readFileSync(filePath, "utf-8");
    if (content.length > MAX_FILE_SIZE) {
      content = content.slice(0, MAX_FILE_SIZE) + "\n... (truncated)";
    }
    return content;
  } catch {
    return null;
  }
}

function scanProject(projectPath: string): ProjectContext {
  log("📂", `Scanning project: ${projectPath}`);

  const context: ProjectContext = {
    path: projectPath,
    tree: getDirectoryTree(projectPath),
    files: {},
  };

  let foundCount = 0;
  for (const filename of PROJECT_FILES) {
    const content = readProjectFile(projectPath, filename);
    if (content !== null) {
      context.files[filename] = content;
      foundCount++;
      log("  📄", `Found: ${filename}`);
    }
  }

  if (foundCount === 0) {
    log(
      "⚠️",
      "No recognized project files found. The Dockerfile will be based on directory structure only."
    );
  }

  return context;
}

// ---------------------------------------------------------------------------
// Dockerfile generation via Anthropic Claude
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert DevOps engineer specializing in Docker containerization. You generate production-grade, optimized Dockerfiles.

Your Dockerfiles MUST follow these best practices:

1. **Multi-stage builds** -- separate build and runtime stages to minimize image size
2. **Small base images** -- use Alpine or slim variants when possible (e.g., node:22-alpine, python:3.12-slim)
3. **Layer caching** -- copy dependency files first, install, then copy source code
4. **Non-root user** -- create and switch to a non-root user for security
5. **Health check** -- include a HEALTHCHECK instruction where applicable
6. **.dockerignore awareness** -- mention key files to add to .dockerignore
7. **Minimal final image** -- only copy necessary artifacts to the runtime stage
8. **Pinned versions** -- use specific version tags, never use :latest
9. **Combined RUN commands** -- reduce layers by combining related commands with &&
10. **Proper signal handling** -- use exec form for CMD, not shell form

Output ONLY the Dockerfile content. No markdown fencing, no explanations before or after. Just the raw Dockerfile.

Add brief, helpful comments in the Dockerfile itself explaining key decisions (e.g., why a specific base image was chosen, what each stage does).

If you see an existing Dockerfile in the project files, improve upon it rather than starting from scratch. Preserve any project-specific configuration while applying best practices.`;

async function generateDockerfile(
  context: ProjectContext,
  model: string
): Promise<string> {
  const client = new Anthropic();

  const parts: string[] = [
    "Generate an optimized, production-ready Dockerfile for this project.\n",
    `## Directory Structure\n\`\`\`\n${context.tree}\n\`\`\`\n`,
  ];

  for (const [filename, content] of Object.entries(context.files)) {
    parts.push(`## ${filename}\n\`\`\`\n${content}\n\`\`\`\n`);
  }

  const userMessage = parts.join("\n");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        temperature: 0.2,
      });

      let result = "";
      for (const block of response.content) {
        if (block.type === "text") {
          result += block.text;
        }
      }

      return result.trim();
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
          "⏳",
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
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let projectPath = ".";
  let outputPath: string | null = null;

  // Parse CLI arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && i + 1 < args.length) {
      projectPath = args[i + 1];
      i++;
    } else if ((args[i] === "--output" || args[i] === "-o") && i + 1 < args.length) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [OPTIONS]");
      console.log();
      console.log("Options:");
      console.log("  --project PATH   Path to the project directory (default: .)");
      console.log("  --output PATH    Save the Dockerfile to this path");
      console.log();
      console.log("Examples:");
      console.log("  npx tsx index.ts");
      console.log("  npx tsx index.ts --project /path/to/project");
      console.log("  npx tsx index.ts --output Dockerfile");
      process.exit(0);
    } else {
      console.error(`❌ Unknown argument: ${args[i]}`);
      console.error("   Use --help for usage information.");
      process.exit(1);
    }
  }

  const resolvedPath = resolve(projectPath);
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
    console.error(`❌ Not a directory: ${projectPath}`);
    process.exit(1);
  }

  log("🚀", "Starting Dockerfile generator agent...");
  log("🤖", `Model: ${model}`);
  console.log();

  const context = scanProject(resolvedPath);
  console.log();

  log("🔧", "Generating optimized Dockerfile...");

  let dockerfile: string;
  try {
    dockerfile = await generateDockerfile(context, model);
  } catch (e) {
    console.error(`\n❌ Error generating Dockerfile: ${e}`);
    console.error("   Check your ANTHROPIC_API_KEY and network connection.");
    process.exit(1);
  }

  console.log();

  if (outputPath) {
    try {
      writeFileSync(outputPath, dockerfile + "\n", "utf-8");
      log("✅", `Dockerfile saved to: ${outputPath}`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.error(`❌ Could not write file: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log("─".repeat(60));
    console.log(dockerfile);
    console.log("─".repeat(60));
    console.log();
    log("💡", "Tip: Use --output Dockerfile to save directly to a file.");
  }

  log("✅", "Done!");
}

main().catch(console.error);
