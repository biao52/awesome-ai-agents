# 🏢 Lead Enrichment Agent

> Scrapes company websites and extracts structured company intelligence from just a URL, using Reader for multi-page reading and Claude for analysis.

## What You'll Learn

- Multi-page scraping with graceful 404 handling
- Parallel HTTP requests for efficient data collection
- Structured JSON extraction from unstructured web content
- Building a practical sales/research tool with AI

## Architecture

```
Company URL(s)
    |
    v
For each company:
    Reader reads /, /about, /pricing, /team, /careers, /contact ...
    (parallel requests, 404s silently skipped)
    |
    v
All page markdown combined into single context
    |
    v
Claude extracts structured JSON:
    company info, products, pricing, team, tech stack, contacts, socials, funding
    |
    v
JSON output to stdout (one object per company, array for multiple)
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- API key for Anthropic (Claude) - get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
- Reader API key -- get one at [reader.dev](https://reader.dev)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env  # Then add your Anthropic + Reader API keys
python main.py "https://stripe.com"
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your Anthropic + Reader API keys
npx tsx index.ts "https://stripe.com"
```

## How It Works

The agent takes one or more company URLs and builds a comprehensive profile for each. For every company, it tries reading up to 10 common pages (homepage, about, pricing, team, careers, contact, products, services) through Reader, which converts raw HTML into clean markdown. All page requests run in parallel for speed. Pages that return 404 or fail to load are silently skipped, so the agent works even on minimal sites with just a homepage.

All successfully fetched pages are combined into a single context document and sent to Claude with a detailed extraction schema. The schema covers 10 data categories: company identity, products/services, pricing model and tiers, team size and key people, technology stack, contact details, social media profiles, and funding indicators. Claude analyzes the combined content and populates every field it can find evidence for, using null for anything not present.

The output goes to stdout as clean JSON, with all status logs going to stderr. This means you can pipe the output directly into other tools (`python main.py "https://example.com" | jq .pricing`) or save it with the `--output` flag. When multiple companies are provided, each is enriched sequentially to avoid rate limits, and the output is a JSON array.

Reader handles all the complexity of web scraping: JavaScript rendering, cookie banners, navigation chrome. The agent gets clean content without needing browser headers, puppeteer, or any scraping infrastructure. A typical enrichment reads 3-6 pages per company and costs roughly $0.02-0.05 in Claude API usage.

## Configuration

| Variable          | Required | Description                              |
| ----------------- | -------- | ---------------------------------------- |
| `ANTHROPIC_API_KEY` | Yes    | Your Anthropic API key                   |
| `READER_API_KEY`  | Yes      | Your Reader API key -- get one at [reader.dev](https://reader.dev) |
| `MODEL`           | No       | Claude model to use (default: claude-sonnet-4-20250514) |

## Key Files

| File                    | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `main.py` / `index.ts`  | Entry point, CLI parsing, orchestration        |
| `requirements.txt`      | Python dependencies                            |
| `package.json`          | TypeScript dependencies and scripts            |

## Example Output

```json
{
  "company_name": "Stripe",
  "description": "Stripe is a financial infrastructure platform for businesses. It provides APIs and tools for online payment processing, billing, and financial operations.",
  "industry": "FinTech",
  "products_and_services": [
    {
      "name": "Payments",
      "description": "Accept payments online and in person with a unified API.",
      "category": "API"
    },
    {
      "name": "Billing",
      "description": "Subscription and recurring billing management.",
      "category": "SaaS"
    }
  ],
  "pricing": {
    "model": "usage-based",
    "tiers": [
      {
        "name": "Integrated",
        "price": "2.9% + $0.30 per transaction",
        "highlights": ["No setup fees", "No monthly fees"]
      }
    ]
  },
  "team_indicators": {
    "team_size_estimate": "5000+",
    "key_people": [
      { "name": "Patrick Collison", "role": "CEO" }
    ],
    "hiring": true
  },
  "technology_stack": ["Ruby", "JavaScript", "React"],
  "contact": {
    "email": null,
    "phone": null,
    "address": "South San Francisco, CA",
    "demo_url": "https://stripe.com/contact/sales"
  },
  "social_media": {
    "twitter": "https://twitter.com/stripe",
    "linkedin": "https://linkedin.com/company/stripe",
    "github": "https://github.com/stripe",
    "youtube": null,
    "other": []
  },
  "funding_indicators": {
    "stage": "Public-equivalent (private, $95B valuation)",
    "investors": ["Sequoia Capital", "Andreessen Horowitz"],
    "signals": ["$95B valuation", "Processing billions in transactions"]
  },
  "website": "https://stripe.com"
}
```

## CLI Usage

```bash
# Single company
python main.py "https://stripe.com"

# Multiple companies
python main.py "https://stripe.com" "https://vercel.com" "https://linear.app"

# Save to file
python main.py "https://stripe.com" --output stripe.json

# Pipe to jq for specific fields
python main.py "https://stripe.com" | jq '.pricing'
```

## Cost Estimate

Each company enrichment reads 3-6 pages through Reader and makes one Claude API call with the combined content. Typical cost per company is $0.02-0.05 depending on how many pages are available and how content-rich they are.

## Extend This Example

- Add LinkedIn or Crunchbase enrichment by reading those pages through Reader
- Feed the output into a CRM via API (HubSpot, Salesforce)
- Build a batch pipeline that reads URLs from a CSV and outputs an enriched CSV
- Add a scoring system to rank leads by fit (team size, funding stage, tech stack match)
- Combine with the Research Agent for deeper competitive analysis
- Add Glassdoor or job board reading for richer team and culture signals

## Related Examples

- [Web Scraping Agent](../../starter/web-scraping-agent) - Single-page structured extraction
- [Deep Research Agent](../deep-research-agent) - Multi-source research with citations
- [Content Repurposer](../../starter/content-repurposer) - Another Reader-powered example
