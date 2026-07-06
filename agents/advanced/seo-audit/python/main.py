"""
SEO Audit Agent - Crawls a website via Reader and produces a comprehensive
SEO analysis report with page-by-page scoring, prioritized issues, and
actionable recommendations.

Uses Reader (api.reader.dev/v1/read) for page reading and OpenAI for qualitative analysis.
"""

import os
import re
import sys
import json
import asyncio
import time
from typing import Any
from dataclasses import dataclass, field
from urllib.parse import urlparse, urljoin

import httpx
from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

READER_API_URL = "https://api.reader.dev/v1/read"
DEFAULT_MODEL = "gpt-4o-mini"
MAX_PAGES = 10
MAX_CONTENT_LENGTH = 12000  # Chars to keep per page for LLM analysis
REQUEST_TIMEOUT = 30.0

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables."""
    required = ["OPENAI_API_KEY", "READER_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"\u274c Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class PageAnalysis:
    """SEO analysis results for a single page."""
    url: str
    title: str = ""
    score: int = 0
    h1_count: int = 0
    h2_count: int = 0
    h3_count: int = 0
    word_count: int = 0
    internal_links: int = 0
    external_links: int = 0
    missing_alt_indicators: int = 0
    has_meta_description: bool = False
    issues: list[str] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)
    content_quality: str = ""
    keyword_density_notes: str = ""


@dataclass
class SEOReport:
    """Complete SEO audit report."""
    site_url: str
    overall_score: int = 0
    pages_analyzed: int = 0
    page_analyses: list[PageAnalysis] = field(default_factory=list)
    top_issues: list[str] = field(default_factory=list)
    quick_wins: list[str] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Reader integration
# ---------------------------------------------------------------------------


async def read_page(url: str, client: httpx.AsyncClient) -> str | None:
    """Read a page via Reader and return its markdown content."""
    try:
        response = await client.post(
            READER_API_URL,
            json={"url": url},
            headers={"Authorization": f"Bearer {os.getenv('READER_API_KEY', '')}"},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
        content = data.get("data", {}).get("markdown", "")
        if not content or len(content.strip()) < 50:
            return None
        return content
    except Exception as e:
        log("   ", f"Failed to read {url}: {e}")
        return None


# ---------------------------------------------------------------------------
# Link extraction
# ---------------------------------------------------------------------------


def extract_links(markdown: str, base_url: str) -> tuple[list[str], int, int]:
    """Extract links from markdown content.

    Returns (internal_urls, internal_count, external_count).
    """
    parsed_base = urlparse(base_url)
    base_domain = parsed_base.netloc.lower().replace("www.", "")

    # Match markdown links: [text](url)
    link_pattern = re.compile(r'\[([^\]]*)\]\(([^)]+)\)')
    matches = link_pattern.findall(markdown)

    internal_urls: list[str] = []
    internal_count = 0
    external_count = 0

    seen: set[str] = set()

    for _, href in matches:
        href = href.strip()
        if href.startswith("#") or href.startswith("mailto:") or href.startswith("javascript:"):
            continue

        # Resolve relative URLs
        if not href.startswith("http"):
            href = urljoin(base_url, href)

        parsed = urlparse(href)
        link_domain = parsed.netloc.lower().replace("www.", "")

        if link_domain == base_domain:
            internal_count += 1
            # Normalize the URL for deduplication
            normalized = f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")
            if normalized not in seen and normalized != base_url.rstrip("/"):
                seen.add(normalized)
                internal_urls.append(normalized)
        else:
            external_count += 1

    return internal_urls, internal_count, external_count


# ---------------------------------------------------------------------------
# Code-based SEO checks
# ---------------------------------------------------------------------------


def analyze_page_structure(markdown: str, url: str) -> PageAnalysis:
    """Run code-based SEO checks on markdown content."""
    analysis = PageAnalysis(url=url)

    # Extract title from first H1 or first line
    lines = markdown.split("\n")
    for line in lines[:10]:
        line = line.strip()
        if line.startswith("# ") and not line.startswith("## "):
            analysis.title = line[2:].strip()
            break

    if not analysis.title:
        # Try to find title from metadata at the top
        title_match = re.search(r'Title:\s*(.+)', markdown[:500])
        if title_match:
            analysis.title = title_match.group(1).strip()

    # Count headings
    analysis.h1_count = len(re.findall(r'^# [^#]', markdown, re.MULTILINE))
    analysis.h2_count = len(re.findall(r'^## [^#]', markdown, re.MULTILINE))
    analysis.h3_count = len(re.findall(r'^### [^#]', markdown, re.MULTILINE))

    # Word count (rough, from markdown)
    text_content = re.sub(r'\[([^\]]*)\]\([^)]+\)', r'\1', markdown)  # Remove link syntax
    text_content = re.sub(r'[#*_`\[\]()]', '', text_content)  # Remove markdown formatting
    words = text_content.split()
    analysis.word_count = len(words)

    # Check for missing alt text indicators (images without alt text)
    # In markdown: ![](url) indicates missing alt text
    images_total = len(re.findall(r'!\[', markdown))
    images_with_alt = len(re.findall(r'!\[[^\]]+\]', markdown))
    images_empty_alt = len(re.findall(r'!\[\]\(', markdown))
    analysis.missing_alt_indicators = images_empty_alt

    # Check for meta description (Reader sometimes includes it)
    meta_match = re.search(r'(description|meta):\s*.+', markdown[:1000], re.IGNORECASE)
    analysis.has_meta_description = meta_match is not None

    # Build issues from structural checks
    if analysis.h1_count == 0:
        analysis.issues.append("Missing H1 tag")
    elif analysis.h1_count > 1:
        analysis.issues.append(f"Multiple H1 tags ({analysis.h1_count} found, should be 1)")

    if analysis.h2_count == 0:
        analysis.issues.append("No H2 headings found (poor content structure)")

    if analysis.word_count < 300:
        analysis.issues.append(f"Thin content ({analysis.word_count} words, aim for 300+)")

    if not analysis.title:
        analysis.issues.append("No title tag detected")
    elif len(analysis.title) > 60:
        analysis.issues.append(f"Title too long ({len(analysis.title)} chars, aim for under 60)")
    elif len(analysis.title) < 10:
        analysis.issues.append(f"Title too short ({len(analysis.title)} chars)")

    if not analysis.has_meta_description:
        analysis.issues.append("No meta description detected")

    if analysis.missing_alt_indicators > 0:
        analysis.issues.append(f"{analysis.missing_alt_indicators} image(s) missing alt text")

    return analysis


# ---------------------------------------------------------------------------
# LLM-based qualitative analysis
# ---------------------------------------------------------------------------


async def analyze_content_quality(
    client: AsyncOpenAI,
    markdown: str,
    url: str,
    model: str,
) -> dict[str, Any]:
    """Use LLM to assess content quality, keyword relevance, and SEO factors."""
    truncated = markdown[:MAX_CONTENT_LENGTH]

    system = """You are an SEO expert. Analyze the given page content and provide a JSON assessment.

Output ONLY valid JSON with these fields:
- "content_quality": string, one of "excellent", "good", "average", "poor"
- "content_quality_notes": string, 1-2 sentences explaining the rating
- "keyword_density_notes": string, observations about keyword usage and focus
- "score": integer 1-100, overall SEO score for this page
- "additional_issues": array of strings, any SEO issues not caught by structural checks
- "recommendations": array of strings, specific actionable improvements (max 5)

Consider: content relevance, readability, keyword usage, heading structure quality,
internal linking strategy, and overall user experience signals."""

    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": f"URL: {url}\n\nPage content (markdown):\n{truncated}"},
            ],
            temperature=0.2,
            max_tokens=1024,
        )

        result = response.choices[0].message.content or ""
        result = result.strip()
        if result.startswith("```"):
            result = result.split("\n", 1)[-1].rsplit("```", 1)[0]

        return json.loads(result)
    except (json.JSONDecodeError, Exception) as e:
        log("   ", f"LLM analysis failed for {url}: {e}")
        return {
            "content_quality": "unknown",
            "content_quality_notes": "Analysis failed",
            "keyword_density_notes": "",
            "score": 50,
            "additional_issues": [],
            "recommendations": [],
        }


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------


async def generate_report_summary(
    client: AsyncOpenAI,
    report: SEOReport,
    model: str,
) -> None:
    """Use LLM to generate top issues, quick wins, and overall recommendations."""
    pages_summary = []
    for p in report.page_analyses:
        pages_summary.append({
            "url": p.url,
            "title": p.title,
            "score": p.score,
            "issues": p.issues,
            "word_count": p.word_count,
            "h1_count": p.h1_count,
            "h2_count": p.h2_count,
            "internal_links": p.internal_links,
            "external_links": p.external_links,
        })

    system = """You are an SEO consultant producing the executive summary for an SEO audit report.
Given page-by-page analysis data, produce a JSON object with:
- "overall_score": integer 1-100, weighted average considering page importance
- "top_issues": array of 5-8 strings, most impactful SEO issues found (prioritized by severity)
- "quick_wins": array of 3-5 strings, easy fixes that would improve SEO quickly
- "recommendations": array of 5-8 strings, strategic recommendations for long-term SEO improvement

Be specific and actionable. Reference actual pages and data from the analysis.
Output ONLY valid JSON."""

    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": f"Site: {report.site_url}\n\nPage analyses:\n{json.dumps(pages_summary, indent=2)}"},
            ],
            temperature=0.2,
            max_tokens=2048,
        )

        result = response.choices[0].message.content or ""
        result = result.strip()
        if result.startswith("```"):
            result = result.split("\n", 1)[-1].rsplit("```", 1)[0]

        summary = json.loads(result)
        report.overall_score = summary.get("overall_score", 50)
        report.top_issues = summary.get("top_issues", [])
        report.quick_wins = summary.get("quick_wins", [])
        report.recommendations = summary.get("recommendations", [])
    except Exception as e:
        log("\u26a0\ufe0f", f"Summary generation failed: {e}")
        # Fallback: compute average score
        scores = [p.score for p in report.page_analyses if p.score > 0]
        report.overall_score = round(sum(scores) / len(scores)) if scores else 50
        all_issues = []
        for p in report.page_analyses:
            all_issues.extend(p.issues)
        report.top_issues = list(dict.fromkeys(all_issues))[:8]


def format_report(report: SEOReport) -> str:
    """Format the SEO report as readable markdown."""
    lines: list[str] = []

    lines.append(f"# SEO Audit Report: {report.site_url}")
    lines.append("")
    lines.append(f"**Overall Score: {report.overall_score}/100**")
    lines.append(f"**Pages Analyzed: {report.pages_analyzed}**")
    lines.append("")

    # Top Issues
    lines.append("## Top Issues (Prioritized)")
    lines.append("")
    for i, issue in enumerate(report.top_issues, 1):
        lines.append(f"{i}. {issue}")
    lines.append("")

    # Quick Wins
    lines.append("## Quick Wins")
    lines.append("")
    for i, win in enumerate(report.quick_wins, 1):
        lines.append(f"{i}. {win}")
    lines.append("")

    # Page-by-Page Analysis
    lines.append("## Page-by-Page Analysis")
    lines.append("")
    for page in report.page_analyses:
        lines.append(f"### {page.title or page.url}")
        lines.append(f"**URL:** {page.url}")
        lines.append(f"**Score:** {page.score}/100")
        lines.append("")
        lines.append(f"| Metric | Value |")
        lines.append(f"|--------|-------|")
        lines.append(f"| Word Count | {page.word_count} |")
        lines.append(f"| H1 Tags | {page.h1_count} |")
        lines.append(f"| H2 Tags | {page.h2_count} |")
        lines.append(f"| H3 Tags | {page.h3_count} |")
        lines.append(f"| Internal Links | {page.internal_links} |")
        lines.append(f"| External Links | {page.external_links} |")
        lines.append(f"| Meta Description | {'Yes' if page.has_meta_description else 'No'} |")
        lines.append("")

        if page.content_quality:
            lines.append(f"**Content Quality:** {page.content_quality}")
            lines.append("")

        if page.keyword_density_notes:
            lines.append(f"**Keyword Notes:** {page.keyword_density_notes}")
            lines.append("")

        if page.issues:
            lines.append("**Issues:**")
            for issue in page.issues:
                lines.append(f"- {issue}")
            lines.append("")

        if page.recommendations:
            lines.append("**Recommendations:**")
            for rec in page.recommendations:
                lines.append(f"- {rec}")
            lines.append("")

    # Strategic Recommendations
    lines.append("## Strategic Recommendations")
    lines.append("")
    for i, rec in enumerate(report.recommendations, 1):
        lines.append(f"{i}. {rec}")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main audit pipeline
# ---------------------------------------------------------------------------


async def run_audit(site_url: str, max_pages: int) -> SEOReport:
    """Run the full SEO audit pipeline."""
    openai_client = AsyncOpenAI()
    model = os.getenv("MODEL", DEFAULT_MODEL)

    report = SEOReport(site_url=site_url)
    start_time = time.time()

    # Normalize URL
    if not site_url.startswith("http"):
        site_url = f"https://{site_url}"
    report.site_url = site_url

    async with httpx.AsyncClient(follow_redirects=True) as http_client:
        # Phase 1: Read the main page
        log("\U0001f310", f"Reading main page: {site_url}")
        main_content = await read_page(site_url, http_client)
        if not main_content:
            log("\u274c", "Failed to read the main page. Check the URL and try again.")
            sys.exit(1)

        log("\u2705", f"Main page loaded ({len(main_content)} chars)")

        # Phase 2: Extract internal links
        log("\U0001f517", "Extracting internal links...")
        internal_urls, _, _ = extract_links(main_content, site_url)
        pages_to_crawl = [site_url] + internal_urls[:max_pages - 1]
        log("   ", f"Found {len(internal_urls)} internal links, will analyze {len(pages_to_crawl)} pages")
        print()

        # Phase 3: Read all pages in parallel
        log("\U0001f4e5", "Reading pages via Reader...")

        async def read_single_page(url: str) -> tuple[str, str | None]:
            """Read a single page and return (url, content)."""
            if url == site_url:
                return url, main_content
            content = await read_page(url, http_client)
            return url, content

        read_tasks = [read_single_page(url) for url in pages_to_crawl]
        read_results = await asyncio.gather(*read_tasks)

        page_contents: list[tuple[str, str]] = []
        for url, content in read_results:
            if content:
                page_contents.append((url, content))
                log("   ", f"Loaded: {url}")
            else:
                log("   ", f"Skipped: {url} (no content)")
        print()

        # Phase 4: Structural analysis (code-based, fast)
        log("\U0001f50d", "Running structural SEO checks...")
        analyses: list[PageAnalysis] = []
        for url, content in page_contents:
            analysis = analyze_page_structure(content, url)
            # Add link counts
            _, internal_count, external_count = extract_links(content, site_url)
            analysis.internal_links = internal_count
            analysis.external_links = external_count
            analyses.append(analysis)
            log("   ", f"Checked: {analysis.title or url}")
        print()

        # Phase 5: LLM qualitative analysis (parallel)
        log("\U0001f9e0", "Running AI content analysis...")
        llm_tasks = [
            analyze_content_quality(openai_client, content, url, model)
            for url, content in page_contents
        ]
        llm_results = await asyncio.gather(*llm_tasks)

        for analysis, llm_result in zip(analyses, llm_results):
            analysis.score = llm_result.get("score", 50)
            analysis.content_quality = llm_result.get("content_quality_notes", "")
            analysis.keyword_density_notes = llm_result.get("keyword_density_notes", "")
            analysis.issues.extend(llm_result.get("additional_issues", []))
            analysis.recommendations = llm_result.get("recommendations", [])
            log("   ", f"Analyzed: {analysis.title or analysis.url} (score: {analysis.score})")
        print()

    # Phase 6: Generate executive summary
    log("\U0001f4ca", "Generating executive summary...")
    report.page_analyses = analyses
    report.pages_analyzed = len(analyses)
    await generate_report_summary(openai_client, report, model)

    elapsed = time.time() - start_time
    log("\u23f1\ufe0f", f"Audit completed in {elapsed:.1f}s")

    return report


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """CLI entry point for the SEO audit agent."""
    validate_env()

    args = sys.argv[1:]
    output_file: str | None = None
    max_pages: int = MAX_PAGES
    url_parts: list[str] = []

    i = 0
    while i < len(args):
        if args[i] == "--output" and i + 1 < len(args):
            output_file = args[i + 1]
            i += 2
        elif args[i] == "--pages" and i + 1 < len(args):
            max_pages = int(args[i + 1])
            i += 2
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py [URL] [--output FILE] [--pages N]")
            print()
            print("Arguments:")
            print("  URL             Website URL to audit (prompts if not given)")
            print("  --output FILE   Save report to a file")
            print("  --pages N       Max pages to crawl (default: 10)")
            print()
            print("Examples:")
            print('  python main.py "https://example.com"')
            print('  python main.py "https://example.com" --output report.md --pages 5')
            sys.exit(0)
        else:
            url_parts.append(args[i])
            i += 1

    site_url = " ".join(url_parts) if url_parts else None
    if not site_url:
        site_url = input("\U0001f310 Enter the website URL to audit: ").strip()
    if not site_url:
        print("\u274c Please provide a website URL.")
        sys.exit(1)

    log("\U0001f680", "Starting SEO audit agent...")
    log("\U0001f310", f"Target: {site_url}")
    log("\U0001f4c4", f"Max pages: {max_pages}")
    print()

    try:
        report = await run_audit(site_url, max_pages)
    except KeyboardInterrupt:
        print("\n\u274c Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n\u274c Error: {e}")
        sys.exit(1)

    formatted = format_report(report)

    print("\n" + "=" * 60)
    log("\u2705", "SEO audit complete!\n")
    print(formatted)

    if output_file:
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(formatted)
        log("\U0001f4be", f"Report saved to {output_file}")


if __name__ == "__main__":
    asyncio.run(main())
