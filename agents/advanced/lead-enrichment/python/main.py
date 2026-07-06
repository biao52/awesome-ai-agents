"""
Lead Enrichment Agent -- Takes one or more company website URLs, reads multiple
pages per company via Reader, and uses Claude to extract structured company
intelligence including products, pricing, team, tech stack, and contact info.

# This agent uses Reader (https://reader.dev) to convert web pages to clean markdown.
# Web reading powered by Reader (https://reader.dev) -- get your API key at reader.dev
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
READER_API_URL = "https://api.reader.dev/v1/read"
MAX_CONTENT_LENGTH = 40_000  # Per page, to stay within context limits
REQUEST_TIMEOUT = 30.0
MAX_RETRIES = 3

# Paths to try for each company. Order matters: earlier pages are higher priority.
COMPANY_PATHS = [
    "/",
    "/about",
    "/about-us",
    "/pricing",
    "/team",
    "/careers",
    "/jobs",
    "/contact",
    "/products",
    "/services",
]

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["ANTHROPIC_API_KEY", "READER_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}", file=sys.stderr)
        print("   Copy .env.example to .env and fill in your API keys.", file=sys.stderr)
        print("   Get your Anthropic key at: https://console.anthropic.com/settings/keys", file=sys.stderr)
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix to stderr."""
    print(f"{emoji} {message}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Reader -- fetch pages as markdown
# ---------------------------------------------------------------------------


async def read_page(client: httpx.AsyncClient, url: str) -> str | None:
    """Fetch a single page as clean markdown using Reader.

    Reader (reader.dev) converts any web page into clean, readable markdown.
    Uses the Reader API at api.reader.dev/v1/read.

    Returns None if the page cannot be fetched (404, timeout, etc.).
    """

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.post(
                READER_API_URL,
                json={"url": url},
                headers={"Authorization": f"Bearer {os.getenv('READER_API_KEY', '')}"},
                timeout=REQUEST_TIMEOUT,
            )

            # Gracefully handle pages that don't exist
            if response.status_code in (404, 403, 410):
                return None

            if response.status_code >= 500 and attempt < MAX_RETRIES:
                await asyncio.sleep(2 ** attempt)
                continue

            response.raise_for_status()
            data = response.json()
            content = data.get("data", {}).get("markdown", "").strip()

            if not content:
                return None

            # Truncate very long pages
            if len(content) > MAX_CONTENT_LENGTH:
                content = content[:MAX_CONTENT_LENGTH] + "\n\n[Content truncated]"

            return content

        except httpx.TimeoutException:
            if attempt < MAX_RETRIES:
                await asyncio.sleep(2 ** attempt)
                continue
            return None

        except httpx.RequestError:
            if attempt < MAX_RETRIES:
                await asyncio.sleep(2 ** attempt)
                continue
            return None

        except httpx.HTTPStatusError:
            return None

    return None


def normalize_base_url(url: str) -> str:
    """Normalize a company URL to its base domain."""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    # Strip trailing slashes and paths to get base domain
    from urllib.parse import urlparse
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


async def read_company_pages(base_url: str) -> dict[str, str]:
    """Read multiple pages for a single company in parallel.

    Tries common paths (homepage, about, pricing, etc.) and returns a dict
    mapping path names to their markdown content. Pages that return 404 or
    fail to load are silently skipped.
    """
    pages_found: dict[str, str] = {}

    async with httpx.AsyncClient(follow_redirects=True) as client:
        # Build full URLs for each path
        urls = [f"{base_url.rstrip('/')}{path}" for path in COMPANY_PATHS]

        # Fetch all pages in parallel
        tasks = [read_page(client, url) for url in urls]
        results = await asyncio.gather(*tasks)

        for path, content in zip(COMPANY_PATHS, results):
            if content is not None:
                pages_found[path] = content
                log("  ", f"  Read {base_url}{path} ({len(content):,} chars)")

    return pages_found


# ---------------------------------------------------------------------------
# Claude -- extract structured company data
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a lead enrichment expert. Given markdown content scraped from multiple pages of a company's website, you extract comprehensive, structured data about the company.

Your output must be a single JSON object with these fields:

{
  "company_name": "string",
  "description": "string (2-3 sentence summary of what the company does)",
  "industry": "string (e.g., 'Developer Tools', 'FinTech', 'Healthcare')",
  "products_and_services": [
    {
      "name": "string",
      "description": "string (1 sentence)",
      "category": "string (e.g., 'SaaS', 'API', 'Platform', 'Consulting')"
    }
  ],
  "pricing": {
    "model": "string (e.g., 'freemium', 'subscription', 'usage-based', 'enterprise', 'unknown')",
    "tiers": [
      {
        "name": "string",
        "price": "string (e.g., '$29/mo', 'Custom', 'Free')",
        "highlights": ["string"]
      }
    ]
  },
  "team_indicators": {
    "team_size_estimate": "string (e.g., '10-50', '50-200', 'unknown')",
    "key_people": [
      {
        "name": "string",
        "role": "string"
      }
    ],
    "hiring": "boolean (true if actively hiring)"
  },
  "technology_stack": ["string (technologies mentioned on site, job postings, etc.)"],
  "contact": {
    "email": "string or null",
    "phone": "string or null",
    "address": "string or null",
    "demo_url": "string or null (link to schedule a demo or sales call)"
  },
  "social_media": {
    "twitter": "string or null",
    "linkedin": "string or null",
    "github": "string or null",
    "youtube": "string or null",
    "other": ["string"]
  },
  "funding_indicators": {
    "stage": "string (e.g., 'Seed', 'Series A', 'Public', 'Bootstrapped', 'unknown')",
    "investors": ["string"],
    "signals": ["string (any mentions of funding, revenue, growth)"]
  },
  "website": "string (the company URL)"
}

Rules:
- Output ONLY valid JSON. No markdown, no explanation, no code fences.
- Use null for fields where no data is available. Do not guess or hallucinate.
- For arrays, use an empty array [] when no items are found.
- Extract only what is actually present in the page content.
- If a pricing page was not available, set pricing.model to "unknown" and tiers to [].
- Technology stack should include languages, frameworks, cloud providers, and tools mentioned.
- For team_size_estimate, infer from team pages, about pages, or job posting volume.
- Social media links should be full URLs when found, null otherwise."""


async def extract_company_data(
    pages: dict[str, str],
    base_url: str,
    model: str,
) -> dict[str, Any]:
    """Send all page content to Claude and extract structured company data."""
    client = AsyncAnthropic()

    # Build a combined document from all pages
    combined = f"Company website: {base_url}\n\n"
    for path, content in pages.items():
        combined += f"=== PAGE: {path} ===\n{content}\n\n"

    # Limit total content size to avoid exceeding context
    max_combined = 150_000
    if len(combined) > max_combined:
        combined = combined[:max_combined] + "\n\n[Content truncated for length]"

    user_message = f"""Analyze the following company website pages and extract structured company intelligence.

{combined}

Extract all available data into the JSON schema described in your instructions. Be thorough but only include data that is actually present in the content above."""

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=8192,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
                temperature=0.0,
            )

            result = ""
            for block in response.content:
                if block.type == "text":
                    result += block.text

            # Strip markdown code fences if present
            result = result.strip()
            if result.startswith("```json"):
                result = result[7:]
            if result.startswith("```"):
                result = result[3:]
            if result.endswith("```"):
                result = result[:-3]
            result = result.strip()

            # Validate JSON
            try:
                parsed = json.loads(result)
                tokens_in = response.usage.input_tokens
                tokens_out = response.usage.output_tokens
                log("  ", f"  Tokens: {tokens_in:,} in / {tokens_out:,} out")
                return parsed
            except json.JSONDecodeError:
                if attempt < MAX_RETRIES:
                    log("  ", f"  Invalid JSON (attempt {attempt}/{MAX_RETRIES}), retrying...")
                    continue
                # Return a minimal structure on failure
                return {
                    "company_name": base_url,
                    "description": "Failed to extract structured data.",
                    "website": base_url,
                    "_error": "Claude returned invalid JSON after all attempts.",
                    "_raw_output": result[:500],
                }

        except Exception as e:
            error_str = str(e).lower()
            is_transient = "rate" in error_str or "overloaded" in error_str or "529" in str(e)

            if attempt < MAX_RETRIES and is_transient:
                wait = 2 ** attempt
                log("  ", f"  API error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait}s...")
                await asyncio.sleep(wait)
            else:
                raise

    raise RuntimeError("Max retries exceeded during extraction")


# ---------------------------------------------------------------------------
# Enrichment pipeline
# ---------------------------------------------------------------------------


async def enrich_company(base_url: str, model: str) -> dict[str, Any]:
    """Full enrichment pipeline for a single company URL."""
    log("🏢", f"Enriching: {base_url}")

    # Step 1: Read multiple pages
    log("📖", f"Reading pages via Reader...")
    pages = await read_company_pages(base_url)

    if not pages:
        log("  ", "  No pages could be read. Skipping.")
        return {
            "company_name": base_url,
            "description": "Could not read any pages from this website.",
            "website": base_url,
            "_error": "No pages were accessible.",
        }

    log("  ", f"  Successfully read {len(pages)} page(s)")

    # Step 2: Extract structured data with Claude
    log("🤖", "Extracting company intelligence with Claude...")
    data = await extract_company_data(pages, base_url, model)

    # Ensure the website field is always set
    if not data.get("website"):
        data["website"] = base_url

    log("  ", f"  Extracted: {data.get('company_name', 'Unknown')}")

    products_count = len(data.get("products_and_services", []))
    tiers_count = len(data.get("pricing", {}).get("tiers", []))
    people_count = len(data.get("team_indicators", {}).get("key_people", []))
    tech_count = len(data.get("technology_stack", []))

    log("  ", f"  Products: {products_count}, Pricing tiers: {tiers_count}, "
             f"People: {people_count}, Tech: {tech_count}")

    return data


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the lead enrichment agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    # Parse arguments
    output_file: str | None = None
    urls: list[str] = []

    i = 0
    while i < len(args):
        if args[i] == "--output" and i + 1 < len(args):
            output_file = args[i + 1]
            i += 2
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py <URL> [URL...] [OPTIONS]")
            print()
            print("Arguments:")
            print("  URL              One or more company website URLs to enrich")
            print()
            print("Options:")
            print("  --output FILE    Save enrichment JSON to a file")
            print()
            print("Examples:")
            print('  python main.py "https://stripe.com"')
            print('  python main.py "https://stripe.com" "https://vercel.com" --output leads.json')
            print()
            print("Environment:")
            print("  ANTHROPIC_API_KEY    Required. Your Anthropic API key.")
            print("  MODEL                Optional. Default: claude-sonnet-4-20250514")
            sys.exit(0)
        else:
            urls.append(args[i])
            i += 1

    # Interactive prompt if no URLs given
    if not urls:
        raw = input("Enter company URL(s) separated by spaces: ").strip()
        if raw:
            urls = raw.split()

    if not urls:
        print("Please provide at least one company URL.", file=sys.stderr)
        sys.exit(1)

    # Normalize all URLs
    normalized = [normalize_base_url(u) for u in urls]

    log("🚀", "Starting lead enrichment agent...")
    log("🤖", f"Model: {model}")
    log("🏢", f"Companies: {len(normalized)}")
    for u in normalized:
        log("  ", f"  {u}")
    print(file=sys.stderr)

    # Enrich each company sequentially to avoid rate limits
    results: list[dict[str, Any]] = []
    for idx, base_url in enumerate(normalized, 1):
        log("", f"[{idx}/{len(normalized)}]")
        try:
            data = await enrich_company(base_url, model)
            results.append(data)
        except KeyboardInterrupt:
            print("\nCancelled.", file=sys.stderr)
            sys.exit(0)
        except Exception as e:
            log("  ", f"  Error enriching {base_url}: {e}")
            results.append({
                "company_name": base_url,
                "website": base_url,
                "_error": str(e),
            })
        print(file=sys.stderr)

    log("✅", f"Enrichment complete! {len(results)} company/companies processed.")
    print(file=sys.stderr)

    # Output JSON to stdout
    output = results if len(results) > 1 else results[0]
    output_json = json.dumps(output, indent=2, ensure_ascii=False)
    print(output_json)

    if output_file:
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(output_json + "\n")
        log("💾", f"Saved to {output_file}")


if __name__ == "__main__":
    asyncio.run(main())
