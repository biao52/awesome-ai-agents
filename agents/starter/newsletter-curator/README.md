# Newsletter Curator

An agent that reads multiple blog posts and web pages, analyzes their content, and curates a polished newsletter digest with the most interesting items.

## What You'll Learn

- Batch URL reading with Reader for parallel content fetching
- Two-phase AI pipeline: per-article extraction then cross-article curation
- Relevance scoring and ranking to select the best content
- Structured JSON output from LLMs for intermediate processing

## Architecture

```
User provides list of URLs (CLI args or file)
    |
    v
Phase 1 -- Parallel Fetch (Reader):
    URLs --> Reader API (api.reader.dev/v1/read) --> clean markdown per page
    (all fetched concurrently via asyncio.gather / Promise.all)
    |
    v
Phase 2 -- Extract & Rank (OpenAI, parallel):
    For each article:
        --> Extract title, key points, summary
        --> Score relevance (1-10)
        --> Categorize (tech, business, science, etc.)
    Sort by relevance score
    |
    v
Phase 3 -- Curate (OpenAI, single prompt):
    Top articles --> Generate newsletter with:
        Subject line, intro, 5-7 item summaries, closing
    |
    v
Output: Formatted newsletter digest (markdown)
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- OpenAI API key -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- Reader API key from [reader.dev](https://reader.dev) -- sign up to get your key

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env  # Then add your OpenAI + Reader API keys
python main.py "https://simonwillison.net" "https://blog.pragmaticengineer.com" "https://martinfowler.com"
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your OpenAI + Reader API keys
npx tsx index.ts "https://simonwillison.net" "https://blog.pragmaticengineer.com" "https://martinfowler.com"
```

## How It Works

The agent operates in three phases. First, it fetches all provided URLs through the Reader API (`api.reader.dev/v1/read`), which converts any web page into clean, LLM-friendly markdown. This happens in parallel -- all URLs are fetched concurrently, so 10 URLs take roughly the same time as 1. Reader handles JavaScript rendering, cookie banners, and messy HTML automatically.

Second, the agent sends each article's content to OpenAI for structured extraction. The model identifies the title, pulls out 3-5 key takeaways, writes a brief summary, and assigns a relevance score from 1-10. This phase also runs in parallel -- each article is analyzed independently. If a `--topic` flag is set, the model biases relevance scores toward articles matching that theme.

Third, the agent takes all analyzed articles (sorted by relevance) and makes a single curation call. This prompt asks the model to select the best 5-7 items and compose them into a newsletter with a catchy subject line, intro paragraph, per-item summaries with "why it matters" context, and a closing call to action. The two-phase design is important: extraction is embarrassingly parallel and can use a cheaper model, while curation needs the full picture to make good editorial decisions.

Failed URLs are handled gracefully. If Reader cannot fetch a page (timeout, 404, etc.), the article is skipped and noted in the output. The curation phase only sees articles that were successfully fetched and analyzed.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `READER_API_KEY` | Yes | Your Reader API key -- get one at [reader.dev](https://reader.dev) |
| `MODEL` | No | Override the model (default: `gpt-4o-mini`) |

## Key Files

| File | Purpose |
| --- | --- |
| `main.py` / `index.ts` | Entry point, CLI parsing, and three-phase pipeline |
| -- | `fetch_all_urls` / `fetchAllUrls`: parallel Reader fetching |
| -- | `extract_all` / `extractAll`: parallel AI analysis |
| -- | `curate_newsletter` / `curateNewsletter`: final digest generation |

## CLI Usage

```bash
# Pass URLs directly as arguments
python main.py "https://example.com/post1" "https://example.com/post2" "https://example.com/post3"

# Load URLs from a file (one per line, # comments supported)
python main.py --urls urls.txt

# Set a newsletter topic to focus the curation
python main.py --urls urls.txt --topic "AI and machine learning"

# Save the output to a file
python main.py --urls urls.txt --output digest.md

# Combine everything
python main.py "https://extra-url.com" --urls urls.txt --topic "DevOps" --output newsletter.md
```

### TypeScript

```bash
# Same interface, just use npx tsx
npx tsx index.ts "https://example.com/post1" "https://example.com/post2"

# With all flags
npx tsx index.ts --urls urls.txt --topic "AI" --output digest.md
```

### URLs File Format

Create a `urls.txt` file with one URL per line. Lines starting with `#` are treated as comments.

```
# Tech blogs
https://simonwillison.net
https://blog.pragmaticengineer.com
https://martinfowler.com

# AI/ML sources
https://lilianweng.github.io
https://karpathy.github.io
```

## Example Output

```
🚀 Starting Newsletter Curator...
📋 Processing 8 URLs
🏷️  Topic: AI and machine learning
🤖 Model: gpt-4o-mini

📡 Fetching 8 URLs via Reader...
✅ Successfully fetched 7 pages
⚠️  Failed to fetch 1 pages: https://broken-link.example.com

🔍 Analyzing articles with AI...
    [9/10] New Breakthroughs in Transformer Architecture
    [8/10] Open Source LLM Fine-Tuning Guide
    [8/10] The State of AI Infrastructure in 2025
    [7/10] Building Production RAG Systems
    [6/10] Weekly Roundup: Tech Industry News
    [4/10] Company Launches New Marketing Platform
    [0/10] https://broken-link.example.com

📝 Curating newsletter digest...

============================================================
✅ Newsletter ready!

# AI & ML Weekly: Transformer Breakthroughs and the Open Source Push

Welcome to this week's roundup of the most important developments...

## New Breakthroughs in Transformer Architecture
Researchers at ... announced a novel attention mechanism that reduces
compute requirements by 40% while maintaining accuracy...

**Why it matters:** This could dramatically lower the cost of training
and running large models, making AI more accessible to smaller teams.

[Read more](https://example.com/transformers)

...

## Closing
That wraps up this week's digest. Hit reply to share what caught
your eye, or forward this to a colleague who would find it useful.
```

## Extend This Example

- **Add email delivery** -- integrate with SendGrid or Resend to email the newsletter directly to subscribers
- **Schedule with cron** -- wrap this in a cron job or GitHub Action to auto-curate a weekly digest from a fixed URL list
- **Add RSS feed support** -- parse RSS/Atom feeds to automatically discover new posts from favorite sources
- **Custom scoring** -- add your own relevance criteria beyond the AI score (e.g., prefer recent posts, boost certain domains)

## Related Examples

- [Research Agent](../research-agent) -- Uses web search to research a topic in depth
- [Content Repurposer](../content-repurposer) -- Takes a single piece of content and transforms it into multiple formats
- [Fact Checker](../fact-checker) -- Verifies claims in an article against multiple sources
