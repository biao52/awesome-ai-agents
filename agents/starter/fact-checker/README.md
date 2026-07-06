# Fact-Checker Agent

> Verifies claims by searching the web, reading sources with Reader, and producing a structured verdict with evidence and source credibility assessment.

## What You'll Learn

- Multi-step agent pipeline (search, read, analyze, verdict)
- Using Reader to fetch web pages as clean markdown for LLM analysis
- Parallel source reading with asyncio.gather / Promise.allSettled
- Structured output parsing with verdict and confidence scoring
- Source credibility assessment

## Architecture

```
User provides a claim to verify
    |
    v
Generate search queries (Claude)
    |
    v
Search the web (Tavily API, 2-3 queries)
    |
    v
Read top 5 sources in parallel (Reader: r.reader.dev)
    |
    v
Analyze all evidence (Claude)
    |
    v
Output: Structured fact-check report
    - Verdict: TRUE / FALSE / PARTIALLY TRUE / UNVERIFIABLE
    - Confidence: HIGH / MEDIUM / LOW
    - Supporting + contradicting evidence
    - Source credibility ratings
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- Anthropic API key, get one at [console.anthropic.com](https://console.anthropic.com)
- Tavily API key, get one at [tavily.com](https://tavily.com) (free tier available)
- No key needed for Reader (the `r.reader.dev` endpoint is free)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env  # Then add your API keys
python main.py "The Great Wall of China is visible from space"
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your API keys
npx tsx index.ts "The Great Wall of China is visible from space"
```

## How It Works

The agent follows a four-step pipeline to verify claims. First, it sends the claim to Claude, which generates 2-3 targeted search queries. A claim like "The Great Wall of China is visible from space" might produce queries about astronaut observations, satellite imagery, and common myths about the Great Wall. This query expansion step is important because a single search rarely covers all angles needed for proper fact-checking.

Next, the agent runs those queries against the Tavily search API and collects unique results across all queries. It then reads the top 5 sources in parallel using Reader (`r.reader.dev`), which converts each web page into clean markdown. This is much better than sending raw HTML to an LLM because Reader strips navigation, ads, and boilerplate, leaving just the article content in a format Claude can reason about effectively.

Finally, the agent sends all the source content along with the original claim to Claude for analysis. Claude evaluates each source for credibility and relevance, weighs supporting evidence against contradicting evidence, and produces a structured verdict. The output includes specific evidence points from the sources, not just a yes/no answer. If sources are insufficient or conflicting without resolution, the agent honestly returns UNVERIFIABLE rather than guessing.

The entire pipeline runs in about 10-15 seconds. The Reader calls happen in parallel (via `asyncio.gather` in Python, `Promise.allSettled` in TypeScript), so reading 5 pages takes roughly as long as reading one. Approximate cost per fact-check is ~$0.01-0.03 depending on source length.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `TAVILY_API_KEY` | Yes | Your Tavily API key for web search |
| `MODEL` | No | Override the model (default: `claude-sonnet-4-20250514`) |

## Key Files

| File | Purpose |
| --- | --- |
| `main.py` / `index.ts` | Entry point, CLI parsing, and pipeline orchestration |
| - | Search, read, and analysis steps are defined inline |

## CLI Usage

```bash
# Interactive mode (prompts for a claim)
python main.py

# Direct mode (pass the claim as an argument)
python main.py "Humans only use 10% of their brains"

# Save report to file
python main.py "Coffee stunts your growth" --output report.txt
```

## Example Output

```
🚀 Starting fact-checker agent...
📋 Claim: "The Great Wall of China is visible from space"
🤖 Model: claude-sonnet-4-20250514

🧠 Generating search queries for the claim...
🔍 Search queries: ["Great Wall of China visible from space", "can astronauts see Great Wall from orbit"]
    Found 8 unique sources
📖 Reading 5 sources with Reader...
    [read] en.wikipedia.org
    [read] www.nasa.gov
    [read] www.scientificamerican.com
    [read] www.snopes.com
    [read] www.space.com
🧪 Analyzing sources and determining verdict...

================================================================
  FACT-CHECK REPORT
================================================================

  Claim: "The Great Wall of China is visible from space"

  Verdict:    ❌ FALSE
  Confidence: ███████████ HIGH

----------------------------------------------------------------
  Summary
----------------------------------------------------------------
  The claim that the Great Wall of China is visible from space
  is a persistent myth. Multiple astronauts and NASA have confirmed
  that the Wall is not visible to the naked eye from low Earth orbit.

----------------------------------------------------------------
  Supporting Evidence
----------------------------------------------------------------
  (none)

----------------------------------------------------------------
  Contradicting Evidence
----------------------------------------------------------------
  1. NASA has stated the Wall is not visible from space without aid
  2. Astronaut Chris Hadfield confirmed he could not see it from the ISS
  3. The Wall is only ~15 feet wide, far too narrow to resolve from orbit

----------------------------------------------------------------
  Sources
----------------------------------------------------------------
  [1] Great Wall of China - Wikipedia (credibility: MEDIUM)
      https://en.wikipedia.org/wiki/Great_Wall_of_China
  [2] Is the Great Wall Visible from Space? - NASA (credibility: HIGH)
      https://www.nasa.gov/...
  [3] The Great Wall of China Visibility Myth (credibility: HIGH)
      https://www.scientificamerican.com/...

================================================================
```

## How Reader Fits In

Reader (`r.reader.dev`) converts any web page into clean, LLM-friendly markdown. Instead of parsing raw HTML or dealing with JavaScript-rendered content, you send a GET request to `https://r.reader.dev/{url}` and get back just the article text, tables, and headings. No API key required.

This matters for fact-checking because source quality depends on actually reading the content, not just snippets. Search APIs return 1-2 sentence previews, but you need the full article to find specific data points, quotes, and context. Reader gives the agent access to full pages without the noise of ads, navigation bars, and cookie banners that confuse LLMs.

## Limitations

- The agent relies on web search results, so very recent or niche claims may not have enough coverage
- Source credibility is assessed heuristically by the LLM, not by a curated database
- The agent checks a maximum of 5 sources per claim, which may miss important counter-evidence
- Claims requiring domain expertise (medical, legal) should be verified by qualified professionals

## Extend This Example

- Add a **multi-claim mode** that accepts a list of claims from a file and processes them in batch
- Integrate a **bias detector** that flags politically or emotionally charged sources
- Add **historical tracking** to compare how a claim's verdict changes over time as new sources appear
- Use Claude's tool-use API to let the model decide when it needs more sources before rendering a verdict
- Wire up Reader's search endpoint (`s.reader.dev`) as an alternative to Tavily

## Related Examples

- [Research Agent](../research-agent) - Open-ended research with structured report output
- [Web Scraping Agent](../web-scraping-agent) - Structured data extraction from web pages
