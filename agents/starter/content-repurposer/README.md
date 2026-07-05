# Content Repurposer

> Takes a blog post URL and turns it into multiple content formats -- Twitter thread, LinkedIn post, email newsletter, and key takeaways -- in a single pass.

## What You'll Learn

- Using Reader to convert any web page into clean markdown for LLM consumption
- Single-prompt content generation across multiple formats and tones
- CLI design with format selection and file output
- Working with Anthropic's Claude API for creative writing tasks

## Architecture

```
User provides blog post URL
    |
    v
Reader (r.reader.dev) fetches article as clean markdown
    |
    v
Claude repurposes into selected formats:
    -> Twitter/X thread (5-10 tweets)
    -> LinkedIn post (professional tone)
    -> Email newsletter excerpt
    -> Key takeaways (bullet list)
    |
    v
Output: All formats in one structured response
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- Anthropic API key -- get one at [console.anthropic.com](https://console.anthropic.com/)
- No Reader API key needed -- the free endpoint at `r.reader.dev` requires no signup

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env  # Then add your Anthropic API key
python main.py "https://example.com/blog-post"
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your Anthropic API key
npx tsx index.ts "https://example.com/blog-post"
```

## How It Works

The agent has two steps: **read** and **repurpose**. First, it sends the URL to Reader's free endpoint at `r.reader.dev`, which strips away navigation, ads, and boilerplate, returning clean markdown of just the article content. This is far better than feeding raw HTML to an LLM -- you get a smaller, cleaner input that produces higher-quality output.

Second, the agent sends the markdown to Claude with a carefully structured system prompt. Instead of making separate API calls for each format, it asks for all formats in a single request. This is both faster and cheaper. The system prompt includes specific constraints for each format -- tweet character limits, LinkedIn word count targets, email newsletter structure -- so Claude produces platform-appropriate content without extra rounds.

The `--format` flag lets you request only the formats you need. If you only want a Twitter thread, there is no reason to pay for generating all four formats. The agent builds its system prompt dynamically based on which formats are selected, keeping the prompt focused and the output relevant.

Long articles are truncated to 50,000 characters before being sent to Claude. This keeps costs predictable and avoids context window issues. For most blog posts (under 5,000 words), the full article is sent without truncation.

Why Claude for this task? Content repurposing requires understanding tone, audience, and platform conventions -- areas where Claude excels. The temperature is set to 0.7, giving the model enough creative freedom to adapt the writing style for each platform while staying faithful to the source material. A typical blog post costs roughly $0.01-0.03 per repurposing run.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `MODEL` | No | Override the model (default: `claude-sonnet-4-20250514`) |

Reader requires no configuration -- the `r.reader.dev` endpoint is free and keyless.

## Key Files

| File | Purpose |
| --- | --- |
| `main.py` / `index.ts` | Entry point, CLI parsing, and orchestration |
| -- | `fetch_article` / `fetchArticle` reads the URL via Reader |
| -- | `repurpose_content` / `repurposeContent` sends markdown to Claude |
| -- | `build_system_prompt` / `buildSystemPrompt` constructs format-specific instructions |

## CLI Usage

```bash
# Repurpose into all formats (default)
python main.py "https://example.com/blog-post"

# Request specific formats only
python main.py "https://example.com/blog-post" --format twitter,linkedin

# Save output to a file
python main.py "https://example.com/blog-post" --output repurposed.md

# Combine flags
python main.py "https://example.com/blog-post" --format email,takeaways --output newsletter.md

# Interactive mode (prompts for URL)
python main.py
```

## Example Output

```
🚀 Starting content repurposer...
🔗 Source URL: https://example.com/future-of-remote-work
🤖 Model: claude-sonnet-4-20250514
📋 Formats: Twitter/X thread, LinkedIn post, Email newsletter, Key takeaways

📖 Fetching article via Reader: https://example.com/future-of-remote-work
✅ Article fetched: ~2,340 words

🤖 Sending to Claude (claude-sonnet-4-20250514) for repurposing...
📝 Requested formats: twitter, linkedin, email, takeaways
📊 Tokens used: 3,821 in / 1,456 out

============================================================

✅ Content repurposed successfully!

## TWITTER THREAD

1/ Remote work isn't dying -- it's evolving.

Companies demanding full RTO are losing their best talent to competitors
who figured out async-first culture. Here's what the data shows:

2/ A Stanford study found hybrid workers are 25% more productive than
full-time office workers. The key? Autonomy over when deep work happens.

3/ ...

## LINKEDIN POST

The future of work isn't about where you sit. It's about how you think.

After analyzing 50+ companies that went remote-first in 2023, one pattern
stands out: the winners all invested in async communication before tools.

...

#RemoteWork #FutureOfWork #Leadership #AsyncFirst #Productivity

## EMAIL NEWSLETTER

**Subject line:** The remote work debate is missing the point
**Preview text:** It was never about the office. Here's what actually matters.

The remote vs. office debate keeps raging, but most companies are asking
the wrong question...

...

## KEY TAKEAWAYS

- 🏠 Hybrid workers show 25% higher productivity than full-time office workers
- 💬 Async-first communication matters more than any specific tool choice
- 📊 Companies with clear remote policies see 40% lower attrition
- 🛠️ Investing in async tools before mandating remote work is critical
- 🧠 Deep work scheduling autonomy is the top driver of knowledge worker satisfaction
- ...

============================================================

🎯 Source: https://example.com/future-of-remote-work
📄 Generated 4 format(s): twitter, linkedin, email, takeaways
```

## Extend This Example

- **Add more formats** -- add a podcast script outline, YouTube description, or Reddit post format
- **Batch processing** -- accept a list of URLs and repurpose them all, saving each to a separate file
- **Tone customization** -- add a `--tone` flag (casual, professional, academic) that adjusts all formats

## Related Examples

- [Research Agent](../research-agent) -- Uses web search and page reading for deep research on a topic
- [Web Scraping Agent](../web-scraping-agent) -- Extracts structured data from web pages
- [Newsletter Curator](../newsletter-curator) -- Curates and summarizes multiple articles into a newsletter
