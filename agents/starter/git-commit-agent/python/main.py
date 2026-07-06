"""
Git Commit Agent -- Reads a git diff and generates a conventional commit message
using Claude. Optionally applies the commit automatically.

Uses Anthropic Claude for analysis (best-in-class for code understanding).
"""

import os
import sys
import asyncio
import subprocess
from typing import Any

from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
MAX_DIFF_LENGTH = 80_000  # ~80K chars -- well within Claude's context
MAX_RETRIES = 3

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
# Git helpers
# ---------------------------------------------------------------------------


def run_git(args: list[str]) -> tuple[str, int]:
    """Run a git command and return (stdout, return_code)."""
    try:
        result = subprocess.run(
            ["git"] + args,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.stdout, result.returncode
    except FileNotFoundError:
        print("❌ git is not installed or not in PATH.")
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("❌ git command timed out.")
        sys.exit(1)


def get_diff() -> str:
    """Get the git diff. Tries staged changes first, falls back to unstaged."""
    # Try staged changes first
    staged_diff, rc = run_git(["diff", "--cached"])
    if rc != 0:
        print("❌ Not a git repository or git error.")
        sys.exit(1)

    if staged_diff.strip():
        log("📋", "Using staged changes (git diff --cached)")
        return staged_diff

    # Fall back to unstaged changes
    unstaged_diff, rc = run_git(["diff"])
    if rc != 0:
        print("❌ Failed to get git diff.")
        sys.exit(1)

    if unstaged_diff.strip():
        log("📋", "No staged changes found, using unstaged changes (git diff)")
        return unstaged_diff

    print("❌ No changes detected. Stage some changes or modify files first.")
    print("   Try: git add <files> and then run this agent again.")
    sys.exit(1)


def get_repo_context() -> str:
    """Get brief repo context for better commit messages."""
    # Get the repo name from the remote or directory
    remote_url, _ = run_git(["config", "--get", "remote.origin.url"])
    repo_name = remote_url.strip().split("/")[-1].replace(".git", "") if remote_url.strip() else ""

    # Get recent commit messages for style matching
    recent_log, _ = run_git(["log", "--oneline", "-5", "--no-decorate"])

    context_parts: list[str] = []
    if repo_name:
        context_parts.append(f"Repository: {repo_name}")
    if recent_log.strip():
        context_parts.append(f"Recent commits (for style reference):\n{recent_log.strip()}")

    return "\n".join(context_parts)


# ---------------------------------------------------------------------------
# Commit message generation via Claude
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert at writing git commit messages following the Conventional Commits specification.

Given a git diff, generate a single commit message that:

1. Uses a conventional commit type prefix:
   - feat: A new feature
   - fix: A bug fix
   - refactor: Code change that neither fixes a bug nor adds a feature
   - docs: Documentation only changes
   - test: Adding or updating tests
   - chore: Changes to build process, tooling, or auxiliary files
   - style: Formatting, whitespace, semicolons (no logic change)
   - perf: Performance improvement
   - ci: CI/CD configuration changes

2. Includes an optional scope in parentheses after the type (e.g., feat(auth): ...)

3. Has a concise subject line (50-72 characters) in imperative mood ("add" not "added")

4. Optionally includes a body (separated by a blank line) if the change is complex enough to warrant explanation

Rules:
- Analyze the actual code changes, not just file names
- The subject line must be lowercase (except proper nouns)
- No period at the end of the subject line
- The body should explain WHAT changed and WHY, not HOW
- If multiple unrelated changes exist, focus on the primary change
- Be specific: "fix null check in user auth" is better than "fix bug"
- Match the style of recent commits if provided

Output ONLY the commit message -- no explanations, no markdown fencing, no prefixes like "Here's the commit message:". Just the raw commit message text."""


async def generate_commit_message(diff: str, context: str, model: str) -> str:
    """Send the diff to Claude and return the generated commit message."""
    client = AsyncAnthropic()

    # Truncate diff if too large
    if len(diff) > MAX_DIFF_LENGTH:
        log("⚠️", f"Diff is large ({len(diff):,} chars). Truncating to {MAX_DIFF_LENGTH:,} chars.")
        diff = diff[:MAX_DIFF_LENGTH]

    stat_output, _ = run_git(["diff", "--cached", "--stat"])
    if not stat_output.strip():
        stat_output, _ = run_git(["diff", "--stat"])

    context_section = f"Context:\n{context}\n\n" if context else ""
    user_message = f"""Generate a conventional commit message for this diff.

{context_section}Diff stats:
{stat_output.strip()}

Full diff:
```
{diff}
```"""

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=512,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
                temperature=0.3,
            )

            result = ""
            for block in response.content:
                if block.type == "text":
                    result += block.text

            return result.strip()

        except Exception as e:
            error_str = str(e)
            is_transient = any(
                keyword in error_str.lower()
                for keyword in ["rate", "overloaded", "529", "500"]
            )
            if attempt < MAX_RETRIES and is_transient:
                wait_time = 2 ** attempt
                log("⏳", f"API error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait_time}s...")
                await asyncio.sleep(wait_time)
            else:
                raise

    raise RuntimeError("Unreachable: max retries exceeded")


def apply_commit(message: str) -> None:
    """Run git commit with the generated message."""
    # Check if there are staged changes
    staged_diff, _ = run_git(["diff", "--cached"])
    if not staged_diff.strip():
        print("❌ No staged changes to commit. Stage your changes first:")
        print("   git add <files>")
        sys.exit(1)

    output, rc = run_git(["commit", "-m", message])
    if rc != 0:
        print(f"❌ git commit failed:\n{output}")
        sys.exit(1)

    log("✅", "Commit created successfully!")
    # Show the commit
    commit_info, _ = run_git(["log", "--oneline", "-1"])
    if commit_info.strip():
        log("📝", commit_info.strip())


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the git commit agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    # Parse CLI arguments
    apply = False
    i = 0
    while i < len(args):
        if args[i] == "--apply":
            apply = True
            i += 1
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py [OPTIONS]")
            print()
            print("Reads your git diff and generates a conventional commit message.")
            print()
            print("Options:")
            print("  --apply    Apply the generated commit message (runs git commit)")
            print("  --help     Show this help message")
            print()
            print("Examples:")
            print("  python main.py              # Generate a commit message")
            print("  python main.py --apply      # Generate and apply the commit")
            print()
            print("The agent uses staged changes (git diff --cached) if available,")
            print("otherwise falls back to unstaged changes (git diff).")
            sys.exit(0)
        else:
            print(f"❌ Unknown argument: {args[i]}")
            print("   Use --help for usage information.")
            sys.exit(1)
        i += 1

    log("🚀", "Starting git commit agent...")
    log("🤖", f"Model: {model}")
    print()

    # Get the diff
    diff = get_diff()
    line_count = len(diff.splitlines())
    log("📊", f"Diff size: {line_count:,} lines")
    print()

    # Get repo context for better messages
    context = get_repo_context()

    # Generate commit message
    log("🔍", "Analyzing changes...")

    try:
        message = await generate_commit_message(diff, context, model)
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error generating commit message: {e}")
        print("   Check your ANTHROPIC_API_KEY and network connection.")
        sys.exit(1)

    print()
    log("💬", "Suggested commit message:")
    print()
    print("─" * 60)
    print(message)
    print("─" * 60)
    print()

    if apply:
        apply_commit(message)
    else:
        log("💡", "To apply this commit, run again with --apply")
        log("💡", "Or copy the message and run: git commit -m \"<message>\"")


if __name__ == "__main__":
    asyncio.run(main())
