# Documentation Q&A

> Crawl any docs site, build a searchable knowledge base, and answer questions -- zero config, just pass a URL.

## What You'll Learn

- Using Reader to convert live web pages into clean markdown for LLM consumption
- Building a RAG pipeline from scratch: crawl, chunk, embed, search, answer
- Link extraction and same-domain crawling to discover documentation pages
- Parallel page fetching with concurrency limits
- Interactive conversational Q&A over a custom knowledge base

## Architecture

```
User provides docs URL
    |
    v
Read start page via Reader (r.reader.dev)
    |
    v
Extract same-domain links from markdown
    |
    v
Read linked pages in parallel (up to 20 pages)
    |
    v
Chunk all content (512 chars, 64 overlap)
    |
    v
Embed chunks with OpenAI (text-embedding-3-small)
    |
    v
Store in ChromaDB (in-memory, cosine similarity)
    |
    v
Interactive Q&A loop:
    User question -> embed -> vector search -> top-5 context -> LLM answer
```

## Prerequisites

- Python 3.10+ or Node.js 20+
- OpenAI API key -- get one at [platform.openai.com](https://platform.openai.com)
- Reader handles all web page reading (free, no key needed)
- ChromaDB runs in-memory for Python; requires a local server for TypeScript (see setup below)

## Quick Start

### Python

```bash
cd python
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY

python main.py --url "https://docs.example.com"
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY

# ChromaDB requires a running server for the JS client:
# In a separate terminal: pip install chromadb && chroma run

npx tsx index.ts --url "https://docs.example.com"
```

## How It Works

The agent starts by reading the provided URL through Reader, which converts the live web page into clean markdown. It then extracts all markdown-style links from the content and filters them to same-domain URLs, giving you a list of documentation pages to index.

Next, it reads up to 20 of those linked pages in parallel (with a concurrency limit of 5 to avoid hammering the server). Each page goes through Reader, so you get clean markdown regardless of what the original HTML looks like -- JavaScript-rendered SPAs, complex layouts, navigation chrome -- all stripped away.

All the collected markdown gets chunked into 512-character segments with 64-character overlap, then embedded using OpenAI's `text-embedding-3-small` model. The embeddings are stored in a ChromaDB collection with cosine similarity. When you ask a question, the query is embedded, the top 5 most relevant chunks are retrieved, and GPT-4o-mini generates an answer grounded in that context.

The conversation history is maintained across turns, so follow-up questions work naturally. The LLM is instructed to cite source URLs and to be honest when the indexed documentation does not contain enough information to answer.

## Why Reader?

Reader converts any web page to clean markdown with a single GET request -- no API key, no browser automation, no HTML parsing on your end. It handles JavaScript rendering, strips navigation and boilerplate, and returns just the content. This means the crawl step is a simple HTTP call per page rather than a Playwright/Puppeteer setup.

The link extraction step also benefits: since Reader returns markdown, you can find all internal links with a simple regex for `[text](url)` patterns instead of parsing raw HTML with BeautifulSoup or Cheerio.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `MODEL` | No | Chat model (default: `gpt-4o-mini`) |
| `EMBEDDING_MODEL` | No | Embedding model (default: `text-embedding-3-small`) |

### CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | (required) | The docs site URL to crawl |
| `--max-pages` | `20` | Maximum number of pages to read |

## Key Files

| File | Purpose |
|------|---------|
| `python/main.py` | Full Python implementation: crawl, index, Q&A loop |
| `typescript/index.ts` | Full TypeScript implementation: same functionality |

## Example Session

```
$ python main.py --url "https://docs.example.com"

=== Documentation Q&A ===
Crawling: https://docs.example.com
Max pages: 20

[10:32:15] [INFO] Starting crawl from https://docs.example.com
[10:32:15] [INFO] Reading start page...
[10:32:17] [INFO] Start page loaded (4523 chars)
[10:32:17] [INFO] Found 34 same-domain links
[10:32:17] [INFO] Will read 19 linked pages (max 20 total)
[10:32:17] [INFO] Reading page 1/19: https://docs.example.com/getting-started
...
[10:32:45] [INFO] Crawl complete: 18 pages loaded
[10:32:47] [INFO] Indexed 142 chunks into vector store

Ready! 18 pages indexed.
Ask questions about the documentation.

You: How do I authenticate API requests?
Assistant: Based on the docs, authentication uses Bearer tokens...

You: What rate limits apply?
Assistant: The documentation describes three tiers of rate limiting...
```

## Cost Estimate

- Crawling 20 pages: free (Reader has no cost for GET requests)
- Embedding 150 chunks: ~$0.002 (text-embedding-3-small is $0.02 per 1M tokens)
- Each Q&A turn: ~$0.001 (gpt-4o-mini with context)
- A full session with 10 questions costs roughly $0.01

## Project Structure

```
docs-qa/
  python/
    main.py              # Agent implementation
    requirements.txt     # Python dependencies
    .env.example         # Environment template
  typescript/
    index.ts             # Agent implementation
    package.json         # Node dependencies
    tsconfig.json        # TypeScript config
    .env.example         # Environment template
```

## Extend This Example

- Add recursive crawling: follow links found on second-level pages for deeper coverage
- Persist the ChromaDB collection to disk so you can skip re-crawling on subsequent runs
- Add sitemap.xml parsing as an alternative link discovery method
- Support multiple start URLs to index docs spread across subdomains
- Add a `--query` flag for single-shot mode (no interactive loop)

## Related Examples

- [Agentic RAG](../agentic-rag) -- Smart routing that decides when to retrieve vs answer directly
- [PDF Chatbot](../pdf-chatbot) -- Same Q&A pattern but over uploaded PDF files
- [Codebase RAG](../codebase-rag) -- RAG over source code with language-aware chunking

## License

MIT
