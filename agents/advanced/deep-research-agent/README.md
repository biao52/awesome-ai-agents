# Deep Research Agent

> A multi-step research agent that decomposes complex questions, searches the web in parallel, evaluates source credibility, identifies knowledge gaps, and produces comprehensive reports with citations and cost tracking.

## What You'll Build

A CLI tool that takes a research topic and produces a 2000-4000 word research report. Unlike the starter Research Agent, this one uses a 4-phase pipeline: plan, research (parallel), follow-up (gap analysis), and synthesize. It uses two models (Sonnet for reasoning, Haiku for extraction) to optimize cost, and tracks token usage throughout.

## What You'll Learn

- How to build a multi-phase agent pipeline (plan, execute, evaluate, synthesize)
- How to run parallel async operations for faster research (`asyncio.gather` / `Promise.all`)
- How to use multiple models for different tasks (expensive model for reasoning, cheap model for extraction)
- How to track token usage and estimate costs across multiple API calls
- How to implement gap analysis and follow-up research rounds

## Architecture

```
User provides research topic
    ↓
Phase 1 - PLAN (Sonnet):
    → Decompose into 5-8 sub-questions
    ↓
Phase 2 - RESEARCH (parallel, Haiku for extraction):
    → For each sub-question (in parallel):
        → Web search via Tavily
        → Read top 3 pages
        → Extract findings + credibility score
    ↓
Phase 3 - FOLLOW-UP (Sonnet + Haiku):
    → Analyze gaps in research
    → Generate 2-3 follow-up questions
    → Research follow-ups (parallel)
    → Repeat up to 2 rounds
    ↓
Phase 4 - SYNTHESIZE (Sonnet):
    → Organize by theme (not by sub-question)
    → Resolve contradictions
    → Generate report with inline citations
    → Add bibliography
    ↓
Output: Markdown report (2000-4000 words)
        + token usage summary + cost estimate
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
- **Tavily API key** -- get one at [tavily.com](https://tavily.com) (free tier available)
- **Estimated cost:** ~$0.05-0.15 per deep research (varies by topic complexity)

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

4. Open `.env` and add both API keys.

5. Run a deep research:
   ```bash
   python main.py "Impact of AI on drug discovery"
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

4. Open `.env` and add both API keys.

5. Run a deep research:
   ```bash
   npx tsx index.ts "Impact of AI on drug discovery"
   ```

## How It Works

The key insight is **using different models for different cognitive tasks**. Reasoning (planning, gap analysis, synthesis) uses Sonnet -- it's better at complex thinking. Extraction (pulling facts from web pages) uses Haiku -- it's 4x cheaper and fast enough for structured extraction. This dual-model approach cuts costs by ~60% compared to using Sonnet for everything.

Phase 2 (research) runs all sub-questions **in parallel** using `asyncio.gather` (Python) or `Promise.all` (TypeScript). Each sub-question triggers a Tavily search, reads the top 3 pages concurrently, and extracts findings. This means 5 sub-questions don't take 5x as long -- they complete in roughly the time of the slowest single query.

The follow-up phase is what makes this a "deep" research agent. After initial research, Sonnet analyzes the findings and identifies gaps -- questions that weren't adequately answered. It generates 2-3 follow-up queries, researches them (also in parallel), and integrates the results. This runs up to 2 rounds, or stops early if no gaps are found.

The synthesis phase organizes findings **by theme, not by sub-question**. This produces a natural report structure rather than a question-by-question dump. Contradictions between sources are explicitly noted. All sources get inline citations ([1], [2]) with a full bibliography at the end. The cost tracker reports exact token usage per model and estimated cost, so you always know what a research run costs.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `TAVILY_API_KEY` | Yes | -- | Your Tavily API key for web search |
| `REASONING_MODEL` | No | `claude-sonnet-4-20250514` | Model for planning and synthesis |
| `EXTRACTION_MODEL` | No | `claude-haiku-4-5-20251001` | Model for extracting findings |
| `MAX_SOURCES_PER_QUESTION` | No | `5` | Max search results per sub-question |
| `MAX_FOLLOW_UP_ROUNDS` | No | `2` | Max rounds of follow-up research |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Full pipeline: planning, parallel research, gap analysis, synthesis |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Deep research on a topic
python main.py "Impact of AI on drug discovery"

# Save report to file
python main.py "Future of quantum computing" --output report.md

# Interactive mode
python main.py
```

## Common Issues & Troubleshooting

**High cost per run**
- Reduce `MAX_FOLLOW_UP_ROUNDS` to 1 or 0
- Reduce `MAX_SOURCES_PER_QUESTION` to 3
- Switch `REASONING_MODEL` to Haiku for cheaper (but lower quality) synthesis

**Slow research**
- The parallel phase is usually fast (5-10s). Synthesis is the bottleneck (large context).
- Reduce the number of sub-questions by using a more specific topic.

**"Search failed" warnings**
- Tavily's free tier has rate limits. Wait a moment and retry.
- Some very niche queries return no results. The agent handles this gracefully.

**Report quality is poor**
- Try a more specific topic. "AI" is too broad; "AI applications in radiology diagnosis" is better.
- Increase `MAX_FOLLOW_UP_ROUNDS` for more thorough coverage.

## Extend This Example

- **Add source caching** -- cache page contents to avoid re-fetching the same URL across sub-questions
- **Add streaming** -- stream the synthesis phase so the report appears progressively
- **Add a comparison mode** -- research two sides of a debate and produce a balanced analysis
- **Export formats** -- add `--format html` or `--format pdf` output options
- **Cost budgets** -- add a `--max-cost` flag that stops research when the budget is reached

## Related Examples

- [Research Agent](../../starter/research-agent) -- The simpler version: single-pass research without parallel execution or follow-ups
- [Content Pipeline](../../../multi-agent/content-pipeline) -- Multi-agent pipeline that uses research as one step in content creation
- [Fact-Checker Agent](../../starter/fact-checker) -- Uses web research to verify claims rather than produce reports
