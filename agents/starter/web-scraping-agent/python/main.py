"""
Web Scraping Agent -- Takes a URL and a description of what data to extract,
fetches the page, and returns structured JSON matching the user's intent.

Uses Anthropic Claude for intelligent HTML-to-JSON extraction.
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
MAX_HTML_LENGTH = 120_000  # ~120K chars to stay within context limits
MAX_RETRIES = 3
REQUEST_TIMEOUT = 30.0

# Realistic browser headers to avoid basic anti-scraping blocks
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
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
    print(f"{emoji} {message}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Page fetching
# ---------------------------------------------------------------------------


async def fetch_page(url: str) -> str:
    """Fetch a web page with browser-like headers. Returns raw HTML."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            async with httpx.AsyncClient(
                follow_redirects=True,
                headers=BROWSER_HEADERS,
                timeout=REQUEST_TIMEOUT,
            ) as client:
                response = await client.get(url)
                response.raise_for_status()
                html = response.text

                if len(html) > MAX_HTML_LENGTH:
                    log("⚠️", f"Page is large ({len(html):,} chars). Trimming to {MAX_HTML_LENGTH:,} chars.")
                    html = html[:MAX_HTML_LENGTH]

                return html

        except httpx.TimeoutException:
            if attempt < MAX_RETRIES:
                wait = 2 ** attempt
                log("⏳", f"Timeout (attempt {attempt}/{MAX_RETRIES}), retrying in {wait}s...")
                await asyncio.sleep(wait)
            else:
                print(f"❌ Request timed out after {MAX_RETRIES} attempts: {url}")
                print("   The site may be slow or blocking automated requests.")
                sys.exit(1)

        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            if status == 403:
                print(f"❌ Access denied (403 Forbidden): {url}")
                print("   The site is blocking automated requests.")
            elif status == 404:
                print(f"❌ Page not found (404): {url}")
            elif status >= 500 and attempt < MAX_RETRIES:
                wait = 2 ** attempt
                log("⏳", f"Server error {status} (attempt {attempt}/{MAX_RETRIES}), retrying in {wait}s...")
                await asyncio.sleep(wait)
                continue
            else:
                print(f"❌ HTTP error {status}: {url}")
            sys.exit(1)

        except httpx.RequestError as e:
            if attempt < MAX_RETRIES:
                wait = 2 ** attempt
                log("⏳", f"Network error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait}s...")
                await asyncio.sleep(wait)
            else:
                print(f"❌ Network error after {MAX_RETRIES} attempts: {e}")
                print("   Check your internet connection and the URL.")
                sys.exit(1)

    # Should not reach here, but just in case
    print("❌ Failed to fetch page after all retries.")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Extraction via Anthropic Claude
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a data extraction expert. Given raw HTML from a web page and a description of what data to extract, you produce clean, structured JSON.

Your process:
1. Analyze the HTML to understand the page structure
2. Identify the data matching the user's extraction goal
3. Design an appropriate JSON schema for the extracted data
4. Extract all matching data into that schema

Rules:
- Output ONLY valid JSON. No markdown, no explanation, no code fences.
- Use an array of objects when extracting multiple items (e.g., list of products).
- Use a single object when extracting one item (e.g., company info).
- Use descriptive, snake_case keys (e.g., "product_name", not "name" or "productName").
- Include ALL matching items found on the page. Do not truncate or sample.
- If a field is missing for an item, use null rather than omitting the key.
- Clean the data: strip extra whitespace, decode HTML entities, normalize URLs to absolute.
- For prices, keep the currency symbol and format as strings (e.g., "$29.99").
- For dates, use ISO 8601 format when possible (e.g., "2024-01-15").
- If no matching data is found, return an empty array [] or object {} with a "_note" field explaining why.
- Do NOT hallucinate data. Only extract what is actually present in the HTML.
- Do NOT include HTML tags in extracted values."""


async def extract_data(html: str, url: str, goal: str, model: str) -> str:
    """Send HTML and extraction goal to Claude, return JSON string."""
    client = AsyncAnthropic()

    user_message = f"""Extract data from this web page.

**URL:** {url}
**Extraction goal:** {goal}

**Raw HTML:**
{html}"""

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=8192,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
                temperature=0.0,  # Deterministic extraction
            )

            result = ""
            for block in response.content:
                if block.type == "text":
                    result += block.text

            # Strip any markdown code fences the model might add despite instructions
            result = result.strip()
            if result.startswith("```json"):
                result = result[7:]
            if result.startswith("```"):
                result = result[3:]
            if result.endswith("```"):
                result = result[:-3]
            result = result.strip()

            # Validate it's actual JSON
            try:
                parsed = json.loads(result)
                # Re-serialize with consistent formatting
                return json.dumps(parsed, indent=2, ensure_ascii=False)
            except json.JSONDecodeError:
                if attempt < MAX_RETRIES:
                    log("⚠️", f"Model returned invalid JSON (attempt {attempt}/{MAX_RETRIES}), retrying...")
                    continue
                else:
                    log("⚠️", "Model returned invalid JSON after all attempts. Returning raw output.")
                    return result

        except Exception as e:
            error_str = str(e).lower()
            is_transient = "rate" in error_str or "overloaded" in error_str or "529" in str(e) or "500" in str(e)

            if attempt < MAX_RETRIES and is_transient:
                wait = 2 ** attempt
                log("⏳", f"API error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait}s...")
                await asyncio.sleep(wait)
            else:
                raise

    # Should not reach here
    raise RuntimeError("Max retries exceeded")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the web scraping agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    # Parse arguments
    url: str | None = None
    goal: str | None = None
    output_file: str | None = None

    positional: list[str] = []
    i = 0
    while i < len(args):
        if args[i] == "--output" and i + 1 < len(args):
            output_file = args[i + 1]
            i += 2
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py <URL> <EXTRACTION_GOAL> [OPTIONS]")
            print()
            print("Arguments:")
            print("  URL              The web page URL to scrape")
            print("  EXTRACTION_GOAL  What data to extract (in plain English)")
            print()
            print("Options:")
            print("  --output FILE    Save extracted JSON to a file")
            print()
            print("Examples:")
            print('  python main.py "https://news.ycombinator.com" "Extract all story titles, links, and points"')
            print('  python main.py "https://example.com/products" "Extract product names and prices" --output products.json')
            sys.exit(0)
        else:
            positional.append(args[i])
            i += 1

    if len(positional) >= 2:
        url = positional[0]
        goal = " ".join(positional[1:])
    elif len(positional) == 1:
        url = positional[0]

    # Interactive prompts for missing inputs
    if not url:
        url = input("🌐 URL to scrape: ").strip()
    if not url:
        print("❌ Please provide a URL.")
        sys.exit(1)

    if not goal:
        goal = input("🎯 What data do you want to extract? ").strip()
    if not goal:
        print("❌ Please describe what data to extract.")
        sys.exit(1)

    # Validate URL format
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    log("🚀", "Starting web scraping agent...")
    log("🤖", f"Model: {model}")
    log("🌐", f"URL: {url}")
    log("🎯", f"Goal: {goal}")
    print(file=sys.stderr)

    # Step 1: Fetch the page
    log("📥", "Fetching page...")
    html = await fetch_page(url)
    log("✓", f"Fetched {len(html):,} chars of HTML")

    # Step 2: Extract data
    log("🔍", "Extracting data...")
    try:
        result_json = await extract_data(html, url, goal, model)
    except KeyboardInterrupt:
        print("\n❌ Cancelled.", file=sys.stderr)
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error during extraction: {e}", file=sys.stderr)
        print("   Check your ANTHROPIC_API_KEY and network connection.", file=sys.stderr)
        sys.exit(1)

    log("✅", "Extraction complete!")
    print(file=sys.stderr)

    # Output JSON to stdout (logs go to stderr so JSON can be piped)
    print(result_json)

    if output_file:
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(result_json + "\n")
        log("💾", f"Saved to {output_file}")


if __name__ == "__main__":
    asyncio.run(main())
