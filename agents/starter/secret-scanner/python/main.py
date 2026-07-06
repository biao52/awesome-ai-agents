"""
Secret Scanner Agent -- Scans a codebase for leaked credentials, API keys,
tokens, and other secrets using regex pattern matching and LLM verification.

Phase 1 uses regex to find candidates. Phase 2 sends suspicious findings
to Claude for confirmation and severity rating.
"""

import os
import re
import sys
import json
import asyncio
from typing import Any
from pathlib import Path

from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
MAX_RETRIES = 3
MAX_FILE_SIZE = 512_000  # 512KB -- skip very large files
CONTEXT_LINES = 2  # Lines of context above and below each finding

# Directories and files to skip
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    ".mypy_cache", ".pytest_cache", "dist", "build", ".next",
    ".nuxt", "target", "vendor", ".tox", "eggs", ".eggs",
    "coverage", ".coverage", ".nyc_output",
}

SKIP_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".mp3", ".mp4", ".avi", ".mov", ".mkv",
    ".zip", ".tar", ".gz", ".bz2", ".rar", ".7z",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx",
    ".pyc", ".pyo", ".class", ".o", ".so", ".dylib", ".dll",
    ".exe", ".bin", ".dat", ".db", ".sqlite",
    ".lock", ".sum",
}

# ---------------------------------------------------------------------------
# Secret patterns -- each has a name, regex, and description
# ---------------------------------------------------------------------------

SECRET_PATTERNS: list[dict[str, str]] = [
    {
        "name": "AWS Access Key",
        "pattern": r"(?:^|['\"\s=:])?(AKIA[0-9A-Z]{16})(?:['\"\s]|$)",
        "description": "AWS IAM access key ID",
    },
    {
        "name": "AWS Secret Key",
        "pattern": r"(?:aws_secret_access_key|aws_secret|secret_key)\s*[=:]\s*['\"]?([A-Za-z0-9/+=]{40})['\"]?",
        "description": "AWS secret access key",
    },
    {
        "name": "OpenAI API Key",
        "pattern": r"(?:^|['\"\s=:])?sk-[A-Za-z0-9_-]{20,}",
        "description": "OpenAI API key (sk-...)",
    },
    {
        "name": "Anthropic API Key",
        "pattern": r"(?:^|['\"\s=:])?sk-ant-[A-Za-z0-9_-]{20,}",
        "description": "Anthropic API key (sk-ant-...)",
    },
    {
        "name": "GitHub Token",
        "pattern": r"(?:^|['\"\s=:])?(?:ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghu_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghr_[A-Za-z0-9]{36})",
        "description": "GitHub personal access token or OAuth token",
    },
    {
        "name": "Slack Token",
        "pattern": r"(?:^|['\"\s=:])?xox[bprs]-[A-Za-z0-9-]{10,}",
        "description": "Slack API token",
    },
    {
        "name": "Stripe Key",
        "pattern": r"(?:^|['\"\s=:])?(?:sk_live_|rk_live_|pk_live_)[A-Za-z0-9]{20,}",
        "description": "Stripe live API key",
    },
    {
        "name": "Generic API Key",
        "pattern": r"(?:api[_-]?key|apikey|api[_-]?secret)\s*[=:]\s*['\"]([A-Za-z0-9_\-]{20,})['\"]",
        "description": "Generic API key in config",
    },
    {
        "name": "Private Key",
        "pattern": r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
        "description": "Private key file content",
    },
    {
        "name": "Password in Config",
        "pattern": r"(?:password|passwd|pwd)\s*[=:]\s*['\"]([^'\"]{8,})['\"]",
        "description": "Hardcoded password in configuration",
    },
    {
        "name": "Database URL",
        "pattern": r"(?:mysql|postgres|postgresql|mongodb|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+",
        "description": "Database connection string with credentials",
    },
    {
        "name": "JWT Token",
        "pattern": r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
        "description": "JSON Web Token",
    },
    {
        "name": "Google API Key",
        "pattern": r"(?:^|['\"\s=:])?AIza[0-9A-Za-z_-]{35}",
        "description": "Google API key",
    },
    {
        "name": "SendGrid Key",
        "pattern": r"(?:^|['\"\s=:])?SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}",
        "description": "SendGrid API key",
    },
    {
        "name": "Twilio Key",
        "pattern": r"(?:^|['\"\s=:])?SK[0-9a-fA-F]{32}",
        "description": "Twilio API key",
    },
]

# Compile patterns once
COMPILED_PATTERNS = [
    {**p, "regex": re.compile(p["pattern"], re.IGNORECASE)}
    for p in SECRET_PATTERNS
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
# File scanning
# ---------------------------------------------------------------------------


def should_scan_file(file_path: Path) -> bool:
    """Check if a file should be scanned."""
    # Skip hidden files (except .env which is important to catch)
    if file_path.name.startswith(".") and file_path.name != ".env":
        return False

    # Skip by extension
    if file_path.suffix.lower() in SKIP_EXTENSIONS:
        return False

    # Skip large files
    try:
        if file_path.stat().st_size > MAX_FILE_SIZE:
            return False
    except OSError:
        return False

    return True


def collect_files(directory: str) -> list[Path]:
    """Walk a directory and collect scannable files."""
    root = Path(directory).resolve()
    files: list[Path] = []

    if not root.is_dir():
        print(f"❌ Not a directory: {directory}")
        sys.exit(1)

    for item in root.rglob("*"):
        # Skip excluded directories
        if any(part in SKIP_DIRS for part in item.parts):
            continue

        if item.is_file() and should_scan_file(item):
            files.append(item)

    return files


def get_context(lines: list[str], line_num: int) -> str:
    """Get surrounding context for a finding."""
    start = max(0, line_num - CONTEXT_LINES - 1)
    end = min(len(lines), line_num + CONTEXT_LINES)
    context_lines = []

    for i in range(start, end):
        marker = " >> " if i == line_num - 1 else "    "
        context_lines.append(f"{marker}{i + 1}: {lines[i].rstrip()}")

    return "\n".join(context_lines)


# ---------------------------------------------------------------------------
# Phase 1: Regex scanning
# ---------------------------------------------------------------------------


def scan_file_regex(file_path: Path, root_dir: Path) -> list[dict[str, Any]]:
    """Scan a single file with regex patterns. Returns list of candidate findings."""
    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeDecodeError):
        return []

    lines = content.splitlines()
    findings: list[dict[str, Any]] = []
    relative_path = str(file_path.relative_to(root_dir))

    # Skip .env.example files -- these have placeholders, not real secrets
    if file_path.name.endswith(".example"):
        return []

    for pattern_info in COMPILED_PATTERNS:
        regex = pattern_info["regex"]
        for i, line in enumerate(lines, 1):
            match = regex.search(line)
            if match:
                # Get the matched secret value
                secret_value = match.group(0).strip().strip("'\"=: ")

                findings.append({
                    "file": relative_path,
                    "line": i,
                    "pattern_name": pattern_info["name"],
                    "description": pattern_info["description"],
                    "matched_value": mask_secret(secret_value),
                    "context": get_context(lines, i),
                    "raw_line": line.rstrip(),
                })

    return findings


def mask_secret(value: str) -> str:
    """Mask a secret value, showing only first and last few chars."""
    if len(value) <= 8:
        return "*" * len(value)
    return value[:4] + "*" * (len(value) - 8) + value[-4:]


# ---------------------------------------------------------------------------
# Phase 2: LLM verification
# ---------------------------------------------------------------------------


async def verify_with_llm(
    findings: list[dict[str, Any]],
    model: str,
) -> list[dict[str, Any]]:
    """Use Claude to verify findings and rate severity."""
    if not findings:
        return []

    client = AsyncAnthropic()

    # Format findings for the LLM
    findings_text = ""
    for i, f in enumerate(findings, 1):
        findings_text += f"""
Finding #{i}:
  File: {f['file']}
  Line: {f['line']}
  Pattern: {f['pattern_name']}
  Context:
{f['context']}
---
"""

    prompt = f"""Analyze these potential secret/credential leaks found in a codebase.
For each finding, determine:
1. Is this a REAL secret or a false positive? (e.g., example values, test fixtures, env var references without values)
2. Severity: CRITICAL (production credentials), HIGH (valid-looking keys), MEDIUM (potentially sensitive), LOW (likely false positive)
3. A brief recommendation

Respond with a JSON array where each element has:
{{
  "finding_number": <int>,
  "is_real": <bool>,
  "severity": "<CRITICAL|HIGH|MEDIUM|LOW>",
  "reasoning": "<brief explanation>",
  "recommendation": "<what to do>"
}}

Findings to analyze:
{findings_text}

Return ONLY the JSON array."""

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=4096,
                temperature=0.1,
                messages=[{"role": "user", "content": prompt}],
            )

            text = ""
            for block in response.content:
                if block.type == "text":
                    text += block.text

            text = text.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1]
                if text.endswith("```"):
                    text = text[:-3]
                text = text.strip()

            verifications = json.loads(text)

            # Merge verification results back into findings
            verified: list[dict[str, Any]] = []
            for v in verifications:
                idx = v.get("finding_number", 0) - 1
                if 0 <= idx < len(findings):
                    finding = findings[idx].copy()
                    finding["is_real"] = v.get("is_real", True)
                    finding["severity"] = v.get("severity", "MEDIUM")
                    finding["reasoning"] = v.get("reasoning", "")
                    finding["recommendation"] = v.get("recommendation", "")
                    verified.append(finding)

            return verified

        except Exception as e:
            error_str = str(e)
            if attempt < MAX_RETRIES and (
                "rate" in error_str.lower()
                or "overloaded" in error_str.lower()
            ):
                wait_time = 2 ** attempt
                log("⏳", f"API error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait_time}s...")
                await asyncio.sleep(wait_time)
            elif attempt < MAX_RETRIES:
                log("⚠️", f"Verification error (attempt {attempt}/{MAX_RETRIES}): {e}")
                await asyncio.sleep(2)
            else:
                log("⚠️", f"Could not verify findings with LLM: {e}")
                # Return unverified findings with default severity
                return [
                    {**f, "is_real": True, "severity": "MEDIUM",
                     "reasoning": "Not verified by LLM", "recommendation": "Review manually"}
                    for f in findings
                ]

    return []


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


def print_results(findings: list[dict[str, Any]]) -> None:
    """Print scan results in a structured format."""
    severity_emoji = {
        "CRITICAL": "🔴",
        "HIGH": "🟠",
        "MEDIUM": "🟡",
        "LOW": "🟢",
    }

    # Separate real findings from false positives
    real_findings = [f for f in findings if f.get("is_real", True)]
    false_positives = [f for f in findings if not f.get("is_real", True)]

    if not real_findings:
        log("🎉", "No real secrets detected! All candidates were false positives.")
        if false_positives:
            print(f"   ({len(false_positives)} false positive(s) filtered out)")
        return

    # Group by severity
    by_severity: dict[str, list[dict[str, Any]]] = {}
    for f in real_findings:
        sev = f.get("severity", "MEDIUM")
        if sev not in by_severity:
            by_severity[sev] = []
        by_severity[sev].append(f)

    for severity in ["CRITICAL", "HIGH", "MEDIUM", "LOW"]:
        group = by_severity.get(severity, [])
        if not group:
            continue

        emoji = severity_emoji.get(severity, "⚪")
        print(f"\n{emoji} {severity} ({len(group)})")
        print("─" * 60)

        for f in group:
            print(f"  {f['file']}:{f['line']}")
            print(f"    Type: {f['pattern_name']}")
            print(f"    Value: {f['matched_value']}")
            if f.get("reasoning"):
                print(f"    Analysis: {f['reasoning']}")
            if f.get("recommendation"):
                print(f"    Action: {f['recommendation']}")
            print()

    if false_positives:
        print(f"  ({len(false_positives)} false positive(s) filtered out)")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the secret scanner agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    # Parse CLI arguments
    target_dir = "."
    skip_llm = False

    i = 0
    while i < len(args):
        if args[i] in ("--dir", "-d") and i + 1 < len(args):
            target_dir = args[i + 1]
            i += 2
        elif args[i] == "--no-llm":
            skip_llm = True
            i += 1
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py [OPTIONS]")
            print()
            print("Options:")
            print("  --dir, -d DIR   Directory to scan (default: current directory)")
            print("  --no-llm        Skip LLM verification (regex only)")
            print("  --help, -h      Show this help message")
            print()
            print("Examples:")
            print("  python main.py                     # Scan current directory")
            print("  python main.py --dir /path/to/project")
            print("  python main.py --dir ./src --no-llm")
            sys.exit(0)
        else:
            print(f"❌ Unknown argument: {args[i]}")
            print("   Use --help for usage information.")
            sys.exit(1)

    log("🚀", "Starting secret scanner agent...")
    log("🤖", f"Model: {model}")
    log("📁", f"Scanning: {os.path.abspath(target_dir)}")
    print()

    # Phase 1: Collect and scan files
    log("🔍", "Phase 1: Collecting files...")
    files = collect_files(target_dir)
    log("📄", f"Found {len(files)} files to scan")

    log("🔍", "Phase 1: Scanning with regex patterns...")
    root_dir = Path(target_dir).resolve()
    all_candidates: list[dict[str, Any]] = []

    for file_path in files:
        candidates = scan_file_regex(file_path, root_dir)
        all_candidates.extend(candidates)

    log("🔎", f"Found {len(all_candidates)} candidate(s) from regex scan")

    if not all_candidates:
        print()
        log("🎉", "No potential secrets detected. Your codebase looks clean!")
        log("✅", "Scan complete!")
        return

    # Phase 2: LLM verification
    if skip_llm:
        log("⏭️", "Skipping LLM verification (--no-llm flag)")
        verified = [
            {**f, "is_real": True, "severity": "MEDIUM",
             "reasoning": "Not verified (regex match only)",
             "recommendation": "Review manually"}
            for f in all_candidates
        ]
    else:
        print()
        log("🤖", f"Phase 2: Verifying {len(all_candidates)} candidate(s) with Claude...")

        # Process in batches of 20 for LLM verification
        verified: list[dict[str, Any]] = []
        batch_size = 20
        for batch_start in range(0, len(all_candidates), batch_size):
            batch = all_candidates[batch_start : batch_start + batch_size]
            batch_verified = await verify_with_llm(batch, model)
            verified.extend(batch_verified)

    # Print results
    print()
    print("=" * 60)
    log("📊", "Scan Results")
    print("=" * 60)

    real_count = len([f for f in verified if f.get("is_real", True)])
    print(f"  Files scanned:      {len(files)}")
    print(f"  Regex candidates:   {len(all_candidates)}")
    print(f"  Confirmed secrets:  {real_count}")

    print_results(verified)

    print()
    log("✅", "Scan complete!")

    # Exit with non-zero if real secrets were found
    if real_count > 0:
        critical = len([f for f in verified if f.get("is_real") and f.get("severity") == "CRITICAL"])
        if critical > 0:
            log("⚠️", f"{critical} CRITICAL finding(s) require immediate attention!")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
