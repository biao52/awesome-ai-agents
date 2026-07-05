"""
Content Repurposer -- Takes a blog post URL, reads it with Reader, and uses
Claude to repurpose it into multiple content formats (Twitter thread, LinkedIn
post, email newsletter, key takeaways).

# This agent uses Reader (https://reader.dev) to convert web pages to clean markdown.
# The free endpoint at r.reader.dev requires no API key or signup.
"""

import os
import sys
import asyncio
import argparse
from typing import Any

import httpx
from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Supported output formats
# ---------------------------------------------------------------------------

ALL_FORMATS = ["twitter", "linkedin", "email", "takeaways"]

FORMAT_DESCRIPTIONS: dict[str, str] = {
    "twitter": "Twitter/X thread (5-10 tweets)",
    "linkedin": "LinkedIn post (professional tone, 200-300 words)",
    "email": "Email newsletter excerpt with subject line",
    "takeaways": "Key takeaways as a bullet list",
}


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["ANTHROPIC_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"Error: Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Reader -- fetch article as markdown
# ---------------------------------------------------------------------------

READER_BASE_URL = "https://r.reader.dev/"


async def fetch_article(url: str) -> str:
    """Fetch a web page as clean markdown using Reader.

    Reader (reader.dev) converts any web page into clean, readable markdown.
    The r.reader.dev endpoint is free and requires no API key.
    """
    reader_url = f"{READER_BASE_URL}{url}"
    log("📖", f"Fetching article via Reader: {url}")

    async with httpx.AsyncClient(follow_redirects=True) as client:
        response = await client.get(
            reader_url,
            headers={
                "Accept": "text/markdown",
                "User-Agent": "ContentRepurposer/1.0",
            },
            timeout=30.0,
        )
        response.raise_for_status()
        markdown = response.text

    if not markdown.strip():
        raise ValueError("Reader returned empty content. Check that the URL points to a readable article.")

    # Truncate very long articles to avoid exceeding context limits
    max_chars = 50_000
    if len(markdown) > max_chars:
        markdown = markdown[:max_chars] + "\n\n[Content truncated for length]"
        log("✂️", f"Article truncated to {max_chars} characters")

    word_count = len(markdown.split())
    log("✅", f"Article fetched: ~{word_count} words")
    return markdown


# ---------------------------------------------------------------------------
# Repurposing prompt
# ---------------------------------------------------------------------------

def build_system_prompt(formats: list[str]) -> str:
    """Build the system prompt for Claude based on requested formats."""
    format_instructions: list[str] = []

    if "twitter" in formats:
        format_instructions.append("""## TWITTER THREAD
Create a Twitter/X thread of 5-10 tweets that captures the key ideas of the article.
- Each tweet must be under 280 characters
- Start with a hook tweet that grabs attention
- Number each tweet (1/, 2/, etc.)
- End with a call-to-action tweet linking back to the original
- Use line breaks between tweets for readability
- Include relevant hashtags on the last tweet only""")

    if "linkedin" in formats:
        format_instructions.append("""## LINKEDIN POST
Write a LinkedIn post (200-300 words) that shares the article's insights professionally.
- Open with a bold statement or question
- Use short paragraphs (1-2 sentences each)
- Include 2-3 key insights from the article
- End with a question to drive engagement
- Add 3-5 relevant hashtags at the bottom
- Tone: professional but conversational, not corporate""")

    if "email" in formats:
        format_instructions.append("""## EMAIL NEWSLETTER
Create an email newsletter excerpt with:
- **Subject line:** A compelling subject line (under 60 characters)
- **Preview text:** One sentence that appears in email preview (under 100 characters)
- **Body:** 150-250 word summary that makes readers want to click through
- Include a clear call-to-action linking to the original article
- Tone: friendly, informative, like writing to a smart friend""")

    if "takeaways" in formats:
        format_instructions.append("""## KEY TAKEAWAYS
Extract 5-8 key takeaways from the article as a bullet list.
- Each takeaway should be a complete, standalone insight (1-2 sentences)
- Order from most important to least important
- Focus on actionable insights, not just facts
- Prefix each with a relevant emoji""")

    sections = "\n\n".join(format_instructions)

    return f"""You are a content repurposing expert. Given a blog post or article in markdown format,
you transform it into multiple content formats while preserving the core message and key insights.

Your output must include the following sections, each clearly separated with a markdown heading:

{sections}

Important guidelines:
- Preserve the author's voice and key arguments
- Do not invent facts or statistics not present in the original
- Adapt tone for each platform (casual for Twitter, professional for LinkedIn, etc.)
- Each format should work as standalone content
- Use clear markdown formatting with headings to separate each section"""


# ---------------------------------------------------------------------------
# Claude -- repurpose content
# ---------------------------------------------------------------------------

async def repurpose_content(
    article_markdown: str,
    source_url: str,
    formats: list[str],
    model: str,
) -> str:
    """Send article markdown to Claude and get back repurposed content."""
    client = AsyncAnthropic()

    system_prompt = build_system_prompt(formats)

    user_message = f"""Here is the article to repurpose. The original URL is: {source_url}

---

{article_markdown}

---

Please repurpose this article into the requested formats. Make sure each section is clearly
labeled with a markdown heading so they can be easily separated."""

    log("🤖", f"Sending to Claude ({model}) for repurposing...")
    log("📝", f"Requested formats: {', '.join(formats)}")

    response = await client.messages.create(
        model=model,
        max_tokens=4096,
        system=system_prompt,
        messages=[
            {"role": "user", "content": user_message},
        ],
        temperature=0.7,
    )

    # Extract text from response
    result_text = ""
    for block in response.content:
        if block.type == "text":
            result_text += block.text

    if not result_text.strip():
        raise ValueError("Claude returned empty content.")

    tokens_in = response.usage.input_tokens
    tokens_out = response.usage.output_tokens
    log("📊", f"Tokens used: {tokens_in} in / {tokens_out} out")

    return result_text


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def save_output(content: str, output_path: str) -> None:
    """Save repurposed content to a file."""
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(content)
    log("💾", f"Output saved to {output_path}")


def print_divider() -> None:
    """Print a visual divider."""
    print("\n" + "=" * 60 + "\n")


# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Content Repurposer -- Turn any blog post into multiple content formats.",
        epilog="Example: python main.py 'https://example.com/blog-post' --format twitter,linkedin",
    )
    parser.add_argument(
        "url",
        nargs="?",
        help="URL of the blog post or article to repurpose",
    )
    parser.add_argument(
        "--format",
        type=str,
        default=None,
        help=f"Comma-separated list of formats to generate. Options: {', '.join(ALL_FORMATS)}. Default: all",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Path to save the output (e.g., output.md)",
    )
    return parser.parse_args()


def parse_formats(format_str: str | None) -> list[str]:
    """Parse and validate the --format flag."""
    if format_str is None:
        return list(ALL_FORMATS)

    requested = [f.strip().lower() for f in format_str.split(",")]
    invalid = [f for f in requested if f not in ALL_FORMATS]
    if invalid:
        print(f"Error: Unknown format(s): {', '.join(invalid)}")
        print(f"   Valid formats: {', '.join(ALL_FORMATS)}")
        sys.exit(1)

    return requested


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> None:
    """Main entry point for the content repurposer agent."""
    validate_env()

    args = parse_args()
    model = os.getenv("MODEL", "claude-sonnet-4-20250514")

    # Get URL from args or prompt
    url = args.url
    if not url:
        url = input("🔗 Enter the URL of the article to repurpose: ").strip()

    if not url:
        print("Error: Please provide a URL.")
        sys.exit(1)

    # Validate URL format (basic check)
    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url

    formats = parse_formats(args.format)

    log("🚀", "Starting content repurposer...")
    log("🔗", f"Source URL: {url}")
    log("🤖", f"Model: {model}")
    log("📋", f"Formats: {', '.join(FORMAT_DESCRIPTIONS[f] for f in formats)}")
    print()

    # Step 1: Fetch article via Reader
    try:
        article_markdown = await fetch_article(url)
    except httpx.HTTPStatusError as e:
        print(f"\nError: Failed to fetch article (HTTP {e.response.status_code})")
        print("   Check that the URL is accessible and points to a readable page.")
        sys.exit(1)
    except Exception as e:
        print(f"\nError: Failed to fetch article: {e}")
        sys.exit(1)

    # Step 2: Repurpose with Claude
    try:
        repurposed = await repurpose_content(article_markdown, url, formats, model)
    except Exception as e:
        print(f"\nError: Failed to repurpose content: {e}")
        sys.exit(1)

    # Step 3: Output results
    print_divider()
    log("✅", "Content repurposed successfully!\n")
    print(repurposed)

    if args.output:
        print_divider()
        save_output(repurposed, args.output)

    print_divider()
    log("🎯", f"Source: {url}")
    log("📄", f"Generated {len(formats)} format(s): {', '.join(formats)}")


if __name__ == "__main__":
    asyncio.run(main())
