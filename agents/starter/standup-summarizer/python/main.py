"""
Standup Summarizer Agent -- Reads git log from a repository and generates
a structured standup update (Yesterday, Today, Blockers).

Uses OpenAI GPT to transform raw git history into a concise, readable standup.
"""

import os
import sys
import asyncio
import subprocess
from datetime import datetime, timedelta
from typing import Any

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_DAYS = 1
MAX_RETRIES = 3
MAX_COMMITS = 100  # Cap the number of commits to avoid huge prompts


# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        print("   Get your OpenAI key at: https://platform.openai.com/api-keys")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Git operations
# ---------------------------------------------------------------------------


def is_git_repo(repo_path: str) -> bool:
    """Check if a directory is a git repository."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


def get_repo_name(repo_path: str) -> str:
    """Get the repository name from the git remote or directory name."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            url = result.stdout.strip()
            # Extract repo name from URL
            name = url.rstrip("/").split("/")[-1]
            if name.endswith(".git"):
                name = name[:-4]
            return name
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    return os.path.basename(os.path.abspath(repo_path))


def get_current_branch(repo_path: str) -> str:
    """Get the current branch name."""
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    return "unknown"


def get_git_log(repo_path: str, days: int) -> list[dict[str, str]]:
    """Fetch git log entries from the last N days."""
    since_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

    try:
        # Use a custom format to make parsing reliable
        separator = "---COMMIT_SEP---"
        field_sep = "---FIELD_SEP---"
        fmt = f"%H{field_sep}%an{field_sep}%ae{field_sep}%ai{field_sep}%s{field_sep}%b{separator}"

        result = subprocess.run(
            [
                "git", "log",
                f"--since={since_date}",
                f"--max-count={MAX_COMMITS}",
                f"--pretty=format:{fmt}",
                "--no-merges",
            ],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0:
            log("⚠️", f"git log failed: {result.stderr.strip()}")
            return []

        raw = result.stdout.strip()
        if not raw:
            return []

        commits: list[dict[str, str]] = []
        for entry in raw.split(separator):
            entry = entry.strip()
            if not entry:
                continue

            fields = entry.split(field_sep)
            if len(fields) >= 5:
                commits.append({
                    "hash": fields[0][:8],
                    "author": fields[1],
                    "email": fields[2],
                    "date": fields[3],
                    "subject": fields[4],
                    "body": fields[5].strip() if len(fields) > 5 else "",
                })

        return commits

    except subprocess.TimeoutExpired:
        log("❌", "git log timed out")
        return []
    except FileNotFoundError:
        log("❌", "git not found. Make sure git is installed and in your PATH.")
        sys.exit(1)


def get_diff_stats(repo_path: str, days: int) -> str:
    """Get a summary of file changes over the period."""
    since_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

    try:
        result = subprocess.run(
            ["git", "diff", "--stat", f"--since={since_date}", "HEAD"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=15,
        )

        # Fallback: use shortstat on the log
        if result.returncode != 0 or not result.stdout.strip():
            result = subprocess.run(
                [
                    "git", "log",
                    f"--since={since_date}",
                    "--shortstat",
                    "--no-merges",
                    "--pretty=format:",
                ],
                cwd=repo_path,
                capture_output=True,
                text=True,
                timeout=15,
            )

        return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""


def read_todo_file(repo_path: str) -> str:
    """Read a TODO file if it exists in the repo."""
    for filename in ["TODO.md", "TODO.txt", "TODO", "TASKS.md"]:
        file_path = os.path.join(repo_path, filename)
        if os.path.isfile(file_path):
            try:
                with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                if content.strip():
                    # Truncate if very long
                    if len(content) > 2000:
                        content = content[:2000] + "\n... (truncated)"
                    return content
            except OSError:
                pass

    return ""


# ---------------------------------------------------------------------------
# Standup generation via LLM
# ---------------------------------------------------------------------------


async def generate_standup(
    commits: list[dict[str, str]],
    repo_name: str,
    branch: str,
    diff_stats: str,
    todo_content: str,
    days: int,
    model: str,
) -> str:
    """Generate a standup summary using the LLM."""
    client = AsyncOpenAI()

    # Format commits for the prompt
    commit_text = ""
    for c in commits:
        commit_text += f"  [{c['hash']}] {c['date'][:10]} - {c['subject']}\n"
        if c["body"]:
            commit_text += f"           {c['body'][:200]}\n"

    period = f"last {days} day(s)" if days > 1 else "last 24 hours"

    prompt = f"""Based on the following git activity, generate a standup update.

Repository: {repo_name}
Branch: {branch}
Period: {period}
Total commits: {len(commits)}

Git log:
{commit_text if commit_text else "  (no commits in this period)"}
"""

    if diff_stats:
        prompt += f"\nChange statistics:\n{diff_stats}\n"

    if todo_content:
        prompt += f"\nTODO/Tasks file contents:\n{todo_content}\n"

    prompt += """
Generate a concise standup update with these three sections:

1. **Yesterday** (or "Recent work" if looking back more than 1 day)
   - Summarize what was accomplished based on the commits
   - Group related commits into logical work items
   - Use past tense, be specific but concise

2. **Today** (planned work)
   - Infer what might be next based on the recent work patterns
   - If TODO content is available, reference relevant upcoming tasks
   - If there is not enough info, say "To be determined based on priorities"

3. **Blockers**
   - Note any potential blockers you can infer (e.g., incomplete work, WIP commits)
   - If nothing is apparent, say "None"

Format the output as a clean standup message. Keep each bullet point to one line.
Do not use markdown headers -- use plain text with clear section labels.
Keep the total output under 300 words."""

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.chat.completions.create(
                model=model,
                temperature=0.3,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are a helpful assistant that generates concise, professional "
                            "standup updates from git history. Be specific about what was done, "
                            "but keep it brief. Write in first person."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
            )

            return response.choices[0].message.content or "No standup generated."

        except Exception as e:
            error_str = str(e)
            if attempt < MAX_RETRIES and (
                "rate" in error_str.lower()
                or "overloaded" in error_str.lower()
            ):
                wait_time = 2 ** attempt
                log("⏳", f"API error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait_time}s...")
                await asyncio.sleep(wait_time)
            else:
                raise

    return "Failed to generate standup."


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the standup summarizer agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    # Parse CLI arguments
    repo_path = "."
    days = DEFAULT_DAYS

    i = 0
    while i < len(args):
        if args[i] in ("--repo", "-r") and i + 1 < len(args):
            repo_path = args[i + 1]
            i += 2
        elif args[i] in ("--days", "-d") and i + 1 < len(args):
            try:
                days = int(args[i + 1])
                if days < 1:
                    print("❌ Days must be at least 1.")
                    sys.exit(1)
            except ValueError:
                print(f"❌ Invalid number of days: {args[i + 1]}")
                sys.exit(1)
            i += 2
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py [OPTIONS]")
            print()
            print("Options:")
            print("  --repo, -r PATH    Path to git repository (default: current directory)")
            print(f"  --days, -d NUMBER   Number of days to look back (default: {DEFAULT_DAYS})")
            print("  --help, -h          Show this help message")
            print()
            print("Examples:")
            print("  python main.py                    # Current repo, last 24 hours")
            print("  python main.py --days 2           # Look back 2 days")
            print("  python main.py --repo /path/to/project --days 3")
            sys.exit(0)
        else:
            print(f"❌ Unknown argument: {args[i]}")
            print("   Use --help for usage information.")
            sys.exit(1)

    abs_repo = os.path.abspath(repo_path)

    log("🚀", "Starting standup summarizer agent...")
    log("🤖", f"Model: {model}")
    log("📁", f"Repository: {abs_repo}")
    log("📅", f"Looking back: {days} day(s)")
    print()

    # Validate git repo
    if not is_git_repo(abs_repo):
        print(f"❌ Not a git repository: {abs_repo}")
        print("   Make sure you are in a git repo or use --repo to specify one.")
        sys.exit(1)

    repo_name = get_repo_name(abs_repo)
    branch = get_current_branch(abs_repo)
    log("📋", f"Repo: {repo_name} (branch: {branch})")

    # Gather data
    log("🔍", "Reading git log...")
    commits = get_git_log(abs_repo, days)
    log("📊", f"Found {len(commits)} commit(s) in the last {days} day(s)")

    diff_stats = get_diff_stats(abs_repo, days)
    todo_content = read_todo_file(abs_repo)
    if todo_content:
        log("📝", "Found TODO file, including in context")

    # Generate standup
    print()
    log("🤖", "Generating standup update...")

    try:
        standup = await generate_standup(
            commits, repo_name, branch, diff_stats, todo_content, days, model
        )
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error generating standup: {e}")
        print("   Check your OPENAI_API_KEY and network connection.")
        sys.exit(1)

    # Output
    print()
    print("=" * 50)
    print(f"  Standup Update -- {repo_name}")
    print(f"  {datetime.now().strftime('%A, %B %d, %Y')}")
    print("=" * 50)
    print()
    print(standup)
    print()
    log("✅", "Done!")


if __name__ == "__main__":
    asyncio.run(main())
