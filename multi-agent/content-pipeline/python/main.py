"""
Content Pipeline -- Multi-agent content creation system with
Researcher, Writer, and Editor agents in a sequential pipeline with revision loops.

Uses Anthropic Claude for all agents and Tavily for web research.
"""

import os
import sys
import json
import asyncio
from typing import Any

import httpx
from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
MAX_REVISION_ROUNDS = 2
REQUEST_TIMEOUT = 20.0

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    required = ["ANTHROPIC_API_KEY", "TAVILY_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Web research
# ---------------------------------------------------------------------------


async def search_web(query: str, max_results: int = 5) -> list[dict[str, str]]:
    """Search the web using Tavily API."""
    api_key = os.getenv("TAVILY_API_KEY", "")
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.tavily.com/search",
                json={"api_key": api_key, "query": query, "max_results": max_results},
                timeout=REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            data = response.json()
        return [
            {"title": r.get("title", ""), "url": r.get("url", ""), "content": r.get("content", "")}
            for r in data.get("results", [])
        ]
    except Exception as e:
        log("⚠️", f"Search failed: {e}")
        return []


# ---------------------------------------------------------------------------
# Agent base
# ---------------------------------------------------------------------------


async def call_agent(
    client: AsyncAnthropic,
    model: str,
    system_prompt: str,
    user_message: str,
    max_tokens: int = 4096,
    temperature: float = 0.5,
) -> str:
    """Call an agent with a system prompt and user message."""
    response = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
        temperature=temperature,
    )
    return "".join(b.text for b in response.content if b.type == "text")


# ---------------------------------------------------------------------------
# Agent definitions
# ---------------------------------------------------------------------------

RESEARCHER_PROMPT = """You are a Research Specialist. Your job is to gather current, accurate information on a topic to support content creation.

Given a content brief, you must:
1. Identify 3-5 key aspects of the topic to research
2. Use the provided search results to extract relevant facts, statistics, quotes, and insights
3. Organize findings into a structured research brief

Output format:
## Research Brief

### Key Facts
- Bullet points of important facts with sources

### Statistics & Data
- Any relevant numbers, percentages, trends

### Expert Perspectives
- Notable quotes or viewpoints from the sources

### Current Context
- What's happening right now related to this topic

### Suggested Angles
- 2-3 angles the writer could take based on the research

Be factual. Cite sources. Do NOT make up statistics or quotes."""

WRITER_PROMPT = """You are a Professional Content Writer. You produce engaging, well-structured content tailored to a specific audience and format.

Given a content brief and research brief, you must:
1. Write content in the specified format and tone
2. Incorporate key facts and data from the research
3. Structure the content with clear headings and logical flow
4. Make it engaging and valuable for the target audience

Rules:
- Match the requested format (blog post, newsletter, tutorial, etc.)
- Match the requested tone (professional, casual, technical, etc.)
- Use research data to support claims (cite where natural)
- Include an introduction that hooks the reader
- Include a conclusion with a takeaway or call to action
- Write the requested length (default: 800-1200 words)
- Use subheadings to break up the content
- No fluff -- every paragraph should add value"""

EDITOR_PROMPT = """You are a Senior Content Editor. You review content for quality, accuracy, clarity, and engagement.

Given the original content brief, research brief, and a draft, you must:
1. Check facts against the research brief (flag any unsupported claims)
2. Evaluate structure, flow, and readability
3. Check tone matches the brief's target audience
4. Identify weak sections that need strengthening
5. Provide specific, actionable feedback

Output format:
## Editorial Review

### Overall Assessment
Score: X/10
One paragraph summary of the draft quality.

### Accuracy Check
- List any factual issues or unsupported claims

### Structural Feedback
- Issues with flow, organization, or missing sections

### Style & Tone
- Does it match the audience? Any tone inconsistencies?

### Specific Line Edits
- "Original text" -> "Suggested revision" (with reason)

### Verdict
Either "APPROVED" or "NEEDS REVISION" with a summary of required changes.

Be constructive but honest. If the draft is good, say so. If it needs work, be specific about what to fix."""


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


async def run_pipeline(
    topic: str, audience: str, format_type: str, tone: str
) -> dict[str, str]:
    """Run the full content pipeline and return all artifacts."""
    client = AsyncAnthropic()
    model = os.getenv("MODEL", DEFAULT_MODEL)
    max_rounds = int(os.getenv("MAX_REVISION_ROUNDS", str(MAX_REVISION_ROUNDS)))

    content_brief = f"""Topic: {topic}
Target Audience: {audience}
Format: {format_type}
Tone: {tone}
Length: 800-1200 words"""

    artifacts: dict[str, str] = {"content_brief": content_brief}

    # ---- Phase 1: Research ----
    log("🔬", "Phase 1: Researcher Agent gathering information...")
    search_queries = [topic, f"{topic} latest trends", f"{topic} statistics data"]
    all_results: list[dict[str, str]] = []
    for query in search_queries:
        results = await search_web(query, max_results=3)
        all_results.extend(results)
        log("   ", f"Searched: '{query}' -> {len(results)} results")

    search_data = "\n".join(
        f"- {r['title']}: {r['content'][:300]} ({r['url']})"
        for r in all_results
    )

    research_brief = await call_agent(
        client, model, RESEARCHER_PROMPT,
        f"Content Brief:\n{content_brief}\n\nSearch Results:\n{search_data}",
        max_tokens=3000, temperature=0.3,
    )
    artifacts["research_brief"] = research_brief
    log("✓", "Research brief complete")
    print()

    # ---- Phase 2: Write first draft ----
    log("✍️", "Phase 2: Writer Agent creating first draft...")
    draft = await call_agent(
        client, model, WRITER_PROMPT,
        f"Content Brief:\n{content_brief}\n\nResearch Brief:\n{research_brief}",
        max_tokens=4096, temperature=0.6,
    )
    artifacts["first_draft"] = draft
    log("✓", f"First draft complete ({len(draft.split())} words)")
    print()

    # ---- Phase 3: Edit and revise loop ----
    current_draft = draft
    for round_num in range(1, max_rounds + 1):
        log("📝", f"Phase 3: Editor Agent reviewing (round {round_num})...")
        review = await call_agent(
            client, model, EDITOR_PROMPT,
            f"Content Brief:\n{content_brief}\n\nResearch Brief:\n{research_brief}\n\nDraft:\n{current_draft}",
            max_tokens=3000, temperature=0.3,
        )
        artifacts[f"review_round_{round_num}"] = review

        if "APPROVED" in review.upper():
            log("✅", f"Editor approved the draft in round {round_num}!")
            break

        log("🔄", "Editor requested revisions. Writer revising...")
        revision_prompt = f"""Content Brief:\n{content_brief}

Research Brief:\n{research_brief}

Your Previous Draft:\n{current_draft}

Editor's Feedback:\n{review}

Please revise your draft based on the editor's feedback. Address every point raised. Keep the parts that were praised."""

        current_draft = await call_agent(
            client, model, WRITER_PROMPT,
            revision_prompt,
            max_tokens=4096, temperature=0.5,
        )
        artifacts[f"revision_{round_num}"] = current_draft
        log("✓", f"Revision {round_num} complete ({len(current_draft.split())} words)")
        print()

    artifacts["final_draft"] = current_draft
    return artifacts


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    validate_env()

    if "--help" in sys.argv or "-h" in sys.argv:
        print("Usage: python main.py [--topic TOPIC] [--audience AUDIENCE] [--format FORMAT] [--tone TONE] [--output FILE]")
        print()
        print("All arguments are optional. The agent will prompt for missing values.")
        print()
        print("Examples:")
        print('  python main.py --topic "AI in Healthcare" --audience "CTOs" --format "blog post" --tone "professional"')
        print("  python main.py  # Interactive mode")
        sys.exit(0)

    args = sys.argv[1:]
    topic = audience = format_type = tone = output_file = None

    i = 0
    while i < len(args):
        if args[i] == "--topic" and i + 1 < len(args):
            topic = args[i + 1]; i += 2
        elif args[i] == "--audience" and i + 1 < len(args):
            audience = args[i + 1]; i += 2
        elif args[i] == "--format" and i + 1 < len(args):
            format_type = args[i + 1]; i += 2
        elif args[i] == "--tone" and i + 1 < len(args):
            tone = args[i + 1]; i += 2
        elif args[i] == "--output" and i + 1 < len(args):
            output_file = args[i + 1]; i += 2
        else:
            i += 1

    # Prompt for missing values
    if not topic:
        topic = input("📝 Topic: ").strip()
    if not audience:
        audience = input("👥 Target audience: ").strip() or "general audience"
    if not format_type:
        format_type = input("📄 Format (blog post, newsletter, tutorial): ").strip() or "blog post"
    if not tone:
        tone = input("🎭 Tone (professional, casual, technical): ").strip() or "professional"

    if not topic:
        print("❌ Please provide a topic.")
        sys.exit(1)

    log("🚀", "Starting content pipeline...")
    log("📋", f"Topic: {topic}")
    log("👥", f"Audience: {audience}")
    log("📄", f"Format: {format_type}")
    log("🎭", f"Tone: {tone}")
    print()

    try:
        artifacts = await run_pipeline(topic, audience, format_type, tone)
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)

    print("\n" + "=" * 60)
    log("✅", "Content pipeline complete!\n")
    print(artifacts["final_draft"])

    if output_file:
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(artifacts["final_draft"])
        log("💾", f"Final draft saved to {output_file}")


if __name__ == "__main__":
    asyncio.run(main())
