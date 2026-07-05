# Content Pipeline

> A multi-agent content creation system where a Researcher, Writer, and Editor collaborate to produce polished content -- from research to final draft with editorial review and revision loops.

## What You'll Build

A CLI tool that takes a content brief (topic, audience, format, tone) and runs it through a 3-agent pipeline. The Researcher gathers current information from the web, the Writer produces a first draft, and the Editor reviews it for quality. If the Editor isn't satisfied, the Writer revises based on specific feedback. The output is a publication-ready content piece.

## What You'll Learn

- How to orchestrate multiple agents in a sequential pipeline
- How to design distinct agent personalities with specialized system prompts
- How to implement a revision loop (Editor -> Writer -> Editor)
- How to pass context between agents (research brief, content brief, draft)
- How to build quality gates in multi-agent systems

## Architecture

```
User provides content brief:
    topic + audience + format + tone
    ↓
RESEARCHER AGENT (Claude):
    → Searches web via Tavily (3 queries)
    → Extracts facts, stats, quotes
    → Produces structured research brief
    ↓
WRITER AGENT (Claude):
    → Takes content brief + research brief
    → Writes first draft (800-1200 words)
    ↓
EDITOR AGENT (Claude):                    ┐
    → Reviews draft against brief         │
    → Checks facts against research       │ Revision
    → Scores quality (1-10)               │ loop
    → Verdict: APPROVED or NEEDS REVISION │ (max 2
    ↓                                     │ rounds)
If NEEDS REVISION:                        │
    → Writer revises with feedback ───────┘
    ↓
Output: Final draft + research notes + revision history
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
- **Tavily API key** -- get one at [tavily.com](https://tavily.com) (free tier available)
- **Estimated cost:** ~$0.08-0.15 per content piece (3-5 API calls with Sonnet)

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

5. Run the pipeline:
   ```bash
   python main.py --topic "AI in Healthcare" --audience "CTOs" --format "blog post" --tone "professional"
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

5. Run the pipeline:
   ```bash
   npx tsx index.ts --topic "AI in Healthcare" --audience "CTOs" --format "blog post" --tone "professional"
   ```

## How It Works

The key design pattern here is **specialized agents with handoffs**. Each agent has a focused system prompt defining its role, personality, and output format. The Researcher is factual and source-focused. The Writer is creative and audience-aware. The Editor is critical and detail-oriented. This separation produces better results than a single "do everything" prompt.

The revision loop is what elevates this from a simple chain to a quality-controlled pipeline. The Editor's review includes a verdict: APPROVED or NEEDS REVISION. If revision is needed, the Editor's specific feedback (accuracy issues, structural problems, tone mismatches, line edits) is passed to the Writer along with the original brief and research. The Writer then revises, and the Editor reviews again. This runs for up to 2 rounds, mimicking a real editorial process.

Context flows forward through the pipeline. The Writer receives both the content brief (what to write) and the research brief (what we know). The Editor receives all three: brief, research, and draft. This ensures the Editor can fact-check claims against the research and verify the draft matches the original brief. During revision, the Writer also sees the Editor's feedback, creating a focused revision cycle.

All agents use the same Claude model, but with different temperatures. The Researcher uses 0.3 (focused, factual), the Writer uses 0.6 (creative but grounded), and the Editor uses 0.3 (consistent, analytical). The Editor's lower temperature ensures reliable quality scoring.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `TAVILY_API_KEY` | Yes | -- | Your Tavily API key for research |
| `MODEL` | No | `claude-sonnet-4-20250514` | Override the Claude model |
| `MAX_REVISION_ROUNDS` | No | `2` | Max Editor-Writer revision cycles |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Full pipeline: research, write, edit/revise loop |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Full pipeline with all options
python main.py --topic "AI in Healthcare" --audience "CTOs" --format "blog post" --tone "professional"

# Save to file
python main.py --topic "Remote Work Trends" --audience "HR managers" --format "newsletter" --tone "casual" --output article.md

# Interactive mode (prompts for each field)
python main.py
```

## Common Issues & Troubleshooting

**Draft is too short/long**
- The system prompt specifies 800-1200 words. Adjust the word count in the content brief if needed.
- Longer content works better with more research data.

**Editor never approves**
- The Editor has high standards. If it always requests revisions, check that the Writer's output matches the brief's format and tone.
- Set `MAX_REVISION_ROUNDS=1` for faster iteration.

**Research quality is poor**
- Tavily's free tier has limited results. Some niche topics may have sparse coverage.
- The Researcher only gets snippets, not full articles. For deeper research, combine with the Deep Research Agent.

## Extend This Example

- **Add a Publisher agent** -- formats the final draft for a specific platform (Medium, LinkedIn, email newsletter)
- **Add image suggestions** -- have the Editor suggest where images should go and describe them for AI image generation
- **Add SEO optimization** -- add an SEO agent that reviews keywords, meta descriptions, and heading structure
- **Multiple formats** -- generate the same research into multiple formats simultaneously (blog + tweet thread + email)
- **Human-in-the-loop** -- pause before the Writer revises and let a human approve or override the Editor's feedback

## Related Examples

- [Deep Research Agent](../../agents/advanced/deep-research-agent) -- The research phase here is simplified; use this for deeper research
- [Software Dev Team](../software-dev-team) -- Similar multi-agent pipeline but for code instead of content
- [Newsletter Curator Agent](../../agents/starter/newsletter-curator) -- Uses Reader to curate content rather than create it
