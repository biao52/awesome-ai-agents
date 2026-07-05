# Research Agent

An agent that takes a research topic, searches the web, reads relevant pages, and produces a structured research report with citations.

## Architecture

```
User provides topic
    ↓
Agent creates research plan (3-5 sub-questions)
    ↓
For each sub-question:
    → Web search (Tavily API)
    → Read top results
    → Extract key findings
    ↓
Synthesize all findings into structured report
    ↓
Output: Markdown report with sections + citations
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- OpenAI API key — get one at [platform.openai.com](https://platform.openai.com/api-keys)
- Tavily API key — get one at [tavily.com](https://tavily.com) (free tier available)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env  # Then add your API keys
python main.py
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your API keys
npx tsx index.ts
```

## How It Works

The agent uses a **plan-then-execute** pattern. When you give it a topic, it first generates 3-5 sub-questions that break the topic into researchable pieces. This is important because broad topics yield poor search results — specific sub-questions get much better hits.

For each sub-question, the agent calls the `search_web` tool (backed by Tavily's search API) to find relevant pages. It can then use `read_page` to fetch the full content of promising URLs. The agent decides which results to dive deeper into based on relevance.

Once all sub-questions are researched, the agent synthesizes everything into a structured markdown report. It resolves contradictions between sources, organizes findings into logical sections, and adds inline citations. The final output is a report you could actually use — not just a list of search results.

The agent loop uses OpenAI's function calling API. The model calls tools as needed, and we feed the results back until it produces a final text response (the report). This is a standard agentic loop pattern you'll see across many examples in this repo.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `TAVILY_API_KEY` | Yes | Your Tavily API key for web search |
| `MODEL` | No | Override the model (default: `gpt-4o-mini`) |

## Key Files

| File | Purpose |
| --- | --- |
| `main.py` / `index.ts` | Entry point, CLI parsing, and agent orchestration |
| — | Tools (`search_web`, `read_page`) are defined inline |

## CLI Usage

```bash
# Interactive mode (default) — prompts for a topic
python main.py

# Direct mode — pass the topic as an argument
python main.py "History of quantum computing"

# Save report to file
python main.py "History of quantum computing" --output report.md
```

## Extend This Example

- **Add more tools** — add a `search_academic` tool using Semantic Scholar's API for research papers
- **Parallel research** — run sub-questions concurrently with `asyncio.gather` / `Promise.all` for faster results
- **Streaming output** — stream the report as it's generated instead of waiting for the full response

## Related Examples

- [Deep Research Agent](../../advanced/deep-research-agent) — A more advanced version with parallel search, source credibility scoring, and follow-up research
- [Customer Support Agent](../customer-support-agent) — Uses RAG instead of web search to answer questions from a knowledge base
