"""
Log Analyzer Agent -- Analyzes log files to find anomalies, patterns,
and root causes using Claude for intelligent analysis.

Reads logs from a file or stdin, pre-processes them to extract statistics,
then sends a structured summary to Claude for deep analysis.
"""

import os
import re
import sys
import asyncio
from collections import Counter
from datetime import datetime
from typing import Any

from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
MAX_LINES_THRESHOLD = 1000
SAMPLE_HEAD = 500
SAMPLE_TAIL = 500
MAX_RETRIES = 3

# Common log level patterns
LOG_LEVEL_PATTERN = re.compile(
    r"\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|CRITICAL|NOTICE)\b",
    re.IGNORECASE,
)

# Common timestamp patterns
TIMESTAMP_PATTERNS = [
    # ISO 8601: 2024-01-15T10:30:45.123Z
    re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"),
    # Common log: 2024-01-15 10:30:45
    re.compile(r"\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}"),
    # Syslog: Jan 15 10:30:45
    re.compile(r"[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}"),
    # Unix epoch: 1705312245
    re.compile(r"\b1[6-9]\d{8}\b"),
]

# Common error patterns worth highlighting
ERROR_PATTERNS = [
    re.compile(r"(?:out of memory|OOM|oom.killer)", re.IGNORECASE),
    re.compile(r"(?:connection refused|ECONNREFUSED|ETIMEDOUT)", re.IGNORECASE),
    re.compile(r"(?:segmentation fault|SIGSEGV|core dump)", re.IGNORECASE),
    re.compile(r"(?:permission denied|EACCES|403)", re.IGNORECASE),
    re.compile(r"(?:disk full|no space left|ENOSPC)", re.IGNORECASE),
    re.compile(r"(?:timeout|timed out|deadline exceeded)", re.IGNORECASE),
    re.compile(r"(?:null pointer|NullPointerException|TypeError.*null)", re.IGNORECASE),
    re.compile(r"(?:stack overflow|maximum call stack)", re.IGNORECASE),
]

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
# Log reading
# ---------------------------------------------------------------------------


def read_log_file(file_path: str) -> list[str]:
    """Read a log file and return lines."""
    if not os.path.isfile(file_path):
        print(f"❌ File not found: {file_path}")
        sys.exit(1)

    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            return f.readlines()
    except PermissionError:
        print(f"❌ Permission denied: {file_path}")
        sys.exit(1)


def read_stdin() -> list[str]:
    """Read log lines from stdin."""
    if sys.stdin.isatty():
        return []
    return sys.stdin.readlines()


# ---------------------------------------------------------------------------
# Log pre-processing
# ---------------------------------------------------------------------------


def detect_timestamp_format(lines: list[str]) -> str | None:
    """Detect the timestamp format used in the logs."""
    sample = lines[:50]
    for pattern in TIMESTAMP_PATTERNS:
        matches = sum(1 for line in sample if pattern.search(line))
        if matches > len(sample) * 0.3:
            return pattern.pattern
    return None


def extract_log_levels(lines: list[str]) -> Counter[str]:
    """Count occurrences of each log level."""
    counts: Counter[str] = Counter()
    for line in lines:
        match = LOG_LEVEL_PATTERN.search(line)
        if match:
            level = match.group(1).upper()
            if level == "WARNING":
                level = "WARN"
            counts[level] += 1
    return counts


def find_error_lines(lines: list[str]) -> list[tuple[int, str]]:
    """Find all lines containing ERROR, FATAL, or CRITICAL."""
    error_lines: list[tuple[int, str]] = []
    for i, line in enumerate(lines, 1):
        match = LOG_LEVEL_PATTERN.search(line)
        if match and match.group(1).upper() in ("ERROR", "FATAL", "CRITICAL"):
            error_lines.append((i, line.rstrip()))
    return error_lines


def find_known_patterns(lines: list[str]) -> list[tuple[str, int]]:
    """Find known error patterns and their counts."""
    pattern_counts: list[tuple[str, int]] = []
    for pattern in ERROR_PATTERNS:
        count = sum(1 for line in lines if pattern.search(line))
        if count > 0:
            pattern_counts.append((pattern.pattern, count))
    return pattern_counts


def find_repeated_messages(lines: list[str], threshold: int = 5) -> list[tuple[str, int]]:
    """Find messages that repeat frequently (possible log storms)."""
    # Strip timestamps and log levels to find repeated message bodies
    message_counts: Counter[str] = Counter()
    for line in lines:
        # Remove leading timestamp-like content and log level
        cleaned = LOG_LEVEL_PATTERN.sub("", line)
        for pattern in TIMESTAMP_PATTERNS:
            cleaned = pattern.sub("", cleaned)
        # Normalize whitespace and numbers
        cleaned = re.sub(r"\d+", "N", cleaned.strip())
        cleaned = re.sub(r"\s+", " ", cleaned)
        if len(cleaned) > 10:  # Skip very short lines
            message_counts[cleaned] += 1

    return [
        (msg, count)
        for msg, count in message_counts.most_common(10)
        if count >= threshold
    ]


def sample_lines(lines: list[str]) -> tuple[str, str]:
    """For large logs, take a representative sample.

    Returns (sampled_text, sampling_description).
    """
    total = len(lines)

    if total <= MAX_LINES_THRESHOLD:
        return "".join(lines), f"Full log ({total} lines)"

    head = lines[:SAMPLE_HEAD]
    tail = lines[-SAMPLE_TAIL:]

    # Also grab all error lines
    error_lines = find_error_lines(lines)
    # Filter to only those in the middle (not already in head/tail)
    middle_errors = [
        line_text
        for line_num, line_text in error_lines
        if SAMPLE_HEAD < line_num <= total - SAMPLE_TAIL
    ]

    parts = [
        f"=== FIRST {SAMPLE_HEAD} LINES ===\n",
        "".join(head),
        f"\n=== ... ({total - SAMPLE_HEAD - SAMPLE_TAIL} lines omitted) ===\n",
    ]

    if middle_errors:
        parts.append(f"\n=== ERROR LINES FROM OMITTED SECTION ({len(middle_errors)} lines) ===\n")
        # Cap at 200 error lines from the middle
        for line_text in middle_errors[:200]:
            parts.append(line_text + "\n")

    parts.append(f"\n=== LAST {SAMPLE_TAIL} LINES ===\n")
    parts.append("".join(tail))

    desc = (
        f"Sampled: first {SAMPLE_HEAD} + last {SAMPLE_TAIL} lines"
        f" + {min(len(middle_errors), 200)} error lines from middle"
        f" (total: {total} lines)"
    )

    return "".join(parts), desc


def build_pre_analysis(lines: list[str]) -> str:
    """Build a statistical pre-analysis of the log."""
    sections: list[str] = []

    # Basic stats
    total = len(lines)
    sections.append(f"Total lines: {total}")

    # Timestamp detection
    ts_format = detect_timestamp_format(lines)
    if ts_format:
        sections.append(f"Timestamp format detected: {ts_format}")
    else:
        sections.append("No consistent timestamp format detected")

    # Log levels
    level_counts = extract_log_levels(lines)
    if level_counts:
        sections.append("Log level distribution:")
        for level, count in level_counts.most_common():
            pct = (count / total) * 100
            sections.append(f"  {level}: {count} ({pct:.1f}%)")

    # Error count
    error_lines = find_error_lines(lines)
    sections.append(f"Error/Fatal/Critical lines: {len(error_lines)}")

    # Known patterns
    known = find_known_patterns(lines)
    if known:
        sections.append("Known error patterns detected:")
        for pattern, count in known:
            sections.append(f"  {pattern}: {count} occurrences")

    # Repeated messages
    repeated = find_repeated_messages(lines)
    if repeated:
        sections.append("Frequently repeated messages (possible log storms):")
        for msg, count in repeated:
            sections.append(f"  [{count}x] {msg[:120]}")

    return "\n".join(sections)


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert site reliability engineer analyzing application logs. You have deep experience with production systems, distributed architectures, and incident response.

Analyze the provided log data and pre-computed statistics. Produce a structured analysis report.

Your report must follow this exact format:

## Log Analysis Summary
[2-3 sentences describing what these logs show and the overall health]

## Error Frequency
[Table or list of error types, their frequency, and when they started/stopped]

## Anomalies Detected
[List unusual patterns: sudden spikes, new error types, unusual timing, log gaps]
- Each anomaly with evidence (specific log lines or timestamps)

## Root Cause Analysis
[For each major error cluster, provide:]
- **Symptom:** What the logs show
- **Likely cause:** What probably triggered it
- **Evidence:** Specific log lines supporting this theory
- **Confidence:** High/Medium/Low

## Timeline
[Chronological sequence of events if timestamps are available]
1. [timestamp] Event description
2. [timestamp] Event description

## Recommended Actions
[Prioritized list of what to do next]
1. **Immediate:** Actions to take right now
2. **Short-term:** Actions for the next few hours/days
3. **Long-term:** Systemic improvements to prevent recurrence

## Additional Notes
[Anything else noteworthy: log quality issues, missing context, suggested monitoring]

Rules:
- Be specific. Reference exact log lines and timestamps when possible.
- Distinguish between symptoms and causes. Errors are symptoms -- find the cause.
- If you cannot determine a root cause, say so and explain what additional information would help.
- Do not invent issues. If the logs look healthy, say so.
- Consider cascading failures: one root cause can produce many different error messages.
- Pay attention to timing: errors that start at the same time likely share a root cause."""


# ---------------------------------------------------------------------------
# Analysis agent
# ---------------------------------------------------------------------------


async def analyze_logs(
    log_text: str,
    pre_analysis: str,
    sampling_desc: str,
    model: str,
    context: str | None = None,
) -> str:
    """Send log data to Claude for analysis."""
    client = AsyncAnthropic()

    user_parts = [
        f"Analyze these application logs.\n",
        f"**Sampling:** {sampling_desc}\n",
        f"**Pre-computed statistics:**\n```\n{pre_analysis}\n```\n",
    ]

    if context:
        user_parts.append(f"**Additional context from user:** {context}\n")

    user_parts.append(f"**Log data:**\n```\n{log_text[:150_000]}\n```\n")
    user_parts.append("Produce your structured analysis now.")

    user_message = "\n".join(user_parts)

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

    return "Error: Failed to get analysis after multiple retries."


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    if "--help" in args or "-h" in args:
        print("Usage: python main.py --file app.log [--context 'deploy happened at 3pm']")
        print("       cat app.log | python main.py")
        print()
        print("Analyzes log files to find anomalies, patterns, and root causes.")
        print()
        print("Options:")
        print("  --file FILE     Path to the log file to analyze")
        print("  --context TEXT  Additional context about the system or incident")
        print()
        print("Environment variables:")
        print("  ANTHROPIC_API_KEY  Your Anthropic API key (required)")
        print("  MODEL              Override the Claude model (default: claude-sonnet-4-20250514)")
        sys.exit(0)

    # Parse args
    file_path: str | None = None
    context: str | None = None
    i = 0
    while i < len(args):
        if args[i] == "--file" and i + 1 < len(args):
            file_path = args[i + 1]
            i += 2
        elif args[i] == "--context" and i + 1 < len(args):
            context = args[i + 1]
            i += 2
        else:
            i += 1

    # Read logs
    lines: list[str] = []
    source = ""

    if file_path:
        lines = read_log_file(file_path)
        source = file_path
    else:
        lines = read_stdin()
        source = "stdin"

    if not lines:
        print("❌ No log data provided.")
        print("   Usage: python main.py --file app.log")
        print("          cat app.log | python main.py")
        sys.exit(1)

    log("🚀", "Starting log analysis agent...")
    log("🤖", f"Model: {model}")
    log("📄", f"Source: {source} ({len(lines)} lines)")
    print()

    # Pre-process
    log("🔍", "Pre-processing logs...")
    pre_analysis = build_pre_analysis(lines)
    print()
    print(pre_analysis)
    print()

    # Sample for large logs
    log_text, sampling_desc = sample_lines(lines)
    log("📊", sampling_desc)

    # Send to Claude
    log("🧠", "Sending to Claude for analysis...")
    print()

    analysis = await analyze_logs(log_text, pre_analysis, sampling_desc, model, context)

    print("=" * 60)
    print("📊 Log Analysis Report")
    print("=" * 60)
    print()
    print(analysis)
    print()
    print("=" * 60)
    log("✅", "Analysis complete!")


if __name__ == "__main__":
    asyncio.run(main())
