"""
Paper Summarizer Agent -- Reads research papers via URLs and produces structured summaries.

This agent uses Reader (https://reader.dev) to convert web pages to clean markdown.
Web reading powered by Reader (https://reader.dev) -- get your API key at reader.dev
"""

import os
import sys
import asyncio
from typing import Any

import httpx
from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY", "READER_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Reader -- fetch web pages as clean markdown
# ---------------------------------------------------------------------------

READER_API_URL = "https://api.reader.dev/v1/read"
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 2.0


async def fetch_paper(url: str) -> str:
    """Fetch a paper URL via Reader and return its markdown content.

    Reader converts any web page into clean markdown, which is exactly
    what LLMs need for comprehension. No HTML parsing required.
    """

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            async with httpx.AsyncClient(follow_redirects=True) as client:
                response = await client.post(
                    READER_API_URL,
                    json={"url": url},
                    headers={"Authorization": f"Bearer {os.getenv('READER_API_KEY', '')}"},
                    timeout=60.0,
                )
                response.raise_for_status()
                data = response.json()
                content = data.get("data", {}).get("markdown", "")

                if not content.strip():
                    raise ValueError("Reader returned empty content")

                return content

        except (httpx.HTTPStatusError, httpx.TimeoutException, ValueError) as e:
            if attempt < MAX_RETRIES:
                log("⚠️", f"Attempt {attempt} failed for {url}: {e}")
                log("   ", f"Retrying in {RETRY_DELAY_SECONDS}s...")
                await asyncio.sleep(RETRY_DELAY_SECONDS)
            else:
                raise RuntimeError(
                    f"Failed to fetch {url} after {MAX_RETRIES} attempts: {e}"
                ) from e

    # Unreachable, but keeps the type checker happy
    raise RuntimeError(f"Failed to fetch {url}")


# ---------------------------------------------------------------------------
# Summarization via OpenAI
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert academic paper summarizer. Given the markdown content of a research paper or article, produce a structured summary.

Your summary MUST include these sections in this exact order:

## Title
The full title of the paper.

## Authors
List all authors. If not found in the content, write "Not available".

## Publication Info
Publication date, venue, or journal if mentioned. If not found, write "Not available".

## Research Question
The core problem or question the paper addresses (1-2 sentences).

## Methodology
What approach or methods the researchers used (1 short paragraph).

## Key Findings
3-5 bullet points summarizing the main results and contributions.

## Limitations
Any limitations the authors acknowledge or that are apparent (2-3 bullet points). If none mentioned, note that.

## Significance
Why this work matters -- its implications and potential impact (1-2 sentences).

## Related Work
Key prior work or references mentioned that provide context (2-3 bullet points). If not available, write "Not discussed in detail".

Rules:
- Be concise but precise. Prefer specifics over vague statements.
- Use the paper's own terminology.
- If the content is not a research paper (e.g., a blog post or article), adapt the sections accordingly but keep the same structure.
- Do NOT invent information. If something is not in the content, say so.
- Write in plain academic English. No hype words."""


async def summarize_content(
    content: str, url: str, client: AsyncOpenAI, model: str
) -> str:
    """Send paper content to OpenAI for structured summarization."""
    # Truncate very long content to stay within context limits.
    # gpt-4o-mini handles ~128k tokens, but we cap at ~80k chars
    # to leave room for the system prompt and response.
    max_chars = 80_000
    if len(content) > max_chars:
        content = content[:max_chars] + "\n\n[Content truncated due to length]"

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": (
                            f"Summarize this paper/article from {url}:\n\n"
                            f"{content}"
                        ),
                    },
                ],
                temperature=0.2,
            )

            result = response.choices[0].message.content
            if not result:
                raise ValueError("Model returned empty response")
            return result

        except Exception as e:
            if attempt < MAX_RETRIES:
                log("⚠️", f"Summarization attempt {attempt} failed: {e}")
                log("   ", f"Retrying in {RETRY_DELAY_SECONDS}s...")
                await asyncio.sleep(RETRY_DELAY_SECONDS)
            else:
                raise RuntimeError(
                    f"Failed to summarize after {MAX_RETRIES} attempts: {e}"
                ) from e

    raise RuntimeError("Failed to summarize")


# ---------------------------------------------------------------------------
# Paper processing pipeline
# ---------------------------------------------------------------------------


async def process_paper(
    url: str, index: int, total: int, client: AsyncOpenAI, model: str
) -> str:
    """Fetch and summarize a single paper."""
    label = f"[{index}/{total}]"

    log("📄", f"{label} Fetching: {url}")
    content = await fetch_paper(url)

    char_count = len(content)
    log("   ", f"{label} Got {char_count:,} chars of markdown")

    log("🤖", f"{label} Summarizing...")
    summary = await summarize_content(content, url, client, model)

    log("✅", f"{label} Done")
    return summary


async def process_all_papers(
    urls: list[str], client: AsyncOpenAI, model: str
) -> list[tuple[str, str, str | None]]:
    """Process all papers and return (url, summary, error) tuples."""
    results: list[tuple[str, str, str | None]] = []
    total = len(urls)

    for i, url in enumerate(urls, 1):
        try:
            summary = await process_paper(url, i, total, client, model)
            results.append((url, summary, None))
        except Exception as e:
            error_msg = str(e)
            log("❌", f"[{i}/{total}] Failed: {url} -- {error_msg}")
            results.append((url, "", error_msg))

    return results


def format_output(results: list[tuple[str, str, str | None]]) -> str:
    """Format all summaries into a single markdown document."""
    parts: list[str] = []

    if len(results) == 1:
        url, summary, error = results[0]
        if error:
            parts.append(f"# Error\n\nFailed to summarize {url}: {error}")
        else:
            parts.append(summary)
        parts.append(f"\n---\n*Source: {url}*")
    else:
        parts.append("# Paper Summaries\n")
        for i, (url, summary, error) in enumerate(results, 1):
            parts.append(f"---\n\n## Paper {i}\n**Source:** {url}\n")
            if error:
                parts.append(f"**Error:** {error}\n")
            else:
                parts.append(summary)
            parts.append("")

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def parse_args(argv: list[str]) -> tuple[list[str], str | None]:
    """Parse CLI arguments. Returns (urls, output_file)."""
    urls: list[str] = []
    output_file: str | None = None

    i = 0
    while i < len(argv):
        if argv[i] == "--output" and i + 1 < len(argv):
            output_file = argv[i + 1]
            i += 2
        else:
            urls.append(argv[i])
            i += 1

    return urls, output_file


def prompt_for_urls() -> list[str]:
    """Interactive mode: prompt the user for paper URLs."""
    print("📎 Enter paper URLs (one per line, empty line to finish):")
    urls: list[str] = []
    while True:
        try:
            line = input("   > ").strip()
        except EOFError:
            break
        if not line:
            break
        urls.append(line)
    return urls


async def main() -> None:
    """Main entry point for the paper summarizer agent."""
    validate_env()

    model = os.getenv("MODEL", "gpt-4o-mini")
    client = AsyncOpenAI()

    # Parse CLI args
    urls, output_file = parse_args(sys.argv[1:])

    # Interactive mode if no URLs given
    if not urls:
        urls = prompt_for_urls()

    if not urls:
        print("❌ No URLs provided.")
        sys.exit(1)

    log("🚀", "Starting paper summarizer...")
    log("📋", f"Papers to summarize: {len(urls)}")
    log("🤖", f"Model: {model}")
    print()

    results = await process_all_papers(urls, client, model)

    # Count successes and failures
    successes = sum(1 for _, _, err in results if err is None)
    failures = len(results) - successes

    output = format_output(results)

    print("\n" + "=" * 60)
    log("✅", f"Complete! {successes} summarized, {failures} failed.\n")
    print(output)

    if output_file:
        with open(output_file, "w") as f:
            f.write(output)
        log("💾", f"Saved to {output_file}")


if __name__ == "__main__":
    asyncio.run(main())
