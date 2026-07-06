"""
Newsletter Curator -- Reads multiple URLs, extracts key content, and generates a curated digest.

Uses Reader (https://reader.dev) to fetch clean, readable content from any URL,
then OpenAI to analyze and curate the best items into a newsletter.
"""

import os
import sys
import json
import asyncio
import argparse
from typing import Any

import httpx
from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Phase 1: Fetch URLs via Reader
# ---------------------------------------------------------------------------

READER_BASE = "https://r.reader.dev/"


async def fetch_url(client: httpx.AsyncClient, url: str) -> dict[str, Any]:
    """Fetch a single URL through Reader and return the result.

    Reader converts any web page into clean, LLM-friendly markdown.
    No API key required -- the free tier works for all public URLs.
    """
    reader_url = f"{READER_BASE}{url}"
    try:
        response = await client.get(
            reader_url,
            headers={"Accept": "text/plain"},
            timeout=30.0,
        )
        response.raise_for_status()
        content = response.text

        # Reader returns markdown with a Title: header on the first line
        title = ""
        lines = content.split("\n")
        for line in lines:
            if line.startswith("Title:"):
                title = line[len("Title:"):].strip()
                break

        return {
            "url": url,
            "title": title or url,
            "content": content[:8000],  # Trim to keep within context limits
            "status": "ok",
        }
    except httpx.HTTPStatusError as e:
        log("⚠️", f"HTTP error fetching {url}: {e.response.status_code}")
        return {"url": url, "title": url, "content": "", "status": "error"}
    except Exception as e:
        log("⚠️", f"Failed to fetch {url}: {e}")
        return {"url": url, "title": url, "content": "", "status": "error"}


async def fetch_all_urls(urls: list[str]) -> list[dict[str, Any]]:
    """Fetch all URLs in parallel using Reader.

    Uses asyncio.gather to read all pages concurrently. Reader handles
    JavaScript rendering, cookie banners, and paywall bypassing so the
    content comes back as clean markdown every time.
    """
    log("📡", f"Fetching {len(urls)} URLs via Reader...")

    async with httpx.AsyncClient(follow_redirects=True) as client:
        tasks = [fetch_url(client, url) for url in urls]
        results = await asyncio.gather(*tasks)

    successful = [r for r in results if r["status"] == "ok"]
    failed = [r for r in results if r["status"] == "error"]

    log("✅", f"Successfully fetched {len(successful)} pages")
    if failed:
        log("⚠️", f"Failed to fetch {len(failed)} pages: {', '.join(r['url'] for r in failed)}")

    return list(results)


# ---------------------------------------------------------------------------
# Phase 2: Extract key points from each article
# ---------------------------------------------------------------------------

EXTRACTION_PROMPT = """You are a content analyst. Given an article's content, extract structured information.

Return a JSON object with these fields:
- "title": The article title (use the provided one or extract a better one)
- "key_points": Array of 3-5 key takeaways from the article
- "summary": A 2-3 sentence summary of the article
- "relevance_score": A score from 1-10 indicating how interesting/valuable this content is for a newsletter audience
- "relevance_reason": One sentence explaining why this scored high or low
- "category": One of: "tech", "business", "science", "culture", "opinion", "tutorial", "news", "other"

Focus on what makes this article unique or noteworthy. Prioritize actionable insights
and surprising findings over general information.

If a topic filter is provided, score relevance higher for articles that match the topic."""


async def extract_article_info(
    client: AsyncOpenAI,
    model: str,
    article: dict[str, Any],
    topic: str | None = None,
) -> dict[str, Any]:
    """Use OpenAI to extract structured info from a single article."""
    if article["status"] == "error":
        return {
            **article,
            "key_points": [],
            "summary": "Failed to fetch this article.",
            "relevance_score": 0,
            "relevance_reason": "Could not retrieve content.",
            "category": "other",
        }

    user_content = f"Article title: {article['title']}\n\nArticle content:\n{article['content']}"
    if topic:
        user_content += f"\n\nNewsletter topic filter: {topic}"

    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": EXTRACTION_PROMPT},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            temperature=0.3,
        )

        result = json.loads(response.choices[0].message.content or "{}")
        result["url"] = article["url"]
        result["status"] = "ok"
        return result

    except Exception as e:
        log("⚠️", f"Extraction failed for {article['url']}: {e}")
        return {
            **article,
            "key_points": [],
            "summary": "Failed to analyze this article.",
            "relevance_score": 0,
            "relevance_reason": "Analysis error.",
            "category": "other",
        }


async def extract_all(
    openai_client: AsyncOpenAI,
    model: str,
    articles: list[dict[str, Any]],
    topic: str | None = None,
) -> list[dict[str, Any]]:
    """Extract information from all articles in parallel."""
    log("🔍", "Analyzing articles with AI...")

    tasks = [
        extract_article_info(openai_client, model, article, topic)
        for article in articles
    ]
    results = await asyncio.gather(*tasks)

    # Sort by relevance score, highest first
    results.sort(key=lambda x: x.get("relevance_score", 0), reverse=True)

    for r in results:
        score = r.get("relevance_score", 0)
        title = r.get("title", r.get("url", "Unknown"))[:60]
        log("   ", f"[{score}/10] {title}")

    return list(results)


# ---------------------------------------------------------------------------
# Phase 3: Curate the newsletter
# ---------------------------------------------------------------------------

CURATION_PROMPT = """You are a professional newsletter curator. Given a set of analyzed articles
(already ranked by relevance), produce a polished newsletter digest.

Select the best 5-7 items from the provided articles. Skip any with a relevance score below 3.

Your output should be a complete newsletter in markdown format with:

1. **Subject line** -- a catchy, specific subject line (not generic clickbait)
2. **Intro paragraph** -- 2-3 sentences setting the theme and tone
3. **Items** -- for each selected article:
   - Title (as a heading)
   - 2-3 sentence summary of what it covers and why it matters
   - A "Why it matters" line with broader context or implications
   - Source link
4. **Closing** -- a brief sign-off with a call to action (share, reply, subscribe, etc.)

Style guidelines:
- Write in a conversational but professional tone
- Each item summary should tell the reader WHY they should care
- Vary your sentence structure -- do not start every item the same way
- Use specific details and numbers when available
- Keep the total newsletter under 1000 words
- Do not use em dashes -- use double hyphens instead if you need a pause

If a topic is specified, frame the newsletter around that theme."""


async def curate_newsletter(
    client: AsyncOpenAI,
    model: str,
    articles: list[dict[str, Any]],
    topic: str | None = None,
) -> str:
    """Generate the final curated newsletter from analyzed articles."""
    log("📝", "Curating newsletter digest...")

    # Build the article summaries for the curation prompt
    article_data = []
    for i, article in enumerate(articles, 1):
        if article.get("relevance_score", 0) < 1:
            continue
        article_data.append({
            "rank": i,
            "title": article.get("title", "Untitled"),
            "url": article.get("url", ""),
            "summary": article.get("summary", ""),
            "key_points": article.get("key_points", []),
            "relevance_score": article.get("relevance_score", 0),
            "relevance_reason": article.get("relevance_reason", ""),
            "category": article.get("category", "other"),
        })

    user_content = f"Here are the analyzed articles, ranked by relevance:\n\n{json.dumps(article_data, indent=2)}"
    if topic:
        user_content += f"\n\nNewsletter topic/theme: {topic}"

    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": CURATION_PROMPT},
            {"role": "user", "content": user_content},
        ],
        temperature=0.7,
    )

    return response.choices[0].message.content or ""


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Newsletter Curator -- reads URLs and generates a curated digest.",
        usage="python main.py [URLs...] [--urls FILE] [--topic TOPIC] [--output FILE]",
    )
    parser.add_argument(
        "urls",
        nargs="*",
        help="URLs to include in the newsletter",
    )
    parser.add_argument(
        "--urls",
        dest="urls_file",
        help="Path to a file containing URLs, one per line",
    )
    parser.add_argument(
        "--topic",
        help="Newsletter theme or topic to focus on",
    )
    parser.add_argument(
        "--output",
        help="Save the newsletter to a file",
    )
    return parser.parse_args()


def load_urls(args: argparse.Namespace) -> list[str]:
    """Load URLs from CLI arguments and/or a file."""
    urls: list[str] = []

    # URLs from positional arguments
    if args.urls:
        urls.extend(args.urls)

    # URLs from file
    if args.urls_file:
        try:
            with open(args.urls_file, "r") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        urls.append(line)
        except FileNotFoundError:
            print(f"❌ URLs file not found: {args.urls_file}")
            sys.exit(1)

    # Deduplicate while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for url in urls:
        if url not in seen:
            seen.add(url)
            unique.append(url)

    return unique


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the newsletter curator."""
    validate_env()

    args = parse_args()
    model = os.getenv("MODEL", "gpt-4o-mini")
    urls = load_urls(args)

    if not urls:
        print("❌ No URLs provided.")
        print("   Usage: python main.py URL1 URL2 URL3")
        print("   Or:    python main.py --urls urls.txt")
        sys.exit(1)

    log("🚀", "Starting Newsletter Curator...")
    log("📋", f"Processing {len(urls)} URLs")
    if args.topic:
        log("🏷️", f"Topic: {args.topic}")
    log("🤖", f"Model: {model}")
    print()

    try:
        # Phase 1: Fetch all URLs via Reader
        articles = await fetch_all_urls(urls)
        print()

        # Phase 2: Extract and rank content
        openai_client = AsyncOpenAI()
        analyzed = await extract_all(openai_client, model, articles, args.topic)
        print()

        # Phase 3: Curate the newsletter
        newsletter = await curate_newsletter(openai_client, model, analyzed, args.topic)

    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)

    # Output
    print("\n" + "=" * 60)
    log("✅", "Newsletter ready!\n")
    print(newsletter)

    if args.output:
        with open(args.output, "w") as f:
            f.write(newsletter)
        log("💾", f"Saved to {args.output}")


if __name__ == "__main__":
    asyncio.run(main())
