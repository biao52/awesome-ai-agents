"""
Dockerfile Generator Agent -- Reads a project directory and generates an
optimized multi-stage Dockerfile with best practices.

Uses Anthropic Claude for intelligent Dockerfile generation.
"""

import os
import sys
import asyncio
import argparse
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
MAX_RETRIES = 3
MAX_FILE_SIZE = 50_000  # Max chars to read from any single file

# Files that indicate project language/framework
PROJECT_FILES = [
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg",
    "Cargo.toml", "Cargo.lock",
    "go.mod", "go.sum",
    "pom.xml", "build.gradle", "build.gradle.kts",
    "Gemfile", "Gemfile.lock",
    "composer.json",
    "mix.exs",
    "Makefile", "CMakeLists.txt",
    ".nvmrc", ".python-version", ".ruby-version", ".tool-versions",
    ".dockerignore", "Dockerfile",
    "tsconfig.json", "next.config.js", "next.config.mjs", "next.config.ts",
    "vite.config.ts", "vite.config.js",
    "nuxt.config.ts", "angular.json",
    "nginx.conf", "supervisord.conf",
]

# Directories to skip when scanning
SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "env",
    "target", "dist", "build", ".next", ".nuxt", "vendor",
    ".tox", ".mypy_cache", ".pytest_cache", "coverage",
}

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
# Project scanning
# ---------------------------------------------------------------------------


def get_directory_tree(project_path: Path, max_depth: int = 3) -> str:
    """Build a directory tree string showing the project structure."""
    lines: list[str] = []

    def _walk(path: Path, prefix: str, depth: int) -> None:
        if depth > max_depth:
            return

        try:
            entries = sorted(path.iterdir(), key=lambda e: (not e.is_dir(), e.name))
        except PermissionError:
            return

        dirs = [e for e in entries if e.is_dir() and e.name not in SKIP_DIRS]
        files = [e for e in entries if e.is_file()]

        for f in files:
            lines.append(f"{prefix}{f.name}")

        for d in dirs:
            lines.append(f"{prefix}{d.name}/")
            _walk(d, prefix + "  ", depth + 1)

    lines.append(f"{project_path.name}/")
    _walk(project_path, "  ", 1)

    return "\n".join(lines[:200])  # Cap at 200 lines


def read_project_file(project_path: Path, filename: str) -> str | None:
    """Read a project file if it exists, returning its contents or None."""
    file_path = project_path / filename
    if not file_path.is_file():
        return None

    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
        if len(content) > MAX_FILE_SIZE:
            content = content[:MAX_FILE_SIZE] + "\n... (truncated)"
        return content
    except (PermissionError, OSError):
        return None


def scan_project(project_path: Path) -> dict[str, Any]:
    """Scan a project directory and collect relevant context."""
    log("📂", f"Scanning project: {project_path}")

    context: dict[str, Any] = {
        "path": str(project_path),
        "tree": get_directory_tree(project_path),
        "files": {},
    }

    found_count = 0
    for filename in PROJECT_FILES:
        content = read_project_file(project_path, filename)
        if content is not None:
            context["files"][filename] = content
            found_count += 1
            log("  📄", f"Found: {filename}")

    if found_count == 0:
        log("⚠️", "No recognized project files found. The Dockerfile will be based on directory structure only.")

    return context


# ---------------------------------------------------------------------------
# Dockerfile generation via Anthropic Claude
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert DevOps engineer specializing in Docker containerization. You generate production-grade, optimized Dockerfiles.

Your Dockerfiles MUST follow these best practices:

1. **Multi-stage builds** -- separate build and runtime stages to minimize image size
2. **Small base images** -- use Alpine or slim variants when possible (e.g., node:22-alpine, python:3.12-slim)
3. **Layer caching** -- copy dependency files first, install, then copy source code
4. **Non-root user** -- create and switch to a non-root user for security
5. **Health check** -- include a HEALTHCHECK instruction where applicable
6. **.dockerignore awareness** -- mention key files to add to .dockerignore
7. **Minimal final image** -- only copy necessary artifacts to the runtime stage
8. **Pinned versions** -- use specific version tags, never use :latest
9. **Combined RUN commands** -- reduce layers by combining related commands with &&
10. **Proper signal handling** -- use exec form for CMD, not shell form

Output ONLY the Dockerfile content. No markdown fencing, no explanations before or after. Just the raw Dockerfile.

Add brief, helpful comments in the Dockerfile itself explaining key decisions (e.g., why a specific base image was chosen, what each stage does).

If you see an existing Dockerfile in the project files, improve upon it rather than starting from scratch. Preserve any project-specific configuration while applying best practices."""


async def generate_dockerfile(context: dict[str, Any], model: str) -> str:
    """Send project context to Claude and generate an optimized Dockerfile."""
    client = AsyncAnthropic()

    # Build the user message with all project context
    parts: list[str] = [
        "Generate an optimized, production-ready Dockerfile for this project.\n",
        f"## Directory Structure\n```\n{context['tree']}\n```\n",
    ]

    for filename, content in context["files"].items():
        parts.append(f"## {filename}\n```\n{content}\n```\n")

    user_message = "\n".join(parts)

    for attempt in range(1, MAX_RETRIES + 1):
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

            return result.strip()

        except Exception as e:
            error_str = str(e)
            is_transient = (
                "rate" in error_str.lower()
                or "overloaded" in error_str.lower()
                or "529" in error_str
                or "500" in error_str
            )

            if attempt < MAX_RETRIES and is_transient:
                wait_time = 2 ** attempt
                log("⏳", f"API error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait_time}s...")
                await asyncio.sleep(wait_time)
            else:
                raise

    raise RuntimeError("Unreachable: max retries exceeded")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Generate an optimized Dockerfile for your project.",
        epilog="Examples:\n"
               "  python main.py\n"
               "  python main.py --project /path/to/project\n"
               "  python main.py --output Dockerfile\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--project",
        type=str,
        default=".",
        help="Path to the project directory (default: current directory)",
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        default=None,
        help="Save the generated Dockerfile to this path",
    )
    return parser.parse_args()


async def main() -> None:
    """Main entry point for the Dockerfile generator agent."""
    validate_env()

    args = parse_args()
    model = os.getenv("MODEL", DEFAULT_MODEL)

    project_path = Path(args.project).resolve()
    if not project_path.is_dir():
        print(f"❌ Not a directory: {args.project}")
        sys.exit(1)

    log("🚀", "Starting Dockerfile generator agent...")
    log("🤖", f"Model: {model}")
    print()

    # Scan the project
    context = scan_project(project_path)
    print()

    log("🔧", "Generating optimized Dockerfile...")

    try:
        dockerfile = await generate_dockerfile(context, model)
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error generating Dockerfile: {e}")
        print("   Check your ANTHROPIC_API_KEY and network connection.")
        sys.exit(1)

    print()

    # Output the Dockerfile
    if args.output:
        output_path = Path(args.output)
        try:
            output_path.write_text(dockerfile + "\n", encoding="utf-8")
            log("✅", f"Dockerfile saved to: {output_path}")
        except OSError as e:
            print(f"❌ Could not write file: {e}")
            sys.exit(1)
    else:
        print("─" * 60)
        print(dockerfile)
        print("─" * 60)
        print()
        log("💡", "Tip: Use --output Dockerfile to save directly to a file.")

    log("✅", "Done!")


if __name__ == "__main__":
    asyncio.run(main())
