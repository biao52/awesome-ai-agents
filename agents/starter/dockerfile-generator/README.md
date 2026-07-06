# Dockerfile Generator Agent

> An agent that reads your project's files and directory structure, then generates an optimized multi-stage Dockerfile with best practices -- like having a senior DevOps engineer containerize your app.

## What You'll Build

A CLI tool that scans a project directory, detects the language and framework, sends the context to Claude, and receives a production-ready Dockerfile with multi-stage builds, layer caching, non-root user, and health checks.

## What You'll Learn

- How to use the Anthropic Claude SDK for single-prompt structured generation
- How to scan a project directory and extract relevant context for an LLM
- How to craft a system prompt that enforces specific output format and best practices
- How to implement retry logic with exponential backoff for API resilience
- How to handle CLI arguments with argparse (Python) and manual parsing (TypeScript)

## Architecture

```
User points agent at a project directory
    ┌─────────────────────────────────────────────┐
    │  python main.py                             │
    │  python main.py --project /path/to/project  │
    │  python main.py --output Dockerfile         │
    └─────────────────┬───────────────────────────┘
                      ↓
              Scan project directory:
              → Read package.json, requirements.txt,
                Cargo.toml, go.mod, etc.
              → Build directory tree
                      ↓
              Send to Claude with system prompt
              enforcing Docker best practices
                      ↓
              Claude generates optimized Dockerfile:
              → Multi-stage build
              → Small base image (Alpine/slim)
              → Layer caching for dependencies
              → Non-root user
              → Health check
                      ↓
              Output to stdout or save to file
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
  - Free tier includes $5 of credits
- **Estimated cost:** ~$0.003-0.01 per generation (depends on project size)

## Quick Start

### Python

1. Navigate to the Python directory:
   ```bash
   cd python
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Set up your environment:
   ```bash
   cp .env.example .env
   ```

4. Open `.env` and add your Anthropic API key (get one from the link above).

5. Run the agent:
   ```bash
   # Generate Dockerfile for current directory
   python main.py

   # Or specify a project path
   python main.py --project /path/to/your/project

   # Save to file
   python main.py --output Dockerfile
   ```

### TypeScript

1. Navigate to the TypeScript directory:
   ```bash
   cd typescript
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your environment:
   ```bash
   cp .env.example .env
   ```

4. Open `.env` and add your Anthropic API key.

5. Run the agent:
   ```bash
   # Generate Dockerfile for current directory
   npx tsx index.ts

   # Or specify a project path
   npx tsx index.ts --project /path/to/your/project

   # Save to file
   npx tsx index.ts --output Dockerfile
   ```

## How It Works

The agent uses a **single-prompt pattern** -- it collects all project context up front, sends it to Claude in one request with a detailed system prompt, and gets back the complete Dockerfile. No tool calling or multi-step reasoning needed. This is the simplest effective agent pattern for generation tasks.

The scanning phase walks the project directory (up to 3 levels deep, skipping node_modules, .git, and similar) and reads a curated list of project files -- package.json, requirements.txt, Cargo.toml, go.mod, and 30+ others. These files give Claude enough context to determine the language, framework, build process, and runtime requirements. The directory tree provides additional structural hints (e.g., a `src/` and `dist/` directory suggests a compiled language with a build step).

The system prompt is the core of this agent. It enforces 10 specific best practices: multi-stage builds, Alpine/slim base images, dependency-first layer caching, non-root users, health checks, and more. By being explicit about what "good" looks like, the prompt consistently produces Dockerfiles that follow production standards rather than naive single-stage builds.

If an existing Dockerfile is found in the project, Claude improves upon it rather than starting from scratch. This makes the agent useful both for new projects and for optimizing existing Docker setups. The output is raw Dockerfile content (no markdown fencing), so you can pipe it directly to a file.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `MODEL` | No | `claude-sonnet-4-20250514` | Override the Claude model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: CLI parsing, project scanning, and Dockerfile generation |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Generate for current directory
python main.py

# Generate for a specific project
python main.py --project /path/to/project

# Save to file
python main.py --output Dockerfile

# Combine flags
python main.py --project ../my-app --output ../my-app/Dockerfile

# Show help
python main.py --help
```

**Example output:**

```
🚀 Starting Dockerfile generator agent...
🤖 Model: claude-sonnet-4-20250514

📂 Scanning project: /path/to/my-node-app
  📄 Found: package.json
  📄 Found: package-lock.json
  📄 Found: tsconfig.json

🔧 Generating optimized Dockerfile...

────────────────────────────────────────────────────────────
# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency files first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine AS runtime

RUN addgroup -g 1001 appgroup && \
    adduser -u 1001 -G appgroup -s /bin/sh -D appuser

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --production && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER appuser

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

EXPOSE 3000
CMD ["node", "dist/index.js"]
────────────────────────────────────────────────────────────

💡 Tip: Use --output Dockerfile to save directly to a file.
✅ Done!
```

## Common Issues & Troubleshooting

**"Missing environment variables: ANTHROPIC_API_KEY"**
- Make sure you copied `.env.example` to `.env`: `cp .env.example .env`
- Open `.env` and replace `your-anthropic-api-key-here` with your actual key
- Your key should start with `sk-ant-`

**"Not a directory" error**
- Make sure the `--project` path exists and is a directory
- Use an absolute path if relative paths cause issues

**"No recognized project files found"**
- The agent looks for common project files (package.json, requirements.txt, etc.)
- If your project uses an unusual structure, the Dockerfile will be based on directory layout only
- You can add more file patterns to the `PROJECT_FILES` list in the code

**The generated Dockerfile doesn't work**
- The Dockerfile is a starting point -- always test with `docker build .`
- You may need to adjust paths, port numbers, or build commands for your specific project
- Make sure you have a `.dockerignore` file to exclude node_modules, .git, etc.

**"Rate limit" or "overloaded" errors**
- The agent automatically retries up to 3 times with exponential backoff
- If it still fails, wait a minute and try again

## Extend This Example

- **Add `--platform` flag** -- generate Dockerfiles optimized for specific platforms (e.g., ARM, x86) with appropriate base images
- **Add `.dockerignore` generation** -- analyze the project and generate a matching `.dockerignore` file alongside the Dockerfile
- **Add `docker-compose.yml` generation** -- detect databases, caches, and other services from the project and generate a complete compose file
- **Add `--validate` flag** -- run `docker build` after generation and feed build errors back to Claude for automatic fixes
- **Support monorepo scanning** -- detect workspace roots (npm workspaces, Cargo workspaces) and generate per-service Dockerfiles

## Related Examples

- [Code Review Agent](../code-review-agent) -- Also uses Anthropic Claude with a single-prompt pattern, but for code analysis instead of generation
- [Web Scraping Agent](../web-scraping-agent) -- Another single-prompt pattern that extracts structured data from HTML
- [Coding Agent](../../advanced/coding-agent) -- A multi-step agent that reads codebases and writes code with a plan-execute-test loop
