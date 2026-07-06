"""
PR Review Agent -- Fetches a pull request diff from GitHub and reviews it
like a senior engineer, producing a structured quality report.

Uses Anthropic Claude for analysis and httpx for GitHub API access.
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
MAX_DIFF_LENGTH = 200_000  # ~200K chars -- well within Claude's context
MAX_RETRIES = 3
REQUEST_TIMEOUT = 60.0

# Matches: https://github.com/owner/repo/pull/123
GITHUB_PR_URL_PATTERN = re.compile(
    r"https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)"
)

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        if "ANTHROPIC_API_KEY" in missing:
            print("   Get your Anthropic key at: https://console.anthropic.com/settings/keys")
        if "GITHUB_TOKEN" in missing:
            print("   Create a GitHub token at: https://github.com/settings/tokens")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# GitHub API
# ---------------------------------------------------------------------------


async def fetch_pr_info(
    client: httpx.AsyncClient, owner: str, repo: str, number: int
) -> dict[str, Any]:
    """Fetch pull request metadata from GitHub API."""
    url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}"
    headers = {
        "Authorization": f"token {os.getenv('GITHUB_TOKEN')}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "pr-review-agent",
    }

    response = await client.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    if response.status_code == 404:
        print(f"❌ Pull request not found: {owner}/{repo}#{number}")
        print("   Check the repository and PR number. Private repos need a token with repo scope.")
        sys.exit(1)
    if response.status_code == 401:
        print("❌ GitHub authentication failed. Check your GITHUB_TOKEN.")
        sys.exit(1)
    response.raise_for_status()
    return response.json()


async def fetch_pr_diff(
    client: httpx.AsyncClient, owner: str, repo: str, number: int
) -> str:
    """Fetch the raw diff for a pull request."""
    url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}"
    headers = {
        "Authorization": f"token {os.getenv('GITHUB_TOKEN')}",
        "Accept": "application/vnd.github.v3.diff",
        "User-Agent": "pr-review-agent",
    }

    response = await client.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()

    diff = response.text
    if len(diff) > MAX_DIFF_LENGTH:
        diff = diff[:MAX_DIFF_LENGTH] + "\n\n... (diff truncated -- too large)"
        log("⚠️", f"Diff truncated from {len(response.text)} to {MAX_DIFF_LENGTH} chars")

    return diff


async def fetch_pr_files(
    client: httpx.AsyncClient, owner: str, repo: str, number: int
) -> list[dict[str, Any]]:
    """Fetch the list of changed files for a pull request."""
    url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}/files"
    headers = {
        "Authorization": f"token {os.getenv('GITHUB_TOKEN')}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "pr-review-agent",
    }

    response = await client.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    return response.json()


# ---------------------------------------------------------------------------
# Parse CLI arguments
# ---------------------------------------------------------------------------


def parse_pr_ref(args: list[str]) -> tuple[str, str, int]:
    """Parse owner, repo, and PR number from CLI args.

    Accepts:
      - owner/repo 123
      - https://github.com/owner/repo/pull/123
    """
    if len(args) == 0:
        print("Usage: python main.py owner/repo 123")
        print("       python main.py https://github.com/owner/repo/pull/123")
        sys.exit(1)

    # Try URL format first
    if len(args) >= 1:
        match = GITHUB_PR_URL_PATTERN.match(args[0])
        if match:
            return match.group(1), match.group(2), int(match.group(3))

    # Try owner/repo number format
    if len(args) >= 2:
        repo_ref = args[0]
        if "/" in repo_ref:
            parts = repo_ref.split("/", 1)
            try:
                number = int(args[1])
                return parts[0], parts[1], number
            except ValueError:
                pass

    print("❌ Could not parse PR reference.")
    print("   Usage: python main.py owner/repo 123")
    print("          python main.py https://github.com/owner/repo/pull/123")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Build review context
# ---------------------------------------------------------------------------


def build_file_summary(files: list[dict[str, Any]]) -> str:
    """Build a summary of changed files."""
    lines: list[str] = []
    for f in files:
        status = f.get("status", "modified")
        additions = f.get("additions", 0)
        deletions = f.get("deletions", 0)
        filename = f.get("filename", "unknown")
        lines.append(f"  {status}: {filename} (+{additions} -{deletions})")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a senior software engineer conducting a thorough code review of a pull request. You have deep expertise in security, performance, reliability, and software design.

Review the PR diff carefully and produce a structured review. Be specific -- reference exact file names and line numbers from the diff. Do not invent issues that are not visible in the diff.

Your review must follow this exact format:

## Overall Assessment
[1-2 sentences summarizing the PR quality and readiness to merge]

## Score: X/10
[Single line with numeric score]

## Critical Issues (must fix before merge)
[Each issue on its own line with this format:]
- **[FILE:LINE]** CATEGORY: Description of the issue and why it matters
  Fix: Specific suggestion for how to resolve it

## Warnings (should fix)
[Same format as critical issues]

## Suggestions (nice to have)
[Same format]

## What's Good
[2-3 bullet points about what the PR does well]

Categories to check:
- SECURITY: SQL injection, XSS, auth bypasses, secret exposure, path traversal
- BUG: Logic errors, off-by-one, null/undefined handling, race conditions
- PERFORMANCE: N+1 queries, unnecessary allocations, missing indexes, blocking I/O
- ERROR HANDLING: Swallowed errors, missing validation, unclear error messages
- DESIGN: Code duplication, tight coupling, unclear naming, missing abstractions
- TESTING: Missing tests, untested edge cases, flaky test patterns
- TYPES: Missing or incorrect type annotations, unsafe casts

Rules:
- Only flag real issues visible in the diff. Do not speculate about code you cannot see.
- Be constructive. Every criticism must include a concrete fix suggestion.
- Severity matters: Critical means "this will cause a bug or security vulnerability in production."
  Warning means "this will cause problems eventually." Suggestion means "this would be better."
- If the PR looks good, say so. Not every PR has critical issues.
- Keep the review concise. Quality over quantity."""


# ---------------------------------------------------------------------------
# Review agent
# ---------------------------------------------------------------------------


async def review_pr(
    pr_info: dict[str, Any],
    diff: str,
    file_summary: str,
    model: str,
) -> str:
    """Send the PR diff to Claude for review."""
    client = AsyncAnthropic()

    pr_title = pr_info.get("title", "Untitled")
    pr_body = pr_info.get("body", "") or "(no description)"
    pr_author = pr_info.get("user", {}).get("login", "unknown")
    pr_base = pr_info.get("base", {}).get("ref", "main")
    pr_head = pr_info.get("head", {}).get("ref", "unknown")

    user_message = f"""Review this pull request.

**PR Title:** {pr_title}
**Author:** {pr_author}
**Branch:** {pr_head} -> {pr_base}

**PR Description:**
{pr_body[:2000]}

**Changed Files:**
{file_summary}

**Diff:**
```diff
{diff}
```

Produce your structured review now."""

    for attempt in range(MAX_RETRIES):
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
                temperature=0.2,
            )
            result = ""
            for block in response.content:
                if block.type == "text":
                    result += block.text
            return result

        except Exception as e:
            error_str = str(e).lower()
            if "rate" in error_str or "overloaded" in error_str:
                wait = 2 ** (attempt + 1)
                log("⏳", f"API rate limit, retrying in {wait}s...")
                await asyncio.sleep(wait)
                continue
            raise

    return "Error: Failed to get review after multiple retries."


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    if "--help" in args or "-h" in args:
        print("Usage: python main.py owner/repo 123")
        print("       python main.py https://github.com/owner/repo/pull/123")
        print()
        print("Reviews a GitHub pull request like a senior engineer.")
        print()
        print("Environment variables:")
        print("  ANTHROPIC_API_KEY  Your Anthropic API key (required)")
        print("  GITHUB_TOKEN       GitHub personal access token (required)")
        print("  MODEL              Override the Claude model (default: claude-sonnet-4-20250514)")
        sys.exit(0)

    owner, repo, number = parse_pr_ref(args)

    log("🚀", "Starting PR review agent...")
    log("🤖", f"Model: {model}")
    log("📋", f"Reviewing: {owner}/{repo}#{number}")
    print()

    async with httpx.AsyncClient() as http_client:
        # Fetch PR data in parallel
        log("🔍", "Fetching PR data from GitHub...")
        pr_info, diff, files = await asyncio.gather(
            fetch_pr_info(http_client, owner, repo, number),
            fetch_pr_diff(http_client, owner, repo, number),
            fetch_pr_files(http_client, owner, repo, number),
        )

    pr_title = pr_info.get("title", "Untitled")
    additions = pr_info.get("additions", 0)
    deletions = pr_info.get("deletions", 0)
    changed_files = pr_info.get("changed_files", 0)

    log("📄", f"PR: {pr_title}")
    log("📊", f"Stats: {changed_files} files changed, +{additions} -{deletions}")
    print()

    file_summary = build_file_summary(files)
    log("📝", f"Diff size: {len(diff)} chars")
    log("🧠", "Sending to Claude for review...")
    print()

    review = await review_pr(pr_info, diff, file_summary, model)

    print("=" * 60)
    print(f"📊 Code Review: {owner}/{repo}#{number}")
    print("=" * 60)
    print()
    print(review)
    print()
    print("=" * 60)
    log("✅", "Review complete!")


if __name__ == "__main__":
    asyncio.run(main())
