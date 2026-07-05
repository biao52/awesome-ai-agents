# Coding Agent

> An agent that reads a codebase, plans changes, writes code, and runs tests in a plan-code-test-fix loop -- like a junior developer that follows instructions precisely.

## What You'll Build

A CLI tool that takes a project directory and a task description, then autonomously: explores the codebase, plans the implementation, writes the code, runs tests, and fixes any failures. It includes a sample Express.js TODO API that you can use to test tasks like "Add input validation" or "Add a /health endpoint."

## What You'll Learn

- How to give agents filesystem access with sandboxed tools (read, write, execute)
- How to implement a plan-code-test-fix loop with automatic error recovery
- How to use Anthropic's native tool use API (not OpenAI function calling)
- How to sandbox agent actions to a project directory (prevent directory traversal)
- How to build interactive agents that show their work as they go

## Architecture

```
User provides: project directory + task description
    ↓
EXPLORE: Agent reads directory structure + key files
    → read_directory(".")
    → read_file("package.json")
    → read_file("index.js")
    ↓
PLAN: Agent describes implementation steps
    ↓
IMPLEMENT: Agent writes code changes
    → write_file("src/validation.js", code)
    → write_file("index.js", updated_code)
    ↓
TEST: Agent runs tests
    → run_command("npm test")              ┐
    ↓                                      │ Fix loop
If tests fail:                             │ (max 3
    → Agent reads error output             │ retries)
    → Fixes the specific issue             │
    → Runs tests again ───────────────────┘
    ↓
Output: Modified project + summary of changes
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
- **Node.js 20+** for the sample project (Express.js TODO API)
- **Estimated cost:** ~$0.05-0.20 per task (depends on codebase size and task complexity)

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

3. Install the sample project's dependencies:
   ```bash
   cd ../sample_project && npm install && cd ../python
   ```

4. Set up your environment:
   ```bash
   cp .env.example .env
   ```

5. Open `.env` and add your Anthropic API key.

6. Run the agent:
   ```bash
   python main.py "Add a GET /health endpoint that returns { status: 'ok', uptime: process.uptime() }"
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

3. Install the sample project's dependencies:
   ```bash
   cd ../sample_project && npm install && cd ../typescript
   ```

4. Set up your environment:
   ```bash
   cp .env.example .env
   ```

5. Open `.env` and add your Anthropic API key.

6. Run the agent:
   ```bash
   npx tsx index.ts "Add a GET /health endpoint that returns { status: 'ok', uptime: process.uptime() }"
   ```

## How It Works

The agent uses **four filesystem tools** exposed via Anthropic's tool use API: `read_directory`, `read_file`, `write_file`, and `run_command`. These are the same primitives that tools like Claude Code use internally. The agent decides which tools to call based on its current phase (exploring, implementing, testing).

All operations are **sandboxed to the project directory**. Before any file read/write, the agent validates that the resolved path starts with the project directory's absolute path. This prevents directory traversal attacks (e.g., writing to `../../.env`). The `run_command` tool blocks obviously dangerous commands (rm -rf /, sudo, etc.) and enforces a 30-second timeout.

The **plan-code-test-fix loop** is the core pattern. After writing code, the agent runs tests. If tests fail, it reads the error output, identifies the issue, writes a fix, and tests again. This continues for up to 3 retries. Most tasks succeed on the first try; the retry loop catches edge cases like missing imports or typos.

The agent operates on the included `sample_project/` -- a simple Express.js TODO API with CRUD endpoints and a test suite. This gives you a safe playground to test tasks. But the agent works on any project directory -- point it at your own code with `--project`.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `MODEL` | No | `claude-sonnet-4-20250514` | Override the Claude model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Agent loop with filesystem tools and command execution |
| `../sample_project/index.js` | Express.js TODO API (the default project to modify) |
| `../sample_project/test.js` | Test suite for the TODO API |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Use the included sample project (default)
python main.py "Add input validation to the POST /todos endpoint"

# Point at your own project
python main.py --project /path/to/your/project "Add error logging middleware"

# Interactive mode
python main.py
```

**Example tasks to try with the sample project:**
- "Add a GET /health endpoint that returns server uptime"
- "Add input validation -- title must be a non-empty string under 200 chars"
- "Add a query parameter to GET /todos to filter by completed status"
- "Add request logging middleware that logs method, path, and response time"
- "Add pagination to GET /todos with ?page=1&limit=10 query params"

## Common Issues & Troubleshooting

**"File not found: package.json" on first run**
- Make sure you installed the sample project dependencies: `cd sample_project && npm install`

**Agent modifies files outside the project**
- This shouldn't happen -- all paths are validated. If it does, please report the issue.

**Tests time out**
- The `run_command` tool has a 30-second timeout. If tests require a running server, the agent should start it in the background or use a test framework that handles server lifecycle.

**Agent gets stuck in a loop**
- There's a 30-iteration maximum. If the agent loops, it's usually stuck on a test failure it can't fix. Try a simpler task or a more specific description.

**Changes to the sample project persist**
- The agent writes directly to the filesystem. To reset: `git checkout sample_project/` or re-clone.

## Extend This Example

- **Add a `git_diff` tool** -- let the agent see what it changed before finishing
- **Add approval gates** -- ask the user "OK to write this file?" before each write_file call
- **Add a `search_code` tool** -- grep/ripgrep for finding references across the codebase
- **Support multiple languages** -- the filesystem tools are language-agnostic; add language-specific test runners
- **Add rollback** -- if the agent's changes break everything, automatically revert to a backup

## Related Examples

- [Code Review Agent](../../starter/code-review-agent) -- Reviews code but doesn't modify it
- [Software Dev Team](../../../multi-agent/software-dev-team) -- Multi-agent version with PM, Architect, Developer, and Reviewer
- [Data Analyst Agent](../../starter/data-analyst-agent) -- Similar code-execution pattern but for data analysis, not software engineering
