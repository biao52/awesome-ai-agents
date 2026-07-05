# Code Review Agent

> An agent that reviews code from a file, GitHub URL, or pasted input and produces a structured quality report with severity-rated findings -- like having a senior engineer review your PR in seconds.

## What You'll Build

A CLI tool that takes any code (local file, public GitHub URL, or piped stdin), sends it to Claude for multi-dimensional analysis, and outputs a structured review with an overall score, critical security issues, warnings, and style suggestions. When you're done, you'll have a reusable code review tool you can drop into any workflow.

## What You'll Learn

- How to use the Anthropic Claude SDK for single-prompt structured analysis (no tool calling needed)
- How to handle multiple input sources (file, URL, stdin) in a CLI agent
- How to craft a detailed system prompt that produces consistent, structured output
- How to implement retry logic with exponential backoff for API resilience
- How to detect programming languages from file extensions and code content

## Architecture

```
User provides code via one of three input methods:
    ┌─────────────────────────────────────────────┐
    │  --file ./app.py                            │
    │  --url github.com/user/repo/blob/main/app.py│
    │  cat app.py | python main.py                │
    └─────────────────┬───────────────────────────┘
                      ↓
              Language detection
              (file extension + heuristics)
                      ↓
              Send to Claude with structured
              system prompt defining review format
                      ↓
              Claude analyzes across dimensions:
              → Security vulnerabilities
              → Bugs and error handling
              → Performance issues
              → Code style and best practices
                      ↓
              Structured output:
              → Overall score (1-10)
              → 🔴 Critical findings
              → 🟡 Warnings
              → 🟢 Suggestions
              → 💡 Summary
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
  - Free tier includes $5 of credits
- **Estimated cost:** ~$0.003-0.01 per review (depends on file size)

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
   # Review a local file
   python main.py --file ./mycode.py

   # Or paste code interactively
   python main.py
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
   # Review a local file
   npx tsx index.ts --file ./mycode.py

   # Or paste code interactively
   npx tsx index.ts
   ```

## How It Works

Unlike the Research Agent (which uses tool calling in a loop), the Code Review Agent uses a **single-prompt pattern**. There's no multi-step reasoning needed -- we send all the code to Claude in one request with a carefully structured system prompt, and Claude returns the complete review. This is the simplest agent pattern: structured input + detailed prompt = structured output.

The system prompt is the core of this agent. It defines three severity levels (Critical, Warning, Suggestion), specifies exactly what to look for (injection flaws, race conditions, resource leaks, N+1 queries, etc.), and enforces a strict output format. The prompt also includes guardrails: "Don't hallucinate line numbers" and "Every criticism must include a fix." These constraints are what make the output actually useful rather than generic.

Input handling supports three modes. The `--file` flag reads from disk with proper error handling for missing files and permission errors. The `--url` flag parses GitHub blob URLs, converts them to raw.githubusercontent.com URLs, and fetches the content (works with any public repo, no auth needed). Stdin mode handles both piped input (`cat file.py | python main.py`) and interactive paste (detects TTY to show a prompt). All three paths converge on the same code string that gets sent to Claude.

The agent includes retry logic with exponential backoff for transient API errors (rate limits, server overload). It retries up to 3 times with 2/4/8 second delays. Language detection uses file extensions first (covers 25+ languages), falling back to content heuristics for stdin input. The detected language is passed to Claude so it can apply language-specific best practices (PEP 8 for Python, Go conventions, etc.).

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `MODEL` | No | `claude-sonnet-4-20250514` | Override the Claude model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: CLI parsing, input handling, and review orchestration |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Review a local file
python main.py --file ./mycode.py

# Review from a public GitHub URL
python main.py --url https://github.com/user/repo/blob/main/src/index.ts

# Pipe code via stdin
cat mycode.py | python main.py

# Interactive mode -- paste code, then Ctrl+D to submit
python main.py

# Show help
python main.py --help
```

**Example output:**

```
🚀 Starting code review agent...
🤖 Model: claude-sonnet-4-20250514

📄 Reviewing: mycode.py
🔎 Detected: Python, 142 lines

🔍 Analyzing...

📊 Code Review Results
═══════════════════════

File: mycode.py (Python, 142 lines)

Overall Score: 6.5/10

🔴 Critical (1)
  Line 45: SQL injection vulnerability
  → User input is interpolated directly into SQL query string
  → Fix: Use parameterized queries: cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))

🟡 Warning (3)
  Line 12: Unused import 'os'
  → Imported but never referenced in the code
  → Fix: Remove the unused import

  Line 67: Bare except clause
  → `except:` catches all exceptions including SystemExit and KeyboardInterrupt
  → Fix: Use `except Exception:` or catch specific exception types

  Line 89: Hardcoded timeout value
  → Magic number 30 used as timeout with no explanation
  → Fix: Extract to a named constant: REQUEST_TIMEOUT = 30

🟢 Suggestions (2)
  Lines 1-10: Missing type hints
  → Function parameters and return types have no type annotations
  → Fix: Add type hints: def process_user(user_id: int) -> dict:

  Lines 100-120: Long function could be decomposed
  → process_all() is 20 lines with multiple responsibilities
  → Fix: Extract validation, processing, and reporting into separate functions

💡 Summary
  The code is functional but has a critical SQL injection vulnerability that must
  be fixed before deployment. Error handling needs improvement -- the bare except
  clause could mask important failures. Adding type hints would improve maintainability.
```

## Common Issues & Troubleshooting

**"Missing environment variables: ANTHROPIC_API_KEY"**
- Make sure you copied `.env.example` to `.env`: `cp .env.example .env`
- Open `.env` and replace `your-anthropic-api-key-here` with your actual key
- Your key should start with `sk-ant-`

**"File not found" when using --file**
- Use a relative or absolute path: `--file ./src/app.py` or `--file /full/path/to/file.py`
- Make sure the file exists: `ls -la ./src/app.py`

**"Invalid GitHub URL format"**
- The URL must be a GitHub blob URL, like: `https://github.com/user/repo/blob/main/src/file.py`
- Raw URLs (`raw.githubusercontent.com`) are not supported directly -- use the blob URL
- Private repos are not supported (the agent fetches without authentication)

**"Rate limit" or "overloaded" errors**
- The agent automatically retries up to 3 times with exponential backoff
- If it still fails, wait a minute and try again
- Check your Anthropic usage dashboard for quota limits

**The review seems too harsh/lenient**
- Claude is calibrated to be constructive. A score of 7/10 is actually quite good.
- For stricter reviews, you could modify the system prompt in the code
- The `temperature` is set to 0.2 for consistency -- increase it for more varied reviews

**Windows: Ctrl+D doesn't work in interactive mode**
- Use Ctrl+Z followed by Enter instead

## Extend This Example

- **Add a `--severity` filter** -- only show Critical findings, or only Warnings and above, to reduce noise on large reviews
- **Add `--format json`** -- output the review as structured JSON for integration with CI/CD pipelines or dashboards
- **Support private GitHub repos** -- add a `GITHUB_TOKEN` env var and pass it as a Bearer token when fetching
- **Batch review** -- accept a directory path and review all code files, producing a combined report
- **Diff-aware review** -- accept a git diff instead of full files, so the agent focuses only on changed lines

## Related Examples

- [Web Scraping Agent](../web-scraping-agent) -- Also uses Anthropic Claude with a single-prompt pattern, but for data extraction instead of analysis
- [Deep Research Agent](../../advanced/deep-research-agent) -- Shows the multi-step tool-calling pattern when you need more than a single prompt
- [PR Review Agent](../../advanced/pr-review-agent) -- An advanced version that fetches PR diffs from GitHub and reviews like a team member
