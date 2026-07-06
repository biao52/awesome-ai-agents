"""
Competitor Monitor Agent

Crawls competitor websites using Reader, diffs content against previous
snapshots, and uses Claude to analyze what changed and why it matters.

Usage:
    python main.py "https://competitor.com/pricing" "https://competitor.com/features"
    python main.py --reset  # Clear all saved snapshots
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from difflib import unified_diff
from pathlib import Path
from typing import Any

import anthropic
import httpx
from dotenv import load_dotenv

load_dotenv()

SNAPSHOTS_DIR = Path(__file__).parent / "snapshots"
READER_API_URL = "https://api.reader.dev/v1/read"
CLAUDE_MODEL = "claude-sonnet-4-20250514"


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(message: str, level: str = "info") -> None:
    """Print a timestamped log message."""
    timestamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    prefix = {
        "info": "   ",
        "ok": " + ",
        "warn": " ! ",
        "error": " X ",
        "step": ">> ",
    }.get(level, "   ")
    print(f"[{timestamp}]{prefix}{message}")


# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------

def validate_env() -> str:
    """Ensure required environment variables are set. Returns the Anthropic API key."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        log("ANTHROPIC_API_KEY is not set. Add it to .env or export it.", "error")
        sys.exit(1)
    reader_key = os.environ.get("READER_API_KEY", "")
    if not reader_key:
        log("READER_API_KEY is not set. Get one at https://reader.dev", "error")
        sys.exit(1)
    log("Environment validated", "ok")
    return api_key


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class Snapshot:
    """A point-in-time capture of a page's content."""

    url: str
    content: str
    captured_at: str
    title: str = ""
    word_count: int = 0


@dataclass
class DiffResult:
    """The result of comparing two snapshots."""

    url: str
    is_first_run: bool
    added_lines: list[str] = field(default_factory=list)
    removed_lines: list[str] = field(default_factory=list)
    added_blocks: list[str] = field(default_factory=list)
    removed_blocks: list[str] = field(default_factory=list)
    summary: str = ""

    @property
    def has_changes(self) -> bool:
        return bool(self.added_lines or self.removed_lines)

    @property
    def change_count(self) -> int:
        return len(self.added_lines) + len(self.removed_lines)


@dataclass
class ChangeReport:
    """Claude's analysis of what changed on a competitor page."""

    url: str
    analysis: str
    captured_at: str
    diff_stats: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Snapshot storage
# ---------------------------------------------------------------------------

def url_to_filename(url: str) -> str:
    """Hash a URL to a safe filename."""
    url_hash = hashlib.sha256(url.encode()).hexdigest()[:16]
    return f"snapshot_{url_hash}.json"


def load_snapshot(url: str) -> Snapshot | None:
    """Load a previously saved snapshot for the given URL."""
    filepath = SNAPSHOTS_DIR / url_to_filename(url)
    if not filepath.exists():
        return None
    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
        return Snapshot(**data)
    except (json.JSONDecodeError, TypeError, KeyError) as exc:
        log(f"Corrupt snapshot for {url}: {exc}", "warn")
        return None


def save_snapshot(snapshot: Snapshot) -> Path:
    """Save a snapshot to disk. Returns the file path."""
    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    filepath = SNAPSHOTS_DIR / url_to_filename(snapshot.url)
    filepath.write_text(
        json.dumps(asdict(snapshot), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return filepath


def clear_snapshots() -> int:
    """Remove all saved snapshots. Returns the count of files removed."""
    if not SNAPSHOTS_DIR.exists():
        return 0
    count = 0
    for f in SNAPSHOTS_DIR.glob("snapshot_*.json"):
        f.unlink()
        count += 1
    return count


# ---------------------------------------------------------------------------
# Reader integration
# ---------------------------------------------------------------------------

async def read_page(client: httpx.AsyncClient, url: str) -> Snapshot:
    """
    Fetch a page through Reader and return a Snapshot.

    Reader converts any web page to clean markdown, which makes diffing
    straightforward and gives Claude well-structured text to analyze.
    """
    log(f"Reading {url} via Reader...", "step")

    response = await client.post(
        READER_API_URL,
        json={"url": url},
        headers={"Authorization": f"Bearer {os.environ.get('READER_API_KEY', '')}"},
        timeout=30.0,
    )
    response.raise_for_status()

    data = response.json()
    content = data.get("data", {}).get("markdown", "").strip()
    title = extract_title(content)
    word_count = len(content.split())

    log(f"Got {word_count} words from {url}", "ok")

    return Snapshot(
        url=url,
        content=content,
        captured_at=datetime.now(timezone.utc).isoformat(),
        title=title,
        word_count=word_count,
    )


def extract_title(markdown: str) -> str:
    """Pull the first heading from markdown content."""
    for line in markdown.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            return line.lstrip("# ").strip()
    return ""


# ---------------------------------------------------------------------------
# Diff logic
# ---------------------------------------------------------------------------

def compute_diff(previous: Snapshot | None, current: Snapshot) -> DiffResult:
    """Compare two snapshots and identify what changed."""
    if previous is None:
        return DiffResult(
            url=current.url,
            is_first_run=True,
            summary="First capture, baseline snapshot saved.",
        )

    old_lines = previous.content.splitlines()
    new_lines = current.content.splitlines()

    diff_lines = list(unified_diff(
        old_lines,
        new_lines,
        fromfile="previous",
        tofile="current",
        lineterm="",
    ))

    added = [line[1:] for line in diff_lines if line.startswith("+") and not line.startswith("+++")]
    removed = [line[1:] for line in diff_lines if line.startswith("-") and not line.startswith("---")]

    added_blocks = _group_into_blocks(added)
    removed_blocks = _group_into_blocks(removed)

    result = DiffResult(
        url=current.url,
        is_first_run=False,
        added_lines=added,
        removed_lines=removed,
        added_blocks=added_blocks,
        removed_blocks=removed_blocks,
    )

    if result.has_changes:
        result.summary = (
            f"{len(added)} lines added, {len(removed)} lines removed "
            f"({len(added_blocks)} new blocks, {len(removed_blocks)} removed blocks)"
        )
    else:
        result.summary = "No changes detected since last snapshot."

    return result


def _group_into_blocks(lines: list[str]) -> list[str]:
    """
    Group consecutive non-empty lines into blocks.
    This helps identify coherent sections that were added or removed,
    rather than treating each line independently.
    """
    blocks: list[str] = []
    current_block: list[str] = []

    for line in lines:
        stripped = line.strip()
        if stripped:
            current_block.append(line)
        elif current_block:
            blocks.append("\n".join(current_block))
            current_block = []

    if current_block:
        blocks.append("\n".join(current_block))

    return blocks


def format_diff_for_claude(diff_result: DiffResult) -> str:
    """Format the diff into a prompt-friendly string for Claude."""
    parts: list[str] = []
    parts.append(f"URL: {diff_result.url}")
    parts.append(f"Change summary: {diff_result.summary}")
    parts.append("")

    if diff_result.added_blocks:
        parts.append("=== NEW CONTENT ===")
        for i, block in enumerate(diff_result.added_blocks, 1):
            parts.append(f"\n[Added block {i}]")
            parts.append(block)

    if diff_result.removed_blocks:
        parts.append("\n=== REMOVED CONTENT ===")
        for i, block in enumerate(diff_result.removed_blocks, 1):
            parts.append(f"\n[Removed block {i}]")
            parts.append(block)

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Claude analysis
# ---------------------------------------------------------------------------

ANALYSIS_SYSTEM = """You are a competitive intelligence analyst. You analyze
changes detected on competitor websites and produce actionable reports.

Focus on:
- What specifically changed (pricing, features, messaging, positioning)
- Why this change likely matters (market signal, competitive move, customer feedback response)
- What actions the reader should consider in response

Be specific and concise. Reference the actual content that changed."""

ANALYSIS_PROMPT = """Analyze the following changes detected on a competitor's website.

{diff_content}

Produce a structured change report with these sections:

1. **Change Summary** - One paragraph overview of what changed
2. **Key Changes** - Bullet points of each significant change
3. **Competitive Implications** - What this signals about the competitor's strategy
4. **Recommended Actions** - What you should do in response

If the changes are minor (formatting, typos), say so briefly and skip the detailed analysis."""


async def analyze_changes(
    api_key: str,
    diffs: list[DiffResult],
) -> list[ChangeReport]:
    """Send diffs to Claude for competitive analysis."""
    client = anthropic.AsyncAnthropic(api_key=api_key)
    reports: list[ChangeReport] = []

    # Filter to only diffs that have actual changes
    actionable = [d for d in diffs if d.has_changes and not d.is_first_run]

    if not actionable:
        log("No changes to analyze", "info")
        return reports

    log(f"Analyzing {len(actionable)} page(s) with Claude...", "step")

    for diff_result in actionable:
        diff_content = format_diff_for_claude(diff_result)

        response = await client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=2048,
            system=ANALYSIS_SYSTEM,
            messages=[
                {
                    "role": "user",
                    "content": ANALYSIS_PROMPT.format(diff_content=diff_content),
                }
            ],
        )

        analysis_text = response.content[0].text

        report = ChangeReport(
            url=diff_result.url,
            analysis=analysis_text,
            captured_at=datetime.now(timezone.utc).isoformat(),
            diff_stats={
                "added_lines": len(diff_result.added_lines),
                "removed_lines": len(diff_result.removed_lines),
                "added_blocks": len(diff_result.added_blocks),
                "removed_blocks": len(diff_result.removed_blocks),
            },
        )
        reports.append(report)
        log(f"Analysis complete for {diff_result.url}", "ok")

    return reports


# ---------------------------------------------------------------------------
# Report formatting
# ---------------------------------------------------------------------------

def print_report(reports: list[ChangeReport], diffs: list[DiffResult]) -> None:
    """Print a formatted report to stdout."""
    print("\n" + "=" * 70)
    print("  COMPETITOR MONITOR REPORT")
    print(f"  Generated at {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print("=" * 70)

    # Handle first-run pages
    first_runs = [d for d in diffs if d.is_first_run]
    if first_runs:
        print("\n--- Baseline Captures (first run) ---")
        for d in first_runs:
            print(f"  Captured: {d.url}")

    # Handle no-change pages
    unchanged = [d for d in diffs if not d.is_first_run and not d.has_changes]
    if unchanged:
        print("\n--- No Changes Detected ---")
        for d in unchanged:
            print(f"  Unchanged: {d.url}")

    # Print analysis reports
    for report in reports:
        print(f"\n{'- ' * 35}")
        print(f"  {report.url}")
        print(f"  +{report.diff_stats.get('added_lines', 0)} lines / "
              f"-{report.diff_stats.get('removed_lines', 0)} lines")
        print(f"{'- ' * 35}\n")
        print(report.analysis)

    print("\n" + "=" * 70)


def save_report(reports: list[ChangeReport]) -> Path | None:
    """Save reports to a JSON file for programmatic consumption."""
    if not reports:
        return None

    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filepath = SNAPSHOTS_DIR / f"report_{timestamp}.json"
    filepath.write_text(
        json.dumps([asdict(r) for r in reports], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    log(f"Report saved to {filepath}", "ok")
    return filepath


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------

async def monitor(urls: list[str], api_key: str) -> None:
    """
    Main monitoring pipeline:
    1. Read each URL via Reader
    2. Compare against saved snapshots
    3. Analyze changes with Claude
    4. Save new snapshots and print report
    """
    log(f"Monitoring {len(urls)} URL(s)", "step")
    start = time.monotonic()

    diffs: list[DiffResult] = []

    async with httpx.AsyncClient() as client:
        for url in urls:
            try:
                # Fetch current content through Reader
                current = await read_page(client, url)

                # Load previous snapshot and compute diff
                previous = load_snapshot(url)
                diff = compute_diff(previous, current)
                diffs.append(diff)

                if diff.is_first_run:
                    log(f"First run for {url}, saving baseline", "info")
                elif diff.has_changes:
                    log(f"Changes detected on {url}: {diff.summary}", "warn")
                else:
                    log(f"No changes on {url}", "ok")

                # Save current snapshot for next comparison
                save_snapshot(current)

            except httpx.HTTPStatusError as exc:
                log(f"HTTP error reading {url}: {exc.response.status_code}", "error")
            except httpx.RequestError as exc:
                log(f"Request failed for {url}: {exc}", "error")

    # Analyze any changes with Claude
    reports = await analyze_changes(api_key, diffs)

    # Output
    print_report(reports, diffs)
    save_report(reports)

    elapsed = time.monotonic() - start
    log(f"Done in {elapsed:.1f}s", "ok")


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""
    parser = argparse.ArgumentParser(
        description="Monitor competitor websites for changes using Reader and Claude.",
    )
    parser.add_argument(
        "urls",
        nargs="*",
        help="One or more competitor URLs to monitor",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Clear all saved snapshots and exit",
    )
    return parser.parse_args()


def main() -> None:
    """Entry point."""
    args = parse_args()

    if args.reset:
        count = clear_snapshots()
        log(f"Cleared {count} snapshot(s)", "ok")
        return

    if not args.urls:
        log("No URLs provided. Usage: python main.py <url1> [url2] ...", "error")
        sys.exit(1)

    # Normalize URLs
    urls = []
    for url in args.urls:
        if not url.startswith("http"):
            url = f"https://{url}"
        urls.append(url)

    api_key = validate_env()

    log("Competitor Monitor starting", "step")
    asyncio.run(monitor(urls, api_key))


if __name__ == "__main__":
    main()
