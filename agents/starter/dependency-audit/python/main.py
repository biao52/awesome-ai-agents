"""
Dependency Audit Agent -- Reads dependency files (package.json, requirements.txt,
Cargo.toml, go.mod) and checks for known vulnerabilities using the OSV API.

Uses OpenAI GPT for summarizing findings and providing actionable recommendations.
"""

import os
import re
import sys
import json
import asyncio
from typing import Any
from pathlib import Path

import httpx
from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o-mini"
OSV_API_URL = "https://api.osv.dev/v1/query"
REQUEST_TIMEOUT = 30.0
MAX_RETRIES = 3

# Supported dependency file types and their ecosystems
SUPPORTED_FILES: dict[str, str] = {
    "package.json": "npm",
    "requirements.txt": "PyPI",
    "Cargo.toml": "crates.io",
    "go.mod": "Go",
}


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
# Dependency file parsing
# ---------------------------------------------------------------------------


def find_dependency_files(directory: str) -> list[tuple[str, str]]:
    """Find supported dependency files in a directory. Returns list of (path, ecosystem)."""
    found: list[tuple[str, str]] = []
    dir_path = Path(directory).resolve()

    for filename, ecosystem in SUPPORTED_FILES.items():
        file_path = dir_path / filename
        if file_path.is_file():
            found.append((str(file_path), ecosystem))

    return found


def parse_package_json(file_path: str) -> list[tuple[str, str]]:
    """Parse package.json and return list of (package_name, version)."""
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    deps: list[tuple[str, str]] = []

    for section in ("dependencies", "devDependencies"):
        section_deps = data.get(section, {})
        for name, version_spec in section_deps.items():
            # Strip version prefixes like ^, ~, >=
            version = re.sub(r"^[\^~>=<\s]+", "", version_spec)
            # Handle ranges: take the first version number
            version = version.split(" ")[0].split(",")[0].strip()
            if version:
                deps.append((name, version))

    return deps


def parse_requirements_txt(file_path: str) -> list[tuple[str, str]]:
    """Parse requirements.txt and return list of (package_name, version)."""
    deps: list[tuple[str, str]] = []

    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("-"):
                continue

            # Handle various formats: pkg==1.0, pkg>=1.0, pkg~=1.0
            match = re.match(r"^([a-zA-Z0-9_.-]+)\s*[><=~!]+\s*([\d.]+)", line)
            if match:
                deps.append((match.group(1), match.group(2)))
            else:
                # Package without version pin
                pkg_name = re.match(r"^([a-zA-Z0-9_.-]+)", line)
                if pkg_name:
                    deps.append((pkg_name.group(1), ""))

    return deps


def parse_cargo_toml(file_path: str) -> list[tuple[str, str]]:
    """Parse Cargo.toml dependencies (basic TOML parsing without toml library)."""
    deps: list[tuple[str, str]] = []
    in_deps_section = False

    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()

            if line.startswith("["):
                in_deps_section = line in ("[dependencies]", "[dev-dependencies]")
                continue

            if in_deps_section and "=" in line:
                parts = line.split("=", 1)
                name = parts[0].strip()
                value = parts[1].strip().strip('"').strip("'")

                # Handle both `name = "1.0"` and `name = { version = "1.0" }`
                version_match = re.search(r'version\s*=\s*"([^"]+)"', value)
                if version_match:
                    version = version_match.group(1)
                else:
                    version = re.sub(r"^[\^~>=<\s]+", "", value)

                if name and version:
                    deps.append((name, version))

    return deps


def parse_go_mod(file_path: str) -> list[tuple[str, str]]:
    """Parse go.mod and return list of (module_path, version)."""
    deps: list[tuple[str, str]] = []
    in_require = False

    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()

            if line.startswith("require ("):
                in_require = True
                continue
            if line == ")" and in_require:
                in_require = False
                continue

            if in_require or line.startswith("require "):
                parts = line.replace("require ", "").strip().split()
                if len(parts) >= 2:
                    module = parts[0]
                    version = parts[1].lstrip("v")
                    deps.append((module, version))

    return deps


def parse_dependency_file(file_path: str, ecosystem: str) -> list[tuple[str, str]]:
    """Parse a dependency file and return list of (name, version)."""
    parsers = {
        "npm": parse_package_json,
        "PyPI": parse_requirements_txt,
        "crates.io": parse_cargo_toml,
        "Go": parse_go_mod,
    }

    parser = parsers.get(ecosystem)
    if not parser:
        log("⚠️", f"No parser for ecosystem: {ecosystem}")
        return []

    try:
        return parser(file_path)
    except Exception as e:
        log("❌", f"Error parsing {file_path}: {e}")
        return []


# ---------------------------------------------------------------------------
# OSV vulnerability lookup
# ---------------------------------------------------------------------------


async def query_osv(
    client: httpx.AsyncClient,
    package_name: str,
    version: str,
    ecosystem: str,
) -> list[dict[str, Any]]:
    """Query the OSV API for vulnerabilities affecting a specific package version."""
    payload: dict[str, Any] = {
        "package": {
            "name": package_name,
            "ecosystem": ecosystem,
        }
    }

    if version:
        payload["version"] = version

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.post(
                OSV_API_URL,
                json=payload,
                timeout=REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            data = response.json()
            return data.get("vulns", [])
        except httpx.TimeoutException:
            if attempt < MAX_RETRIES:
                await asyncio.sleep(2 ** attempt)
            else:
                log("⚠️", f"Timeout querying OSV for {package_name}. Skipping.")
                return []
        except httpx.HTTPStatusError as e:
            if attempt < MAX_RETRIES and e.response.status_code >= 500:
                await asyncio.sleep(2 ** attempt)
            else:
                return []
        except httpx.RequestError:
            if attempt < MAX_RETRIES:
                await asyncio.sleep(2 ** attempt)
            else:
                return []

    return []


async def check_all_dependencies(
    deps: list[tuple[str, str]],
    ecosystem: str,
) -> list[dict[str, Any]]:
    """Check all dependencies for vulnerabilities. Returns list of findings."""
    findings: list[dict[str, Any]] = []

    async with httpx.AsyncClient() as client:
        # Process in batches of 5 to avoid overwhelming the API
        batch_size = 5
        for i in range(0, len(deps), batch_size):
            batch = deps[i : i + batch_size]
            tasks = [
                query_osv(client, name, version, ecosystem)
                for name, version in batch
            ]
            results = await asyncio.gather(*tasks)

            for (name, version), vulns in zip(batch, results):
                if vulns:
                    for vuln in vulns:
                        severity = extract_severity(vuln)
                        fixed_version = extract_fixed_version(vuln, ecosystem)
                        findings.append({
                            "package": name,
                            "version": version,
                            "vuln_id": vuln.get("id", "Unknown"),
                            "summary": vuln.get("summary", "No description available"),
                            "severity": severity,
                            "fixed_version": fixed_version,
                            "references": [
                                ref.get("url", "")
                                for ref in vuln.get("references", [])[:3]
                            ],
                        })

    return findings


def extract_severity(vuln: dict[str, Any]) -> str:
    """Extract severity level from an OSV vulnerability entry."""
    # Check database_specific severity
    db_specific = vuln.get("database_specific", {})
    if "severity" in db_specific:
        return str(db_specific["severity"]).upper()

    # Check CVSS severity in severity array
    severity_list = vuln.get("severity", [])
    for sev in severity_list:
        if sev.get("type") == "CVSS_V3":
            score_str = sev.get("score", "")
            # Extract score from CVSS vector if possible
            if isinstance(score_str, str) and score_str.startswith("CVSS:"):
                return "HIGH"  # Simplified -- would need full CVSS parsing
            return "MODERATE"

    # Check ecosystem severity from affected entries
    for affected in vuln.get("affected", []):
        eco_specific = affected.get("ecosystem_specific", {})
        if "severity" in eco_specific:
            return str(eco_specific["severity"]).upper()

    return "UNKNOWN"


def extract_fixed_version(vuln: dict[str, Any], ecosystem: str) -> str:
    """Extract the fixed version from an OSV vulnerability entry."""
    for affected in vuln.get("affected", []):
        for rng in affected.get("ranges", []):
            for event in rng.get("events", []):
                if "fixed" in event:
                    return str(event["fixed"])

    return "No fix available"


# ---------------------------------------------------------------------------
# LLM summary
# ---------------------------------------------------------------------------


async def generate_summary(
    findings: list[dict[str, Any]],
    total_deps: int,
    ecosystem: str,
    model: str,
) -> str:
    """Use the LLM to generate a human-readable summary and recommendations."""
    client = AsyncOpenAI()

    findings_text = json.dumps(findings, indent=2)

    response = await client.chat.completions.create(
        model=model,
        temperature=0.3,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a security engineer summarizing dependency audit results. "
                    "Be concise and actionable. Focus on what the developer should do next. "
                    "Group findings by severity. Mention specific version upgrades when available."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Summarize these dependency audit findings for a {ecosystem} project.\n"
                    f"Total dependencies scanned: {total_deps}\n"
                    f"Vulnerable packages found: {len(set(f['package'] for f in findings))}\n"
                    f"Total vulnerabilities: {len(findings)}\n\n"
                    f"Findings:\n{findings_text}\n\n"
                    "Provide:\n"
                    "1. A brief overview (2-3 sentences)\n"
                    "2. Priority actions (what to fix first)\n"
                    "3. Specific upgrade commands for the ecosystem\n"
                    "Keep it under 300 words."
                ),
            },
        ],
    )

    return response.choices[0].message.content or "No summary generated."


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


def print_findings(findings: list[dict[str, Any]]) -> None:
    """Print vulnerability findings in a structured format."""
    if not findings:
        return

    severity_emoji = {
        "CRITICAL": "🔴",
        "HIGH": "🟠",
        "MODERATE": "🟡",
        "LOW": "🟢",
        "UNKNOWN": "⚪",
    }

    # Group by severity
    by_severity: dict[str, list[dict[str, Any]]] = {}
    for finding in findings:
        sev = finding["severity"]
        if sev not in by_severity:
            by_severity[sev] = []
        by_severity[sev].append(finding)

    # Print in severity order
    for severity in ["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"]:
        group = by_severity.get(severity, [])
        if not group:
            continue

        emoji = severity_emoji.get(severity, "⚪")
        print(f"\n{emoji} {severity} ({len(group)})")
        print("─" * 50)

        for finding in group:
            print(f"  {finding['package']}@{finding['version']}")
            print(f"    ID: {finding['vuln_id']}")
            print(f"    {finding['summary'][:120]}")
            if finding["fixed_version"] != "No fix available":
                print(f"    Fix: upgrade to {finding['fixed_version']}")
            else:
                print(f"    Fix: {finding['fixed_version']}")
            if finding["references"]:
                print(f"    Ref: {finding['references'][0]}")
            print()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the dependency audit agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    # Parse CLI arguments
    target_file: str | None = None
    target_dir = "."

    i = 0
    while i < len(args):
        if args[i] in ("--file", "-f") and i + 1 < len(args):
            target_file = args[i + 1]
            i += 2
        elif args[i] in ("--dir", "-d") and i + 1 < len(args):
            target_dir = args[i + 1]
            i += 2
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py [OPTIONS]")
            print()
            print("Options:")
            print("  --file, -f PATH   Audit a specific dependency file")
            print("  --dir, -d DIR     Scan a directory for dependency files (default: current dir)")
            print("  --help, -h        Show this help message")
            print()
            print("Supported files: package.json, requirements.txt, Cargo.toml, go.mod")
            print()
            print("Examples:")
            print("  python main.py                      # Auto-detect in current directory")
            print("  python main.py --file package.json   # Audit a specific file")
            print("  python main.py --dir /path/to/project")
            sys.exit(0)
        else:
            print(f"❌ Unknown argument: {args[i]}")
            print("   Use --help for usage information.")
            sys.exit(1)

    log("🚀", "Starting dependency audit agent...")
    log("🤖", f"Model: {model}")
    print()

    # Find dependency files
    if target_file:
        abs_path = os.path.abspath(target_file)
        if not os.path.isfile(abs_path):
            print(f"❌ File not found: {target_file}")
            sys.exit(1)

        filename = os.path.basename(abs_path)
        ecosystem = SUPPORTED_FILES.get(filename)
        if not ecosystem:
            print(f"❌ Unsupported file type: {filename}")
            print(f"   Supported: {', '.join(SUPPORTED_FILES.keys())}")
            sys.exit(1)

        files_to_audit = [(abs_path, ecosystem)]
    else:
        files_to_audit = find_dependency_files(target_dir)

    if not files_to_audit:
        print("❌ No dependency files found.")
        print(f"   Supported: {', '.join(SUPPORTED_FILES.keys())}")
        print(f"   Searched in: {os.path.abspath(target_dir)}")
        sys.exit(1)

    log("📁", f"Found {len(files_to_audit)} dependency file(s)")

    all_findings: list[dict[str, Any]] = []
    total_deps = 0

    for file_path, ecosystem in files_to_audit:
        filename = os.path.basename(file_path)
        log("📦", f"Parsing {filename} ({ecosystem})...")

        deps = parse_dependency_file(file_path, ecosystem)
        if not deps:
            log("⚠️", f"No dependencies found in {filename}")
            continue

        total_deps += len(deps)
        log("🔍", f"Checking {len(deps)} dependencies against OSV database...")

        findings = await check_all_dependencies(deps, ecosystem)
        all_findings.extend(findings)

        if findings:
            log("⚠️", f"Found {len(findings)} vulnerability/ies in {filename}")
        else:
            log("✅", f"No known vulnerabilities in {filename}")

    # Print results
    print()
    print("=" * 60)
    log("📊", "Audit Results")
    print("=" * 60)
    print(f"  Dependencies scanned: {total_deps}")
    print(f"  Vulnerabilities found: {len(all_findings)}")
    vuln_packages = len(set(f["package"] for f in all_findings))
    print(f"  Vulnerable packages:  {vuln_packages}")

    if all_findings:
        print_findings(all_findings)

        # Generate LLM summary
        print()
        log("🤖", "Generating recommendations...")
        try:
            ecosystem_name = files_to_audit[0][1] if files_to_audit else "unknown"
            summary = await generate_summary(all_findings, total_deps, ecosystem_name, model)
            print()
            print("💡 Recommendations")
            print("─" * 50)
            print(summary)
        except Exception as e:
            log("⚠️", f"Could not generate summary: {e}")
    else:
        print()
        log("🎉", "All clear! No known vulnerabilities detected.")

    print()
    log("✅", "Audit complete!")


if __name__ == "__main__":
    asyncio.run(main())
