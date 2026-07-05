"""
Code Review Agent — Reviews code from a file, GitHub URL, or stdin and produces
a structured quality report with severity-rated findings.

Uses Anthropic Claude for analysis (best-in-class for code review).
"""

import os
import re
import sys
import asyncio
from typing import Any

import httpx
from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
MAX_CODE_LENGTH = 100_000  # ~100K chars — well within Claude's context
MAX_RETRIES = 3
REQUEST_TIMEOUT = 60.0

# GitHub URL pattern: github.com/<owner>/<repo>/blob/<branch>/<path>
GITHUB_URL_PATTERN = re.compile(
    r"https?://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.*)"
)

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["ANTHROPIC_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        print("   Get your Anthropic key at: https://console.anthropic.com/settings/keys")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Code input handling — file, URL, stdin
# ---------------------------------------------------------------------------


async def read_from_file(file_path: str) -> tuple[str, str]:
    """Read code from a local file. Returns (code, filename)."""
    abs_path = os.path.abspath(file_path)
    if not os.path.isfile(abs_path):
        print(f"❌ File not found: {file_path}")
        sys.exit(1)

    try:
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            code = f.read()
    except PermissionError:
        print(f"❌ Permission denied: {file_path}")
        sys.exit(1)
    except OSError as e:
        print(f"❌ Could not read file: {e}")
        sys.exit(1)

    if len(code) > MAX_CODE_LENGTH:
        log("⚠️", f"File is very large ({len(code):,} chars). Truncating to {MAX_CODE_LENGTH:,} chars.")
        code = code[:MAX_CODE_LENGTH]

    return code, os.path.basename(abs_path)


async def read_from_github(url: str) -> tuple[str, str]:
    """Fetch code from a GitHub blob URL. Returns (code, filename)."""
    match = GITHUB_URL_PATTERN.match(url)
    if not match:
        print(f"❌ Invalid GitHub URL format: {url}")
        print("   Expected: https://github.com/<owner>/<repo>/blob/<branch>/<path>")
        sys.exit(1)

    owner, repo, branch, file_path = match.groups()
    filename = file_path.split("/")[-1]
    raw_url = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{file_path}"

    log("🌐", f"Fetching from GitHub: {owner}/{repo}/{file_path}")

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            response = await client.get(raw_url, timeout=REQUEST_TIMEOUT)
            response.raise_for_status()
            code = response.text
    except httpx.TimeoutException:
        print(f"❌ Request timed out fetching {raw_url}")
        sys.exit(1)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            print(f"❌ File not found on GitHub: {file_path}")
            print("   Make sure the file path and branch are correct, and the repo is public.")
        else:
            print(f"❌ GitHub returned {e.response.status_code}: {e.response.text[:200]}")
        sys.exit(1)
    except httpx.RequestError as e:
        print(f"❌ Network error fetching from GitHub: {e}")
        sys.exit(1)

    if len(code) > MAX_CODE_LENGTH:
        log("⚠️", f"File is very large ({len(code):,} chars). Truncating to {MAX_CODE_LENGTH:,} chars.")
        code = code[:MAX_CODE_LENGTH]

    return code, filename


def read_from_stdin() -> tuple[str, str]:
    """Read code from stdin (piped input or interactive paste)."""
    if sys.stdin.isatty():
        # Interactive mode — user will paste code
        log("📝", "Paste your code below, then press Ctrl+D (Unix) or Ctrl+Z (Windows) to submit:")
        print()

    try:
        code = sys.stdin.read()
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)

    if not code.strip():
        print("❌ No code provided. Pipe code via stdin or use --file / --url flags.")
        sys.exit(1)

    if len(code) > MAX_CODE_LENGTH:
        log("⚠️", f"Input is very large ({len(code):,} chars). Truncating to {MAX_CODE_LENGTH:,} chars.")
        code = code[:MAX_CODE_LENGTH]

    return code, "stdin"


def detect_language(filename: str, code: str) -> str:
    """Detect programming language from filename extension or code content."""
    ext_map: dict[str, str] = {
        ".py": "Python", ".js": "JavaScript", ".ts": "TypeScript",
        ".tsx": "TypeScript (React)", ".jsx": "JavaScript (React)",
        ".rs": "Rust", ".go": "Go", ".java": "Java", ".kt": "Kotlin",
        ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".cpp": "C++",
        ".c": "C", ".swift": "Swift", ".sh": "Shell", ".sql": "SQL",
        ".html": "HTML", ".css": "CSS", ".yaml": "YAML", ".yml": "YAML",
        ".json": "JSON", ".toml": "TOML", ".md": "Markdown",
    }

    _, ext = os.path.splitext(filename)
    if ext and ext.lower() in ext_map:
        return ext_map[ext.lower()]

    # Fallback: heuristics from code content
    if code.startswith("#!/usr/bin/env python") or "import " in code[:200]:
        return "Python"
    if "function " in code[:500] or "const " in code[:500]:
        return "JavaScript/TypeScript"

    return "Unknown"


# ---------------------------------------------------------------------------
# Code review via Anthropic Claude
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert code reviewer with deep experience across all major programming languages and frameworks. You perform thorough, multi-dimensional code reviews.

Your review MUST cover these categories (skip any that have zero findings):

1. **CRITICAL** — Security vulnerabilities, data loss risks, crashes, race conditions
2. **WARNING** — Bugs, performance issues, error handling gaps, bad practices
3. **SUGGESTION** — Code style, readability, maintainability improvements

For each finding, provide:
- The specific line number(s) or code location
- A clear description of the issue
- A concrete fix or recommendation
- Why it matters (the impact if left unfixed)

At the end, provide:
- An **Overall Score** from 1-10 (10 = production-ready, flawless)
- A **Summary** paragraph assessing the code's fitness for production

Rules:
- Be specific. "Line 45: SQL injection" is good. "Code has issues" is useless.
- Be constructive. Every criticism must include a fix.
- Be honest. If the code is good, say so. Don't invent problems.
- Do NOT hallucinate line numbers. If you can't identify the exact line, describe the location.
- Consider the language's idioms and best practices (e.g., Python PEP 8, Go conventions).
- Look for: injection flaws, hardcoded secrets, unvalidated input, missing error handling,
  resource leaks, race conditions, N+1 queries, unbounded allocations, type safety issues.

Output format (use exactly this structure):

📊 Code Review Results
═══════════════════════

**File:** <filename> (<language>, <line count> lines)

**Overall Score: X/10**

🔴 Critical (<count>)
  Line XX: <title>
  → <description>
  → Fix: <recommendation>

🟡 Warning (<count>)
  Line XX: <title>
  → <description>
  → Fix: <recommendation>

🟢 Suggestions (<count>)
  Line XX: <title>
  → <description>
  → Fix: <recommendation>

💡 Summary
  <2-3 sentence assessment of the code's overall quality and fitness for production>"""


async def review_code(code: str, filename: str, language: str, model: str) -> str:
    """Send code to Claude for review and return the structured review."""
    client = AsyncAnthropic()

    line_count = len(code.splitlines())
    user_message = f"""Review the following code.

**File:** {filename}
**Language:** {language}
**Lines:** {line_count}

```{language.lower().split()[0]}
{code}
```"""

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
                temperature=0.2,  # Low temperature for consistent, focused analysis
            )

            # Extract text content from response
            result = ""
            for block in response.content:
                if block.type == "text":
                    result += block.text

            return result

        except Exception as e:
            error_str = str(e)
            # Retry on transient errors (rate limits, server errors)
            if attempt < MAX_RETRIES and ("rate" in error_str.lower() or "5" in error_str[:1] or "overloaded" in error_str.lower()):
                wait_time = 2 ** attempt
                log("⏳", f"API error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait_time}s...")
                await asyncio.sleep(wait_time)
            else:
                raise


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the code review agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    # Parse CLI arguments
    file_path: str | None = None
    url: str | None = None

    i = 0
    while i < len(args):
        if args[i] == "--file" and i + 1 < len(args):
            file_path = args[i + 1]
            i += 2
        elif args[i] == "--url" and i + 1 < len(args):
            url = args[i + 1]
            i += 2
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py [OPTIONS]")
            print()
            print("Options:")
            print("  --file PATH   Review a local file")
            print("  --url URL     Review code from a GitHub URL")
            print("  (no args)     Read code from stdin (pipe or paste)")
            print()
            print("Examples:")
            print("  python main.py --file ./mycode.py")
            print("  python main.py --url https://github.com/user/repo/blob/main/src/index.ts")
            print("  cat mycode.py | python main.py")
            sys.exit(0)
        else:
            print(f"❌ Unknown argument: {args[i]}")
            print("   Use --help for usage information.")
            sys.exit(1)


    log("🚀", "Starting code review agent...")
    log("🤖", f"Model: {model}")
    print()

    # Get code from the specified source
    if file_path:
        code, filename = await read_from_file(file_path)
        log("📄", f"Reviewing: {filename}")
    elif url:
        code, filename = await read_from_github(url)
    else:
        code, filename = read_from_stdin()
        if filename == "stdin":
            log("📄", "Reviewing code from stdin")

    language = detect_language(filename, code)
    line_count = len(code.splitlines())
    log("🔎", f"Detected: {language}, {line_count:,} lines")
    print()
    log("🔍", "Analyzing...")

    try:
        review = await review_code(code, filename, language, model)
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error during code review: {e}")
        print("   Check your ANTHROPIC_API_KEY and network connection.")
        sys.exit(1)

    print()
    print(review)


if __name__ == "__main__":
    asyncio.run(main())
