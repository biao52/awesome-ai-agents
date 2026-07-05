"""
Deep Research Agent -- Multi-step research agent that decomposes questions,
executes parallel web searches, evaluates source credibility, identifies gaps,
and produces comprehensive reports with citations and cost tracking.

Uses Anthropic Claude (Sonnet for reasoning, Haiku for extraction) and Tavily for search.
"""

import os
import sys
import json
import asyncio
import time
from typing import Any
from dataclasses import dataclass, field

import httpx
from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_REASONING_MODEL = "claude-sonnet-4-20250514"
DEFAULT_EXTRACTION_MODEL = "claude-haiku-4-5-20251001"
MAX_SOURCES_PER_QUESTION = 5
MAX_FOLLOW_UP_ROUNDS = 2
MAX_PAGE_LENGTH = 8000  # Chars to keep per page
REQUEST_TIMEOUT = 20.0

# Pricing per million tokens (approximate)
PRICING = {
    "claude-sonnet-4-20250514": {"input": 3.0, "output": 15.0},
    "claude-haiku-4-5-20251001": {"input": 0.80, "output": 4.0},
}

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables."""
    required = ["ANTHROPIC_API_KEY", "TAVILY_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Token and cost tracking
# ---------------------------------------------------------------------------


@dataclass
class UsageTracker:
    """Track token usage and estimated costs across all API calls."""
    input_tokens: dict[str, int] = field(default_factory=dict)
    output_tokens: dict[str, int] = field(default_factory=dict)

    def add(self, model: str, input_toks: int, output_toks: int) -> None:
        self.input_tokens[model] = self.input_tokens.get(model, 0) + input_toks
        self.output_tokens[model] = self.output_tokens.get(model, 0) + output_toks

    def total_cost(self) -> float:
        cost = 0.0
        for model in set(list(self.input_tokens.keys()) + list(self.output_tokens.keys())):
            pricing = PRICING.get(model, {"input": 3.0, "output": 15.0})
            inp = self.input_tokens.get(model, 0)
            out = self.output_tokens.get(model, 0)
            cost += (inp / 1_000_000) * pricing["input"]
            cost += (out / 1_000_000) * pricing["output"]
        return cost

    def summary(self) -> str:
        lines = ["Token Usage:"]
        for model in sorted(set(list(self.input_tokens.keys()) + list(self.output_tokens.keys()))):
            inp = self.input_tokens.get(model, 0)
            out = self.output_tokens.get(model, 0)
            lines.append(f"  {model}: {inp:,} input + {out:,} output")
        lines.append(f"  Estimated cost: ${self.total_cost():.4f}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Web search and page reading
# ---------------------------------------------------------------------------


async def search_web(query: str, max_results: int = MAX_SOURCES_PER_QUESTION) -> list[dict[str, str]]:
    """Search the web using Tavily API."""
    api_key = os.getenv("TAVILY_API_KEY", "")
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": api_key,
                    "query": query,
                    "max_results": max_results,
                    "include_raw_content": False,
                },
                timeout=REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            data = response.json()
        return [
            {"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("content", "")}
            for r in data.get("results", [])
        ]
    except Exception as e:
        log("⚠️", f"Search failed for '{query}': {e}")
        return []


async def read_page(url: str) -> str:
    """Fetch a web page and return text content."""
    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            response = await client.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; DeepResearchAgent/1.0)"},
                timeout=REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            return response.text[:MAX_PAGE_LENGTH]
    except Exception as e:
        return f"[Error reading page: {e}]"


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------


async def call_llm(
    client: AsyncAnthropic,
    model: str,
    system: str,
    user_message: str,
    tracker: UsageTracker,
    max_tokens: int = 4096,
    temperature: float = 0.3,
) -> str:
    """Call Anthropic API and track usage."""
    response = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user_message}],
        temperature=temperature,
    )
    tracker.add(model, response.usage.input_tokens, response.usage.output_tokens)
    return "".join(b.text for b in response.content if b.type == "text")


# ---------------------------------------------------------------------------
# Research phases
# ---------------------------------------------------------------------------


async def plan_research(
    client: AsyncAnthropic, topic: str, model: str, tracker: UsageTracker
) -> list[str]:
    """Decompose the research topic into sub-questions."""
    system = """You are a research planning expert. Given a topic, decompose it into 5-8 specific, searchable sub-questions that together provide comprehensive coverage.

Output ONLY a JSON array of strings. No explanation, no markdown.
Example: ["What is X?", "How does Y work?", "What are the benefits of Z?"]"""

    result = await call_llm(client, model, system, f"Topic: {topic}", tracker)
    result = result.strip()
    if result.startswith("```"):
        result = result.split("\n", 1)[-1].rsplit("```", 1)[0]

    try:
        questions = json.loads(result)
        if isinstance(questions, list):
            return [str(q) for q in questions]
    except json.JSONDecodeError:
        pass

    # Fallback: split by newlines
    return [line.strip().lstrip("0123456789.-) ") for line in result.split("\n") if line.strip()]


async def research_sub_question(
    client: AsyncAnthropic,
    question: str,
    extraction_model: str,
    tracker: UsageTracker,
) -> dict[str, Any]:
    """Research a single sub-question: search, read pages, extract findings."""
    log("🌐", f"Researching: {question}")

    # Search
    search_results = await search_web(question)
    if not search_results:
        return {"question": question, "findings": [], "sources": []}

    log("   ", f"Found {len(search_results)} results, reading top pages...")

    # Read pages in parallel
    read_tasks = [read_page(r["url"]) for r in search_results[:3]]
    page_contents = await asyncio.gather(*read_tasks)

    # Extract findings using Haiku (cheaper for extraction)
    sources_text = ""
    sources = []
    for i, (result, content) in enumerate(zip(search_results[:3], page_contents)):
        sources_text += f"\n--- Source {i+1}: {result['title']} ({result['url']}) ---\n{content}\n"
        sources.append({"title": result["title"], "url": result["url"]})

    system = """You are a research extraction expert. Given web sources and a question, extract the key findings.

Output a JSON object with:
- "findings": array of strings, each a specific fact/insight from the sources
- "credibility": "high", "medium", or "low" based on source quality

Be specific. Include data, dates, and numbers when available. Do NOT make up information."""

    extraction = await call_llm(
        client, extraction_model, system,
        f"Question: {question}\n\nSources:\n{sources_text}",
        tracker, max_tokens=2048,
    )

    try:
        extraction = extraction.strip()
        if extraction.startswith("```"):
            extraction = extraction.split("\n", 1)[-1].rsplit("```", 1)[0]
        parsed = json.loads(extraction)
        findings = parsed.get("findings", [])
        credibility = parsed.get("credibility", "medium")
    except (json.JSONDecodeError, AttributeError):
        findings = [extraction]
        credibility = "medium"

    log("   ", f"Extracted {len(findings)} findings (credibility: {credibility})")

    return {
        "question": question,
        "findings": findings,
        "sources": sources,
        "credibility": credibility,
    }


async def identify_gaps(
    client: AsyncAnthropic,
    topic: str,
    research_results: list[dict[str, Any]],
    model: str,
    tracker: UsageTracker,
) -> list[str]:
    """Identify gaps in research and generate follow-up questions."""
    findings_summary = json.dumps(
        [{"question": r["question"], "findings_count": len(r["findings"])} for r in research_results],
        indent=2,
    )

    system = """You are a research quality analyst. Given a topic and initial research results, identify 2-3 follow-up questions that would fill gaps in the research.

Output ONLY a JSON array of strings. If the research is comprehensive, return an empty array []."""

    result = await call_llm(
        client, model, system,
        f"Topic: {topic}\n\nResearch so far:\n{findings_summary}",
        tracker, max_tokens=1024,
    )

    try:
        result = result.strip()
        if result.startswith("```"):
            result = result.split("\n", 1)[-1].rsplit("```", 1)[0]
        questions = json.loads(result)
        if isinstance(questions, list):
            return [str(q) for q in questions[:3]]
    except json.JSONDecodeError:
        pass
    return []


async def synthesize_report(
    client: AsyncAnthropic,
    topic: str,
    all_results: list[dict[str, Any]],
    model: str,
    tracker: UsageTracker,
) -> str:
    """Synthesize all research into a comprehensive report."""
    research_data = json.dumps(all_results, indent=2)

    system = """You are an expert research report writer. Given research findings from multiple sub-questions, synthesize them into a comprehensive, well-structured markdown report.

Report structure:
1. Title (# heading)
2. Executive Summary (2-3 sentences)
3. Key Findings sections (## headings, organized by theme, not by sub-question)
4. Analysis and Implications
5. Sources (numbered list of all URLs referenced)

Rules:
- Cite sources inline as [1], [2], etc.
- Resolve contradictions between sources (note when sources disagree)
- Include specific data, dates, and numbers
- Write 2000-4000 words
- Be objective and balanced
- Note source credibility where relevant"""

    return await call_llm(
        client, model, system,
        f"Topic: {topic}\n\nResearch Data:\n{research_data}",
        tracker, max_tokens=8192, temperature=0.4,
    )


# ---------------------------------------------------------------------------
# Main research pipeline
# ---------------------------------------------------------------------------


async def deep_research(topic: str) -> str:
    """Run the full deep research pipeline."""
    client = AsyncAnthropic()
    tracker = UsageTracker()
    reasoning_model = os.getenv("REASONING_MODEL", DEFAULT_REASONING_MODEL)
    extraction_model = os.getenv("EXTRACTION_MODEL", DEFAULT_EXTRACTION_MODEL)
    max_follow_ups = int(os.getenv("MAX_FOLLOW_UP_ROUNDS", str(MAX_FOLLOW_UP_ROUNDS)))

    start_time = time.time()

    # Phase 1: Plan
    log("📋", "Phase 1: Creating research plan...")
    sub_questions = await plan_research(client, topic, reasoning_model, tracker)
    for i, q in enumerate(sub_questions, 1):
        log("   ", f"{i}. {q}")
    print()

    # Phase 2: Research (parallel)
    log("🔬", "Phase 2: Researching sub-questions in parallel...")
    research_tasks = [
        research_sub_question(client, q, extraction_model, tracker)
        for q in sub_questions
    ]
    all_results = await asyncio.gather(*research_tasks)
    all_results = list(all_results)
    print()

    # Phase 3: Follow-up research
    for round_num in range(1, max_follow_ups + 1):
        log("🔄", f"Phase 3: Follow-up round {round_num}...")
        follow_ups = await identify_gaps(client, topic, all_results, reasoning_model, tracker)

        if not follow_ups:
            log("   ", "No gaps identified. Research is comprehensive.")
            break

        for q in follow_ups:
            log("   ", f"Follow-up: {q}")

        follow_up_tasks = [
            research_sub_question(client, q, extraction_model, tracker)
            for q in follow_ups
        ]
        follow_up_results = await asyncio.gather(*follow_up_tasks)
        all_results.extend(follow_up_results)
        print()

    # Phase 4: Synthesize
    log("📝", "Phase 4: Synthesizing report...")
    report = await synthesize_report(client, topic, all_results, reasoning_model, tracker)

    elapsed = time.time() - start_time
    total_sources = sum(len(r.get("sources", [])) for r in all_results)
    total_findings = sum(len(r.get("findings", [])) for r in all_results)

    print()
    log("📊", f"Research stats:")
    log("   ", f"Sub-questions: {len(sub_questions)} + {len(all_results) - len(sub_questions)} follow-ups")
    log("   ", f"Sources consulted: {total_sources}")
    log("   ", f"Findings extracted: {total_findings}")
    log("   ", f"Time: {elapsed:.1f}s")
    log("   ", tracker.summary().replace("\n", "\n   "))

    return report


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    validate_env()

    args = sys.argv[1:]
    output_file: str | None = None
    topic_parts: list[str] = []

    i = 0
    while i < len(args):
        if args[i] == "--output" and i + 1 < len(args):
            output_file = args[i + 1]
            i += 2
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py [TOPIC] [--output FILE]")
            print()
            print("Arguments:")
            print("  TOPIC          Research topic (prompts if not given)")
            print("  --output FILE  Save report to a file")
            print()
            print("Examples:")
            print('  python main.py "Impact of AI on drug discovery"')
            print('  python main.py "Future of quantum computing" --output report.md')
            sys.exit(0)
        else:
            topic_parts.append(args[i])
            i += 1

    topic = " ".join(topic_parts) if topic_parts else None
    if not topic:
        topic = input("🔬 What would you like to research in depth? ").strip()
    if not topic:
        print("❌ Please provide a research topic.")
        sys.exit(1)

    log("🚀", "Starting deep research agent...")
    log("📋", f"Topic: {topic}")
    print()

    try:
        report = await deep_research(topic)
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)

    print("\n" + "=" * 60)
    log("✅", "Research complete!\n")
    print(report)

    if output_file:
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(report)
        log("💾", f"Report saved to {output_file}")


if __name__ == "__main__":
    asyncio.run(main())
