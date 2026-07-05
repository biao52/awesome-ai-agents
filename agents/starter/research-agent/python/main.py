"""
Research Agent — Takes a topic, searches the web, and produces a structured report.

Uses OpenAI for reasoning and Tavily for web search.
"""

import os
import sys
import json
import asyncio
from typing import Any

import httpx
from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY", "TAVILY_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Tools — web search and page reading
# ---------------------------------------------------------------------------

TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")


async def search_web(query: str, max_results: int = 5) -> list[dict[str, str]]:
    """Search the web using the Tavily API and return a list of results."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.tavily.com/search",
            json={
                "api_key": TAVILY_API_KEY,
                "query": query,
                "max_results": max_results,
                "include_raw_content": False,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()

    results = []
    for item in data.get("results", []):
        results.append(
            {
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "content": item.get("content", ""),
            }
        )
    return results


async def read_page(url: str) -> str:
    """Fetch a web page and return its text content (truncated to ~6000 chars)."""
    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            response = await client.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; ResearchAgent/1.0)"},
                timeout=15.0,
            )
            response.raise_for_status()
            text = response.text[:6000]
            return text
    except Exception as e:
        return f"Error reading page: {e}"


# ---------------------------------------------------------------------------
# Tool definitions for OpenAI function calling
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": "Search the web for information on a query. Returns titles, URLs, and snippets.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query.",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results to return (default 5).",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_page",
            "description": "Fetch and read the content of a web page given its URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to read.",
                    },
                },
                "required": ["url"],
            },
        },
    },
]

TOOL_MAP = {
    "search_web": search_web,
    "read_page": read_page,
}


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a research agent. Given a topic, you:

1. Create a research plan with 3-5 sub-questions that will help you thoroughly understand the topic.
2. For each sub-question, search the web and read the most relevant pages.
3. Synthesize all findings into a structured markdown report.

Your final output MUST be a well-structured markdown report with:
- A title (# heading)
- An executive summary (2-3 sentences)
- Sections for each major finding (## headings)
- Key facts, data, and quotes where relevant
- A Sources section at the end listing all URLs you referenced

Be thorough but concise. Cite your sources inline like [1], [2], etc.

When you start, first announce your research plan, then execute it step by step.
Use the search_web tool to find information and read_page to get more detail from specific URLs."""


async def run_agent(topic: str, model: str) -> str:
    """Run the research agent on a topic and return the final report."""
    client = AsyncOpenAI()

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Research this topic and produce a comprehensive report: {topic}"},
    ]

    log("🔍", "Creating research plan...")

    # Agent loop — keep going until the model stops calling tools
    while True:
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            tools=TOOLS,
            temperature=0.3,
        )

        choice = response.choices[0]
        message = choice.message

        # Add assistant message to history
        messages.append(message.model_dump())

        # If no tool calls, the agent is done
        if not message.tool_calls:
            return message.content or ""

        # Process each tool call
        for tool_call in message.tool_calls:
            fn_name = tool_call.function.name
            fn_args = json.loads(tool_call.function.arguments)

            if fn_name == "search_web":
                query = fn_args.get("query", "")
                max_results = fn_args.get("max_results", 5)
                log("🌐", f"Searching: {query}")
                result = await search_web(query, max_results)
                result_str = json.dumps(result, indent=2)
                log("   ", f"Found {len(result)} results")
            elif fn_name == "read_page":
                url = fn_args.get("url", "")
                domain = url.split("/")[2] if len(url.split("/")) > 2 else url
                log("📄", f"Reading: {domain}")
                result_str = await read_page(url)
            else:
                result_str = f"Unknown tool: {fn_name}"

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result_str,
                }
            )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

async def main() -> None:
    """Main entry point for the research agent."""
    validate_env()

    model = os.getenv("MODEL", "gpt-4o-mini")

    # Get topic from CLI args or prompt
    if len(sys.argv) > 1:
        # Check for --output flag
        args = sys.argv[1:]
        output_file = None
        topic_parts = []

        i = 0
        while i < len(args):
            if args[i] == "--output" and i + 1 < len(args):
                output_file = args[i + 1]
                i += 2
            else:
                topic_parts.append(args[i])
                i += 1

        topic = " ".join(topic_parts)
    else:
        topic = input("🔬 What would you like to research? ")
        output_file = None

    if not topic.strip():
        print("❌ Please provide a research topic.")
        sys.exit(1)

    log("🚀", "Starting research agent...")
    log("📋", f"Research topic: {topic}")
    log("🤖", f"Model: {model}")
    print()

    try:
        report = await run_agent(topic, model)
    except Exception as e:
        print(f"\n❌ Error during research: {e}")
        sys.exit(1)

    print("\n" + "=" * 60)
    log("✅", "Research complete! Report:\n")
    print(report)

    if output_file:
        with open(output_file, "w") as f:
            f.write(report)
        log("💾", f"Report saved to {output_file}")


if __name__ == "__main__":
    asyncio.run(main())
