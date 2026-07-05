"""
Software Dev Team -- Multi-Agent Pipeline
==========================================
A 4-agent pipeline (PM -> Architect -> Developer -> Reviewer) that takes
a feature request and produces implemented code through specialized AI agents.

Each agent has a distinct role and personality. Context flows forward through
the pipeline, and the Reviewer can send code back to the Developer for
revision (up to 2 rounds).

Usage:
    python main.py "Build a REST API for a blog with posts and comments"
    python main.py "Build a CLI task manager" --output ./artifacts
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_MODEL = os.getenv("MODEL", "gpt-4o")
MAX_REVISION_ROUNDS = 2
MAX_RETRIES = 3
RETRY_DELAY = 2.0

# Agent temperature settings -- lower = more deterministic
TEMPERATURES = {
    "pm": 0.4,
    "architect": 0.3,
    "developer": 0.2,
    "reviewer": 0.3,
}

# ---------------------------------------------------------------------------
# System Prompts
# ---------------------------------------------------------------------------

PM_SYSTEM_PROMPT = """\
You are a seasoned Product Manager with 15 years of experience shipping \
software products. Your job is to take a raw feature request and turn it \
into a clear, actionable specification.

Your responsibilities:
- Break the feature into user stories using the format: "As a [user], I want \
[capability] so that [benefit]"
- Define acceptance criteria for each story (Given/When/Then format)
- Identify edge cases and error scenarios
- Prioritize stories using MoSCoW (Must/Should/Could/Won't)
- Consider security, performance, and accessibility implications
- Estimate relative complexity (S/M/L/XL) for each story

Output format:
1. Feature Overview (2-3 sentences)
2. User Stories (numbered, with acceptance criteria)
3. Priority Matrix (MoSCoW classification)
4. Edge Cases & Error Scenarios
5. Non-functional Requirements
6. Out of Scope (things explicitly excluded)

Be thorough but practical. Focus on what delivers user value.\
"""

ARCHITECT_SYSTEM_PROMPT = """\
You are a Principal Software Architect with deep expertise in system design, \
API design, and software patterns. You receive product specifications and \
produce technical designs.

Your responsibilities:
- Choose appropriate technologies and justify decisions
- Define the project file structure with clear module boundaries
- Design interfaces, data models, and API contracts
- Identify integration points and external dependencies
- Plan for error handling, logging, and observability
- Consider scalability, maintainability, and testability

Output format:
1. Technical Summary (approach in 2-3 sentences)
2. Technology Choices (with brief justifications)
3. File Structure (tree format with descriptions)
4. Data Models / Schemas (with field types)
5. API Contracts / Interfaces (with request/response shapes)
6. Key Design Decisions (numbered, with rationale)
7. Error Handling Strategy
8. Testing Strategy

Be opinionated about best practices. Prefer simplicity over cleverness. \
Choose battle-tested libraries over novel ones.\
"""

DEVELOPER_SYSTEM_PROMPT = """\
You are a Senior Full-Stack Developer with expertise in writing clean, \
production-quality code. You receive a technical design and implement it \
completely.

Your responsibilities:
- Implement ALL files specified in the architecture
- Write complete, runnable code (never use placeholders or TODOs)
- Follow the language's idioms and best practices
- Include proper error handling and input validation
- Add clear comments for complex logic (but avoid obvious comments)
- Implement proper logging where appropriate
- Follow the data models and interfaces exactly as designed

Output format:
For each file, use this exact format:

=== FILE: path/to/file.ext ===
```language
<complete file contents>
```

Rules:
- Every file must be complete and self-contained
- Include all imports and dependencies
- Handle edge cases identified by the PM
- Follow the error handling strategy from the architecture
- Use consistent naming conventions throughout
- Do NOT use placeholder comments like "// TODO" or "// implement later"
- The code must be ready to run with no modifications\
"""

REVIEWER_SYSTEM_PROMPT = """\
You are a Staff Engineer and Code Reviewer known for thorough, constructive \
reviews. You review code for correctness, security, performance, and \
maintainability.

Your responsibilities:
- Check that all requirements from the PM spec are implemented
- Verify the code follows the architecture design
- Look for security vulnerabilities (injection, auth issues, data exposure)
- Identify performance problems (N+1 queries, memory leaks, blocking ops)
- Check error handling completeness
- Verify input validation and sanitization
- Assess code readability and maintainability
- Check for missing edge case handling

Output format:
1. Overall Assessment (1-2 sentences)
2. Verdict: APPROVED or CHANGES_NEEDED
3. Issues Found (if any):
   - [CRITICAL] Must fix before shipping
   - [MAJOR] Should fix, significant impact
   - [MINOR] Nice to fix, low impact
   - [NIT] Style/preference suggestions
4. Specific Feedback (reference file names and describe the issue clearly)
5. What Was Done Well (positive feedback)

If verdict is CHANGES_NEEDED, be very specific about what needs to change \
and why. Reference file names and describe the problem precisely so the \
developer can act on it without ambiguity.

If the code is solid, say APPROVED and highlight what was done well.\
"""

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------


def log(emoji: str, message: str) -> None:
    """Print a timestamped, emoji-prefixed log message."""
    timestamp = time.strftime("%H:%M:%S")
    print(f"  {emoji}  [{timestamp}] {message}")


def validate_env() -> None:
    """Ensure required environment variables are set."""
    if not os.getenv("OPENAI_API_KEY"):
        print("\nError: OPENAI_API_KEY is not set.")
        print("  1. Copy .env.example to .env")
        print("  2. Add your OpenAI API key")
        print("  3. Get a key at: https://platform.openai.com/api-keys\n")
        sys.exit(1)


def save_artifact(output_dir: Path, filename: str, content: str) -> None:
    """Save an artifact to the output directory."""
    output_dir.mkdir(parents=True, exist_ok=True)
    filepath = output_dir / filename
    filepath.write_text(content, encoding="utf-8")
    log("💾", f"Saved {filepath}")


# ---------------------------------------------------------------------------
# OpenAI Call with Retry
# ---------------------------------------------------------------------------


async def call_agent(
    client: AsyncOpenAI,
    system_prompt: str,
    user_message: str,
    temperature: float,
    model: str = DEFAULT_MODEL,
) -> str:
    """Call OpenAI with retry logic. Returns the assistant's response text."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.chat.completions.create(
                model=model,
                temperature=temperature,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
            )
            content = response.choices[0].message.content
            if content is None:
                raise ValueError("Received empty response from API")
            return content
        except Exception as exc:
            if attempt == MAX_RETRIES:
                raise RuntimeError(
                    f"API call failed after {MAX_RETRIES} attempts: {exc}"
                ) from exc
            log("🔄", f"Retry {attempt}/{MAX_RETRIES} after error: {exc}")
            await asyncio.sleep(RETRY_DELAY * attempt)

    # Should never reach here, but satisfies type checker
    raise RuntimeError("Unexpected: exhausted retries without raising")


# ---------------------------------------------------------------------------
# Agent Functions
# ---------------------------------------------------------------------------


async def run_pm_agent(client: AsyncOpenAI, feature_request: str) -> str:
    """PM Agent: Breaks a feature request into user stories and specs."""
    log("📋", "PM Agent: Analyzing feature request...")

    prompt = (
        f"Feature Request:\n\n{feature_request}\n\n"
        "Break this down into a complete product specification with user "
        "stories, acceptance criteria, and priority rankings."
    )

    result = await call_agent(
        client, PM_SYSTEM_PROMPT, prompt, TEMPERATURES["pm"]
    )

    log("✅", "PM Agent: Specification complete")
    return result


async def run_architect_agent(
    client: AsyncOpenAI, pm_output: str, feature_request: str
) -> str:
    """Architect Agent: Designs the technical approach from PM specs."""
    log("🏗️", "Architect Agent: Designing technical architecture...")

    prompt = (
        f"Original Feature Request:\n{feature_request}\n\n"
        f"Product Specification (from PM):\n\n{pm_output}\n\n"
        "Design a complete technical architecture for this feature. "
        "Include file structure, data models, API contracts, and key "
        "design decisions."
    )

    result = await call_agent(
        client, ARCHITECT_SYSTEM_PROMPT, prompt, TEMPERATURES["architect"]
    )

    log("✅", "Architect Agent: Architecture design complete")
    return result


async def run_developer_agent(
    client: AsyncOpenAI,
    architect_output: str,
    pm_output: str,
    feature_request: str,
    revision_feedback: Optional[str] = None,
) -> str:
    """Developer Agent: Implements the code from the architecture design."""
    if revision_feedback:
        log("🔧", "Developer Agent: Revising code based on review feedback...")
        prompt = (
            f"Original Feature Request:\n{feature_request}\n\n"
            f"Product Specification:\n\n{pm_output}\n\n"
            f"Architecture Design:\n\n{architect_output}\n\n"
            f"Your previous implementation received review feedback. "
            f"Please revise the code to address these issues:\n\n"
            f"Review Feedback:\n{revision_feedback}\n\n"
            "Provide the complete updated implementation for ALL files. "
            "Do not skip files that were not mentioned in the feedback."
        )
    else:
        log("💻", "Developer Agent: Implementing code...")
        prompt = (
            f"Original Feature Request:\n{feature_request}\n\n"
            f"Product Specification:\n\n{pm_output}\n\n"
            f"Architecture Design:\n\n{architect_output}\n\n"
            "Implement the complete code for this project. Output every "
            "file with its full contents. The code must be production-ready "
            "and runnable without modifications."
        )

    result = await call_agent(
        client, DEVELOPER_SYSTEM_PROMPT, prompt, TEMPERATURES["developer"]
    )

    log("✅", "Developer Agent: Implementation complete")
    return result


async def run_reviewer_agent(
    client: AsyncOpenAI,
    developer_output: str,
    architect_output: str,
    pm_output: str,
) -> str:
    """Reviewer Agent: Reviews code for quality, security, and completeness."""
    log("🔍", "Reviewer Agent: Reviewing code...")

    prompt = (
        f"Product Specification:\n\n{pm_output}\n\n"
        f"Architecture Design:\n\n{architect_output}\n\n"
        f"Implementation to Review:\n\n{developer_output}\n\n"
        "Review this implementation thoroughly. Check that all requirements "
        "are met, the architecture is followed, and the code is production-ready. "
        "Provide your verdict (APPROVED or CHANGES_NEEDED) with specific feedback."
    )

    result = await call_agent(
        client, REVIEWER_SYSTEM_PROMPT, prompt, TEMPERATURES["reviewer"]
    )

    log("✅", "Reviewer Agent: Review complete")
    return result


def review_needs_changes(review_output: str) -> bool:
    """Check if the reviewer's verdict requires changes."""
    upper = review_output.upper()
    return "CHANGES_NEEDED" in upper


# ---------------------------------------------------------------------------
# Pipeline Orchestration
# ---------------------------------------------------------------------------


async def run_pipeline(
    feature_request: str, output_dir: Optional[str] = None
) -> dict[str, str]:
    """
    Run the full 4-agent pipeline with revision loop.

    Returns a dict of all artifacts produced.
    """
    client = AsyncOpenAI()
    artifacts: dict[str, str] = {"feature_request": feature_request}

    print("\n" + "=" * 60)
    print("  Software Dev Team -- Multi-Agent Pipeline")
    print("=" * 60)
    print(f"\n  Feature: {feature_request}\n")

    # --- Phase 1: Product Management ---
    print("-" * 40)
    pm_output = await run_pm_agent(client, feature_request)
    artifacts["pm_specification"] = pm_output

    # --- Phase 2: Architecture ---
    print("-" * 40)
    architect_output = await run_architect_agent(
        client, pm_output, feature_request
    )
    artifacts["architecture_design"] = architect_output

    # --- Phase 3 & 4: Development + Review (with revision loop) ---
    print("-" * 40)
    developer_output = await run_developer_agent(
        client, architect_output, pm_output, feature_request
    )
    artifacts["code_v1"] = developer_output

    for revision in range(1, MAX_REVISION_ROUNDS + 1):
        print("-" * 40)
        review_output = await run_reviewer_agent(
            client, developer_output, architect_output, pm_output
        )
        artifacts[f"review_v{revision}"] = review_output

        if not review_needs_changes(review_output):
            log("🎉", "Code APPROVED by Reviewer!")
            break

        log("🔁", f"Revision round {revision}/{MAX_REVISION_ROUNDS}")

        if revision < MAX_REVISION_ROUNDS:
            print("-" * 40)
            developer_output = await run_developer_agent(
                client,
                architect_output,
                pm_output,
                feature_request,
                revision_feedback=review_output,
            )
            artifacts[f"code_v{revision + 1}"] = developer_output
        else:
            log("⚠️", "Max revision rounds reached. Proceeding with latest code.")
    else:
        # Loop completed without break -- final review after last revision
        print("-" * 40)
        final_review = await run_reviewer_agent(
            client, developer_output, architect_output, pm_output
        )
        artifacts[f"review_v{MAX_REVISION_ROUNDS + 1}"] = final_review
        if not review_needs_changes(final_review):
            log("🎉", "Code APPROVED by Reviewer after revisions!")
        else:
            log("⚠️", "Reviewer still has concerns. Manual review recommended.")

    artifacts["final_code"] = developer_output

    # --- Save artifacts ---
    if output_dir:
        out_path = Path(output_dir)
        save_artifact(out_path, "01_pm_specification.md", pm_output)
        save_artifact(out_path, "02_architecture_design.md", architect_output)

        # Save all code versions
        for key, value in artifacts.items():
            if key.startswith("code_v"):
                version = key.split("_v")[1]
                save_artifact(out_path, f"03_code_v{version}.md", value)

        # Save all reviews
        for key, value in artifacts.items():
            if key.startswith("review_v"):
                version = key.split("_v")[1]
                save_artifact(out_path, f"04_review_v{version}.md", value)

        save_artifact(out_path, "05_final_code.md", developer_output)

        # Save a summary manifest
        manifest = {
            "feature_request": feature_request,
            "model": DEFAULT_MODEL,
            "artifacts": list(artifacts.keys()),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        save_artifact(
            out_path, "manifest.json", json.dumps(manifest, indent=2)
        )

    # --- Print summary ---
    print("\n" + "=" * 60)
    print("  Pipeline Complete!")
    print("=" * 60)
    print(f"\n  Artifacts produced: {len(artifacts)}")
    if output_dir:
        print(f"  Output directory:   {output_dir}")
    print()

    return artifacts


# ---------------------------------------------------------------------------
# CLI Entry Point
# ---------------------------------------------------------------------------


def _override_model(model: str) -> None:
    """Override the default model at runtime."""
    global DEFAULT_MODEL
    DEFAULT_MODEL = model


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Software Dev Team -- Multi-Agent Pipeline",
        epilog="Example: python main.py \"Build a REST API for a blog\"",
    )
    parser.add_argument(
        "feature",
        help="The feature request to build",
    )
    parser.add_argument(
        "--output",
        "-o",
        help="Directory to save all artifacts",
        default=None,
    )
    parser.add_argument(
        "--model",
        "-m",
        help=f"OpenAI model to use (default: {DEFAULT_MODEL})",
        default=None,
    )

    args = parser.parse_args()

    validate_env()

    if args.model:
        _override_model(args.model)

    try:
        asyncio.run(run_pipeline(args.feature, args.output))
    except KeyboardInterrupt:
        print("\n\nInterrupted by user.")
        sys.exit(130)
    except Exception as exc:
        log("❌", f"Pipeline failed: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
