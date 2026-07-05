# Web Scraping Agent

> An agent that takes any URL and a plain-English description of what data you want, fetches the page, and returns clean structured JSON -- no selectors, no parsing code, just describe what you need.

## What You'll Build

A CLI tool that scrapes any public web page and extracts structured data from it using AI. You give it a URL and tell it what you want (e.g., "Extract all product names and prices"), and it returns clean JSON. The output goes to stdout so you can pipe it to files or other tools.

## What You'll Learn

- How to use a single-prompt pattern for structured data extraction from HTML
- How to craft system prompts that produce consistently valid JSON output
- How to handle web fetching with realistic browser headers to avoid blocks
- How to implement retry logic for both HTTP requests and LLM API calls
- How to separate stdout (data) from stderr (status logs) for pipeable CLI tools

## Architecture

```
User provides URL + extraction goal (plain English)
    ↓
Fetch page with browser-like headers
(User-Agent, Accept, redirects, retry on 5xx)
    ↓
Send raw HTML + extraction goal to Claude
(system prompt enforces JSON-only output)
    ↓
Claude analyzes HTML structure:
    -> Identifies matching data elements
    -> Designs appropriate JSON schema
    -> Extracts all matching items
    ↓
Validate JSON output (retry if invalid)
    ↓
Output: Clean JSON array/object to stdout
        Status logs to stderr
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
  - Free tier includes $5 of credits
- **Estimated cost:** ~$0.005-0.03 per extraction (depends on page size)

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

4. Open `.env` and add your Anthropic API key.

5. Run the agent:
   ```bash
   python main.py "https://news.ycombinator.com" "Extract all story titles, links, and points"
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

4. Open `.env` and add your Anthropic API key.

5. Run the agent:
   ```bash
   npx tsx index.ts "https://news.ycombinator.com" "Extract all story titles, links, and points"
   ```

## How It Works

This agent uses a **single-prompt extraction pattern**. Unlike agents that need multi-step tool calling, web scraping is a two-step process: fetch the HTML, then ask Claude to extract data from it. The entire extraction happens in one API call, which keeps the cost low and latency fast.

The fetching layer uses realistic browser headers (Chrome User-Agent, standard Accept headers) to avoid basic anti-scraping blocks. It follows redirects, handles timeouts, and retries on 5xx server errors with exponential backoff. A 403 or 404 gets a clear error message explaining what went wrong.

The system prompt is the critical piece. It tells Claude to output **only valid JSON** with no markdown or explanation. It specifies conventions: snake_case keys, null for missing fields, clean data (no HTML tags, normalized URLs, ISO dates). The prompt also handles edge cases -- when no data matches, Claude returns an empty array with a `_note` explaining why, rather than hallucinating data.

The output is deliberately split: JSON goes to stdout, status messages go to stderr. This means you can pipe the output directly into `jq`, redirect to a file, or chain with other tools: `python main.py "url" "goal" | jq '.[] | .title'`. If Claude returns invalid JSON despite the prompt constraints, the agent retries up to 3 times before falling back to the raw output.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `MODEL` | No | `claude-sonnet-4-20250514` | Override the Claude model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: CLI parsing, page fetching, extraction orchestration |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Extract data from Hacker News
python main.py "https://news.ycombinator.com" "Extract all story titles, links, points, and comment counts"

# Extract from a product page and save to file
python main.py "https://example.com/products" "Extract product names and prices" --output products.json

# Interactive mode -- prompts for URL and goal
python main.py

# Pipe JSON output to jq
python main.py "https://example.com" "Extract all links" | jq '.[0]'
```

**Example output:**

```json
[
  {
    "title": "Show HN: I built a tool to...",
    "url": "https://example.com/show-hn",
    "points": 142,
    "comment_count": 58
  },
  {
    "title": "Why Rust is the future of...",
    "url": "https://blog.example.com/rust",
    "points": 89,
    "comment_count": 34
  }
]
```

## Common Issues & Troubleshooting

**"Access denied (403 Forbidden)"**
- The site is blocking automated requests. Some sites aggressively block non-browser traffic.
- Try a different page on the same site, or check if the site has a public API instead.

**"Page is large... Trimming"**
- The agent trims HTML to 120K chars to fit within Claude's context window.
- For very large pages, the trimming might cut off data at the bottom. Try targeting a more specific URL (e.g., a single category page instead of the homepage).

**"Model returned invalid JSON"**
- The agent automatically retries up to 3 times when Claude produces invalid JSON.
- If it persists, try simplifying your extraction goal to be more specific.

**Empty results `[]`**
- The page might load content dynamically with JavaScript. This agent fetches raw HTML only.
- Check if the data you want appears in the page source (View Source in your browser).
- For JS-rendered pages, consider using Reader (reader.dev) which renders JavaScript.

**"Rate limit" errors**
- The agent retries automatically with exponential backoff.
- If it still fails, wait a minute and try again.

## Extend This Example

- **Add JavaScript rendering** -- integrate with Reader (reader.dev) or Playwright to handle pages that load content dynamically with JavaScript
- **Add `--schema` flag** -- let users provide a JSON schema, so Claude validates extracted data against it
- **Batch mode** -- accept a file of URLs (one per line) and extract data from each, combining results
- **Add `--selector` hint** -- let users optionally provide a CSS selector to narrow the HTML sent to Claude (cheaper and more accurate for large pages)
- **Diff mode** -- scrape the same URL on a schedule, compare results, and alert on changes

## Related Examples

- [Code Review Agent](../code-review-agent) -- Also uses Claude's single-prompt pattern, but for code analysis
- [Research Agent](../research-agent) -- Uses multi-step tool calling for web research (search + read, not extract)
- [Lead Enrichment Agent](../../advanced/lead-enrichment) -- An advanced version that scrapes multiple pages and fuses data into structured company profiles
