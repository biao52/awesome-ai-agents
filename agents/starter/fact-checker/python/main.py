"""
Fact-Checker Agent - Verifies claims by searching the web and reading sources.

Uses Anthropic Claude for reasoning, Tavily for web search, and Reader for
reading source pages as clean markdown.
"""

import os
import sys
import json
import asyncio
from dataclasses import dataclass, field
from typing import Any

import httpx
from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

READER_API_URL = "https://api.reader.dev/v1/read"
TAVILY_API_URL = "https://api.tavily.com/search"

VERDICTS = ["TRUE", "FALSE", "PARTIALLY TRUE", "UNVERIFIABLE"]
CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"]


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["ANTHROPIC_API_KEY", "TAVILY_API_KEY", "READER_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class Source:
    """A source used during fact-checking."""
    url: str
    title: str
    snippet: str
    content: str = ""
    credibility: str = ""
    relevance: str = ""


@dataclass
class FactCheckResult:
    """The result of a fact-check."""
    claim: str
    verdict: str
    confidence: str
    summary: str
    supporting_evidence: list[str] = field(default_factory=list)
    contradicting_evidence: list[str] = field(default_factory=list)
    sources: list[Source] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Step 1: Search for relevant sources
# ---------------------------------------------------------------------------

async def search_for_sources(
    claim: str,
    client: AsyncAnthropic,
    model: str,
) -> list[dict[str, str]]:
    """Generate search queries for the claim and search using Tavily."""
    # Ask Claude to generate targeted search queries
    log("🧠", "Generating search queries for the claim...")

    response = await client.messages.create(
        model=model,
        max_tokens=512,
        messages=[
            {
                "role": "user",
                "content": (
                    f"I need to fact-check this claim: \"{claim}\"\n\n"
                    "Generate 2-3 search queries that would help verify or debunk "
                    "this claim. Return ONLY a JSON array of query strings, nothing else.\n\n"
                    "Example: [\"query one\", \"query two\", \"query three\"]"
                ),
            }
        ],
    )

    # Parse the search queries from Claude's response
    response_text = response.content[0].text.strip()
    try:
        queries = json.loads(response_text)
    except json.JSONDecodeError:
        # Fallback: use the claim itself as the search query
        queries = [claim]

    if not isinstance(queries, list):
        queries = [claim]

    log("🔍", f"Search queries: {queries}")

    # Search using Tavily for each query
    tavily_key = os.getenv("TAVILY_API_KEY", "")
    all_results: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    async with httpx.AsyncClient() as http_client:
        for query in queries[:3]:
            try:
                resp = await http_client.post(
                    TAVILY_API_URL,
                    json={
                        "api_key": tavily_key,
                        "query": query,
                        "max_results": 5,
                        "include_raw_content": False,
                    },
                    timeout=30.0,
                )
                resp.raise_for_status()
                data = resp.json()

                for item in data.get("results", []):
                    url = item.get("url", "")
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        all_results.append(
                            {
                                "title": item.get("title", ""),
                                "url": url,
                                "snippet": item.get("content", ""),
                            }
                        )
            except Exception as e:
                log("   ", f"Search error for '{query}': {e}")

    log("   ", f"Found {len(all_results)} unique sources")
    return all_results


# ---------------------------------------------------------------------------
# Step 2: Read source pages using Reader
# ---------------------------------------------------------------------------

async def read_source(url: str, http_client: httpx.AsyncClient) -> str:
    """Read a web page using Reader and return its markdown content."""
    try:
        resp = await http_client.post(
            READER_API_URL,
            json={"url": url},
            headers={"Authorization": f"Bearer {os.getenv('READER_API_KEY', '')}"},
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        text = data.get("data", {}).get("markdown", "")
        # Truncate to keep context manageable
        return text[:8000]
    except Exception as e:
        return f"Error reading page: {e}"


async def read_sources(
    search_results: list[dict[str, str]],
    max_sources: int = 5,
) -> list[Source]:
    """Read the top sources in parallel using Reader."""
    top_results = search_results[:max_sources]
    log("📖", f"Reading {len(top_results)} sources with Reader...")

    sources: list[Source] = []
    async with httpx.AsyncClient() as http_client:
        tasks = [read_source(result["url"], http_client) for result in top_results]
        contents = await asyncio.gather(*tasks, return_exceptions=True)

        for result, content in zip(top_results, contents):
            if isinstance(content, Exception):
                content_str = f"Error: {content}"
            else:
                content_str = content

            domain = result["url"].split("/")[2] if len(result["url"].split("/")) > 2 else result["url"]
            has_content = not content_str.startswith("Error")
            status = "read" if has_content else "failed"
            log("   ", f"[{status}] {domain}")

            sources.append(
                Source(
                    url=result["url"],
                    title=result["title"],
                    snippet=result["snippet"],
                    content=content_str,
                )
            )

    return sources


# ---------------------------------------------------------------------------
# Step 3: Analyze sources and determine verdict
# ---------------------------------------------------------------------------

ANALYSIS_PROMPT = """You are a rigorous fact-checker. Analyze the following claim against the provided sources and produce a structured fact-check verdict.

CLAIM: "{claim}"

SOURCES:
{sources_text}

Analyze each source for relevance and credibility. Then determine your verdict.

Respond with ONLY a JSON object in this exact format:
{{
    "verdict": "TRUE" | "FALSE" | "PARTIALLY TRUE" | "UNVERIFIABLE",
    "confidence": "HIGH" | "MEDIUM" | "LOW",
    "summary": "A 2-3 sentence summary of your findings",
    "supporting_evidence": ["Evidence point 1 that supports the claim", "..."],
    "contradicting_evidence": ["Evidence point 1 that contradicts the claim", "..."],
    "source_assessments": [
        {{
            "url": "source url",
            "credibility": "HIGH | MEDIUM | LOW",
            "relevance": "HIGH | MEDIUM | LOW"
        }}
    ]
}}

Rules:
- Base your verdict ONLY on evidence found in the sources
- If sources conflict, weigh more credible sources higher
- If sources are insufficient to verify, use UNVERIFIABLE
- Be specific in your evidence points, citing facts and data
- Assess source credibility based on domain reputation and content quality"""


async def analyze_sources(
    claim: str,
    sources: list[Source],
    client: AsyncAnthropic,
    model: str,
) -> FactCheckResult:
    """Analyze sources with Claude and produce a fact-check verdict."""
    log("🧪", "Analyzing sources and determining verdict...")

    # Build sources text for the prompt
    sources_text_parts: list[str] = []
    for i, source in enumerate(sources, 1):
        # Use snippet if full content failed
        content = source.content if not source.content.startswith("Error") else source.snippet
        sources_text_parts.append(
            f"--- Source {i} ---\n"
            f"Title: {source.title}\n"
            f"URL: {source.url}\n"
            f"Content:\n{content}\n"
        )

    sources_text = "\n".join(sources_text_parts)

    prompt = ANALYSIS_PROMPT.format(claim=claim, sources_text=sources_text)

    response = await client.messages.create(
        model=model,
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )

    response_text = response.content[0].text.strip()

    # Parse the JSON response
    try:
        # Handle case where Claude wraps JSON in markdown code blocks
        if response_text.startswith("```"):
            lines = response_text.split("\n")
            json_lines = [l for l in lines if not l.startswith("```")]
            response_text = "\n".join(json_lines)

        analysis = json.loads(response_text)
    except json.JSONDecodeError:
        # Fallback if JSON parsing fails
        return FactCheckResult(
            claim=claim,
            verdict="UNVERIFIABLE",
            confidence="LOW",
            summary="Analysis could not be completed due to a parsing error.",
            sources=sources,
        )

    # Apply source assessments back to our Source objects
    assessments = analysis.get("source_assessments", [])
    for assessment in assessments:
        url = assessment.get("url", "")
        for source in sources:
            if source.url == url:
                source.credibility = assessment.get("credibility", "MEDIUM")
                source.relevance = assessment.get("relevance", "MEDIUM")

    return FactCheckResult(
        claim=claim,
        verdict=analysis.get("verdict", "UNVERIFIABLE"),
        confidence=analysis.get("confidence", "LOW"),
        summary=analysis.get("summary", ""),
        supporting_evidence=analysis.get("supporting_evidence", []),
        contradicting_evidence=analysis.get("contradicting_evidence", []),
        sources=sources,
    )


# ---------------------------------------------------------------------------
# Step 4: Format and display the report
# ---------------------------------------------------------------------------

VERDICT_EMOJI = {
    "TRUE": "✅",
    "FALSE": "❌",
    "PARTIALLY TRUE": "🟡",
    "UNVERIFIABLE": "❓",
}

CONFIDENCE_BAR = {
    "HIGH": "███████████ HIGH",
    "MEDIUM": "███████░░░░ MEDIUM",
    "LOW": "████░░░░░░░ LOW",
}


def format_report(result: FactCheckResult) -> str:
    """Format the fact-check result as a readable report."""
    verdict_emoji = VERDICT_EMOJI.get(result.verdict, "❓")
    confidence_bar = CONFIDENCE_BAR.get(result.confidence, "░░░░░░░░░░░ ???")

    lines: list[str] = []
    lines.append("")
    lines.append("=" * 64)
    lines.append("  FACT-CHECK REPORT")
    lines.append("=" * 64)
    lines.append("")
    lines.append(f"  Claim: \"{result.claim}\"")
    lines.append("")
    lines.append(f"  Verdict:    {verdict_emoji} {result.verdict}")
    lines.append(f"  Confidence: {confidence_bar}")
    lines.append("")
    lines.append("-" * 64)
    lines.append("  Summary")
    lines.append("-" * 64)
    lines.append(f"  {result.summary}")
    lines.append("")

    if result.supporting_evidence:
        lines.append("-" * 64)
        lines.append("  Supporting Evidence")
        lines.append("-" * 64)
        for i, evidence in enumerate(result.supporting_evidence, 1):
            lines.append(f"  {i}. {evidence}")
        lines.append("")

    if result.contradicting_evidence:
        lines.append("-" * 64)
        lines.append("  Contradicting Evidence")
        lines.append("-" * 64)
        for i, evidence in enumerate(result.contradicting_evidence, 1):
            lines.append(f"  {i}. {evidence}")
        lines.append("")

    lines.append("-" * 64)
    lines.append("  Sources")
    lines.append("-" * 64)
    for i, source in enumerate(result.sources, 1):
        cred = f" (credibility: {source.credibility})" if source.credibility else ""
        lines.append(f"  [{i}] {source.title}{cred}")
        lines.append(f"      {source.url}")
    lines.append("")
    lines.append("=" * 64)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Agent orchestration
# ---------------------------------------------------------------------------

async def fact_check(claim: str, model: str) -> FactCheckResult:
    """Run the full fact-checking pipeline on a claim."""
    client = AsyncAnthropic()

    # Step 1: Search for relevant sources
    search_results = await search_for_sources(claim, client, model)

    if not search_results:
        return FactCheckResult(
            claim=claim,
            verdict="UNVERIFIABLE",
            confidence="LOW",
            summary="No relevant sources could be found for this claim.",
        )

    # Step 2: Read the top sources using Reader
    sources = await read_sources(search_results, max_sources=5)

    # Step 3: Analyze and produce verdict
    result = await analyze_sources(claim, sources, client, model)

    return result


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

async def main() -> None:
    """Main entry point for the fact-checker agent."""
    validate_env()

    model = os.getenv("MODEL", "claude-sonnet-4-20250514")

    # Get claim from CLI args or prompt interactively
    if len(sys.argv) > 1:
        args = sys.argv[1:]
        output_file = None
        claim_parts: list[str] = []

        i = 0
        while i < len(args):
            if args[i] == "--output" and i + 1 < len(args):
                output_file = args[i + 1]
                i += 2
            else:
                claim_parts.append(args[i])
                i += 1

        claim = " ".join(claim_parts)
    else:
        claim = input("🔎 Enter a claim to fact-check: ")
        output_file = None

    if not claim.strip():
        print("Please provide a claim to verify.")
        sys.exit(1)

    log("🚀", "Starting fact-checker agent...")
    log("📋", f"Claim: \"{claim}\"")
    log("🤖", f"Model: {model}")
    print()

    try:
        result = await fact_check(claim, model)
    except Exception as e:
        print(f"\nError during fact-check: {e}")
        sys.exit(1)

    report = format_report(result)
    print(report)

    if output_file:
        with open(output_file, "w") as f:
            f.write(report)
        log("💾", f"Report saved to {output_file}")


if __name__ == "__main__":
    asyncio.run(main())
