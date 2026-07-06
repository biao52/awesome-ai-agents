# Paper Summarizer

> An agent that reads research papers via URLs and produces structured summaries with key findings, methodology, and significance.

## What You'll Learn

- Using Reader (reader.dev) to convert any web page into clean markdown for LLM consumption
- Structured summarization with consistent output sections
- Batch processing multiple papers with error handling and retries
- Building a CLI agent with both direct and interactive modes

## Architecture

```
User provides paper URLs (arxiv, blogs, any URL)
    |
    v
For each URL:
    --> Reader API (api.reader.dev/v1/read) converts page to markdown
    --> OpenAI summarizes the markdown content
    --> Structured summary with 9 sections
    |
    v
Output: Markdown document with all summaries
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- OpenAI API key -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- **Reader API key** -- sign up at [reader.dev](https://reader.dev) (used for web reading)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env  # Then add your OpenAI + Reader API keys
python main.py "https://arxiv.org/abs/2401.02954"
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your OpenAI + Reader API keys
npx tsx index.ts "https://arxiv.org/abs/2401.02954"
```

## How It Works

The agent has two stages: fetching and summarization. For each URL you provide, it calls the Reader API (`api.reader.dev/v1/read`) to convert the web page into clean markdown. This is the key insight -- LLMs work much better with markdown than raw HTML. Reader handles all the complexity of rendering JavaScript, stripping navigation and ads, and extracting the article content. No HTML parsing code needed on your end.

Once the agent has clean markdown, it sends the content to OpenAI with a structured system prompt that instructs the model to extract nine specific sections: title, authors, publication info, research question, methodology, key findings, limitations, significance, and related work. The low temperature (0.2) keeps the output factual and consistent.

Both the Reader fetch and the OpenAI call have retry logic with exponential backoff. If Reader times out (some pages are slow to render), the agent waits and tries again up to 3 times. Same for the summarization call. When processing multiple papers, failures on one paper don't block the rest -- the agent reports which papers succeeded and which failed.

The output is a single markdown document. For one paper, you get the summary directly. For multiple papers, you get a combined document with a section per paper. The `--output` flag saves to a file, which is useful for building up a collection of summaries.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `READER_API_KEY` | Yes | Your Reader API key -- get one at [reader.dev](https://reader.dev) |
| `MODEL` | No | Override the model (default: `gpt-4o-mini`) |

## Key Files

| File | Purpose |
| --- | --- |
| `main.py` / `index.ts` | Entry point, CLI parsing, and orchestration |
| -- | `fetchPaper` / `fetch_paper` fetches markdown via Reader |
| -- | `summarizeContent` / `summarize_content` calls OpenAI for structured summary |

## CLI Usage

```bash
# Summarize a single paper
python main.py "https://arxiv.org/abs/2401.02954"

# Summarize multiple papers
python main.py "https://arxiv.org/abs/2401.02954" "https://arxiv.org/abs/2312.00752"

# Save output to a file
python main.py "https://arxiv.org/abs/2401.02954" --output summary.md

# Interactive mode -- prompts for URLs
python main.py
```

Works with any URL that has text content -- arxiv papers, blog posts, documentation pages, news articles.

## Example Output

```
🚀 Starting paper summarizer...
📋 Papers to summarize: 1
🤖 Model: gpt-4o-mini

📄 [1/1] Fetching: https://arxiv.org/abs/2401.02954
    [1/1] Got 42,381 chars of markdown
🤖 [1/1] Summarizing...
✅ [1/1] Done

============================================================
✅ Complete! 1 summarized, 0 failed.

## Title
Mixtral of Experts

## Authors
Albert Q. Jiang, Alexandre Sablayrolles, ...

## Research Question
How can sparse mixture-of-experts architectures achieve strong
performance while keeping inference costs low?

## Key Findings
- Mixtral 8x7B matches or exceeds Llama 2 70B on most benchmarks
- Uses only 13B active parameters per token despite having 47B total
- ...
```

## Cost Estimate

Each paper summary costs roughly $0.003-$0.008 with gpt-4o-mini, depending on paper length. A batch of 10 papers typically costs under $0.05. Reader API pricing is available at [reader.dev](https://reader.dev).

If you switch to gpt-4o for higher quality summaries, expect roughly 10x the cost per paper (~$0.03-$0.08). For most papers, gpt-4o-mini produces summaries that are accurate and well-structured enough.

The main variable is paper length. A 5-page workshop paper might cost $0.002 to summarize. A 50-page survey with extensive related work could cost $0.01+. The agent truncates content at 80,000 characters to avoid unexpectedly large bills.

## Extend This Example

- **Reading list tracker** -- store summaries in a local database and build a searchable reading list
- **Citation extraction** -- add a second LLM pass to extract all references into a structured bibliography
- **Comparison mode** -- feed multiple paper summaries back to the LLM to produce a comparative analysis
- **Slack/Discord bot** -- wrap the agent in a bot that summarizes papers when someone posts a link
- **Auto-categorization** -- add topic classification (NLP, CV, RL, etc.) to each summary

## How Reader Works

Reader is the web reading provider that powers this agent. When you call the Reader API at `api.reader.dev/v1/read`, Reader fetches the page (including JavaScript-rendered content), strips out navigation, ads, and boilerplate, and returns just the article content as clean markdown. This matters because:

1. **Arxiv pages** are rendered with JavaScript and have complex LaTeX -- Reader handles both
2. **Blog posts** have headers, footers, sidebars, and cookie banners -- Reader strips all of that
3. **The output is markdown**, which is what LLMs are best at understanding

Get your API key at [reader.dev](https://reader.dev) for full access.

## Troubleshooting

- **Empty summaries**: Some pages block automated requests. Try a different URL or check if the page is behind a login wall.
- **Timeout errors**: Large papers can take 30-60 seconds to process through Reader. The agent retries automatically up to 3 times.
- **Truncated content**: Papers longer than ~80,000 characters are truncated before summarization. The summary will note this.
- **Rate limiting**: If you process many papers quickly, you may hit rate limits. Add a short delay between papers or upgrade your Reader plan.

## Related Examples

- [Research Agent](../research-agent) -- Takes a topic, searches the web, and produces a research report with citations
- [Web Scraping Agent](../web-scraping-agent) -- Extracts structured data from any web page
