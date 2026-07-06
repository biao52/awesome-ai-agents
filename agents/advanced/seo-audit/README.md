# SEO Audit Agent

> An automated SEO audit agent that crawls a website, analyzes every page for SEO factors, and produces a prioritized report with scores, issues, and actionable recommendations.

## What You'll Build

A CLI tool that takes a single URL and produces a full SEO audit report. It reads the homepage via Reader, discovers internal pages, crawls up to 10 of them, runs both code-based structural checks and AI-powered content analysis on each page, then synthesizes everything into a scored report with prioritized issues and quick wins.

## What You'll Learn

- How to use Reader to convert any web page to clean markdown for analysis
- How to combine code-based checks (fast, deterministic) with LLM analysis (qualitative, nuanced)
- How to crawl a site by extracting links from markdown content
- How to run parallel async operations for faster page processing
- How to produce structured audit reports with scoring and prioritization

## Architecture

```
User provides website URL
    |
Phase 1 - READ HOMEPAGE:
    -> POST https://api.reader.dev/v1/read with URL
    -> Receive clean markdown
    |
Phase 2 - DISCOVER PAGES:
    -> Extract internal links from markdown
    -> Select up to N pages to crawl
    |
Phase 3 - READ ALL PAGES (parallel):
    -> Read each page via Reader (asyncio.gather / Promise.all)
    |
Phase 4 - STRUCTURAL CHECKS (code-based, fast):
    -> Title tag presence and length
    -> Heading hierarchy (H1/H2/H3 counts)
    -> Word count / thin content detection
    -> Internal and external link counts
    -> Missing alt text indicators
    -> Meta description detection
    |
Phase 5 - AI CONTENT ANALYSIS (parallel, OpenAI):
    -> Content quality assessment
    -> Keyword density and focus
    -> Additional SEO issues
    -> Page-level recommendations
    |
Phase 6 - EXECUTIVE SUMMARY (OpenAI):
    -> Overall score (1-100)
    -> Top issues (prioritized)
    -> Quick wins
    -> Strategic recommendations
    |
Output: Markdown SEO audit report
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **OpenAI API key** - get one at [platform.openai.com](https://platform.openai.com/api-keys)
- **Reader API key** - get one at [reader.dev](https://reader.dev)
- **Estimated cost:** ~$0.02-0.05 per audit (varies by number of pages)

## Quick Start

### Python

1. Navigate to the Python directory:
   ```bash
   cd python
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Set up your environment:
   ```bash
   cp .env.example .env
   ```

4. Open `.env` and add your OpenAI API key.

5. Run an audit:
   ```bash
   python main.py "https://example.com"
   ```

### TypeScript

1. Navigate to the TypeScript directory:
   ```bash
   cd typescript
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your environment:
   ```bash
   cp .env.example .env
   ```

4. Open `.env` and add your OpenAI API key.

5. Run an audit:
   ```bash
   npx tsx index.ts "https://example.com"
   ```

## How It Works

The agent splits SEO analysis into two layers: **structural checks** (done in code) and **qualitative analysis** (done by the LLM). Structural checks are fast and deterministic. They count headings, measure content length, detect missing alt text, and check title tag length. These run instantly and catch the most common SEO issues. The LLM layer handles things code cannot: assessing whether content is well-written, whether keywords are used naturally, and whether the page provides genuine value to users.

Reader converts raw HTML into clean markdown, which serves double duty. First, it gives the agent a structured representation of the page that is easy to parse with regex (heading counts, link extraction). Second, it produces content that fits neatly into an LLM context window without the noise of HTML tags, scripts, and stylesheets. This means the agent never needs to parse HTML directly.

Link discovery works by extracting markdown links from the homepage content, filtering for internal links (same domain), and deduplicating them. The agent then reads up to N internal pages in parallel using `asyncio.gather` (Python) or `Promise.all` (TypeScript). This keeps the total crawl time roughly equal to the slowest single page read, rather than scaling linearly.

The final executive summary step sends all page-level analyses to the LLM, which produces a prioritized list of issues, identifies quick wins (easy fixes with high impact), and generates strategic recommendations. The overall score is a weighted assessment that considers page importance and issue severity.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | - | Your OpenAI API key |
| `READER_API_KEY` | Yes | - | Your Reader API key -- get one at [reader.dev](https://reader.dev) |
| `MODEL` | No | `gpt-4o-mini` | OpenAI model for analysis |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Full audit pipeline: crawl, analyze, report |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Audit a website
python main.py "https://example.com"

# Save report to file
python main.py "https://example.com" --output report.md

# Limit to 5 pages
python main.py "https://example.com" --pages 5

# Combine flags
python main.py "https://example.com" --output report.md --pages 3

# Interactive mode (prompts for URL)
python main.py
```

## Common Issues & Troubleshooting

**Reader returns no content**
- Some sites block automated requests or have heavy JavaScript rendering. Reader handles most JavaScript-rendered pages, but some may not return content.
- Try a different page on the same site to verify.

**Too many pages found**
- Use the `--pages` flag to limit crawl scope. Start with `--pages 3` for a quick check.

**Low scores on single-page sites**
- The agent checks for internal linking, which naturally scores lower on sites with few pages. Focus on the content quality and structural metrics instead.

**Report quality varies**
- More pages give the LLM better context for the executive summary. Auditing at least 5 pages produces the most useful reports.

## Extend This Example

- **Add sitemap parsing** - Read `sitemap.xml` to discover all pages instead of relying on link extraction
- **Add competitor comparison** - Audit two sites and produce a side-by-side comparison
- **Add historical tracking** - Save reports to a database and show SEO score trends over time
- **Add screenshot capture** - Take screenshots of each page alongside the analysis
- **Custom scoring weights** - Let users configure which SEO factors matter most for their site

## Related Examples

- [Deep Research Agent](../deep-research-agent) - Multi-step research agent with parallel web search and source evaluation
- [Competitor Monitor](../competitor-monitor) - Track and analyze competitor websites over time
- [Web Scraping Agent](../../starter/web-scraping-agent) - Extract structured data from any web page
