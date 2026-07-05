# Codebase RAG

> Index a local codebase and ask questions about it using retrieval-augmented generation with code-aware chunking.

## What You'll Learn

- Code-aware chunking -- splitting by function/class boundaries preserves semantic context
- Using two AI providers together: OpenAI for embeddings, Anthropic Claude for code understanding
- Building an in-memory vector store with ChromaDB for fast retrieval
- Interactive Q&A loop with context-grounded answers

## Architecture

```
+-----------+     +-----------+     +----------+     +---------+
| Source    | --> | Chunker   | --> | Embedder | --> | Vector  |
| Files     |     | (code-    |     | (OpenAI) |     | Store   |
|           |     |  aware)   |     |          |     |(ChromaDB)|
+-----------+     +-----------+     +----------+     +---------+
                                                          |
+-----------+     +-----------+     +----------+          |
| Answer    | <-- | Claude    | <-- | Retrieve | <--------+
| (text)    |     | (Anthropic|     | top-k    |
|           |     |  Sonnet)  |     | chunks   |
+-----------+     +-----------+     +----------+
```

## Prerequisites

- Python 3.10+ or Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)
- An [OpenAI API key](https://platform.openai.com/api-keys)

## Quick Start

### Python

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # Then add your API keys
python main.py --repo /path/to/your/project
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your API keys
npx tsx index.ts --repo /path/to/your/project
```

## How It Works

The tool walks a project directory and collects all source files, skipping common non-source directories (node_modules, .git, build artifacts) and binary or lock files. Each file is read and split into chunks that preserve semantic meaning.

The chunking strategy is the key innovation. Instead of splitting at fixed character counts, the chunker uses regex patterns to detect function and class boundaries across multiple languages (Python, JavaScript, TypeScript, Go, Rust, Java, C/C++, Ruby, PHP). When boundaries are found, the code splits at those natural breakpoints so each chunk contains a complete function or class. Files without detectable boundaries fall back to fixed-size overlapping chunks.

Each chunk carries metadata: the file path, line range, and detected language. All chunks are embedded using OpenAI's `text-embedding-3-small` model and stored in an in-memory ChromaDB collection with cosine similarity.

When you ask a question, the query is embedded with the same model and the top 10 most similar chunks are retrieved. These chunks are formatted with their source locations and sent to Claude along with your question. Claude reads the actual code context and provides grounded answers referencing file paths, function names, and line numbers.

## Why Two Providers?

OpenAI's `text-embedding-3-small` is fast, cheap, and effective for vector similarity search. Anthropic's Claude excels at reasoning about code -- understanding control flow, explaining complex logic, and connecting patterns across files. Using each provider for what it does best gives you better results than either alone.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `MODEL` | No | Chat model (default: `claude-sonnet-4-20250514`) |
| `EMBEDDING_MODEL` | No | Embedding model (default: `text-embedding-3-small`) |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point -- file discovery, chunking, indexing, Q&A loop |
| `requirements.txt` / `package.json` | Dependencies |
| `.env.example` | Environment variable template |

## Example Session

```
[  0.1s] Scanning /path/to/project for source files...
[  0.2s] Found 47 files
[  0.3s] Chunking files...
[  0.3s] Produced 184 chunks
[  0.4s] Generating embeddings...
[  1.2s] Embedding batch 1/3 (64 chunks)
[  2.1s] Embedding batch 2/3 (64 chunks)
[  2.9s] Embedding batch 3/3 (56 chunks)
[  3.1s] Storing in ChromaDB...
[  3.2s] Index built: 184 chunks from 47 files

============================================================
Codebase RAG -- Ask questions about your code
Type 'quit' or 'exit' to stop, 'help' for tips
============================================================

You: How is authentication handled?

Searching codebase...

Assistant: Authentication is handled in `src/middleware/auth.ts`
(lines 12-45). The `authenticateRequest` function extracts a
Bearer token from the Authorization header, validates it against
the database, and attaches the user object to the request...
```

## Troubleshooting

**Large repos take a long time to index.** The bottleneck is embedding generation. A repo with 500 files might produce 2000+ chunks and take 30-60 seconds to embed. Consider narrowing the scope by pointing `--repo` at a subdirectory.

**Out of memory.** ChromaDB runs in-memory. Very large codebases (10,000+ chunks) may need significant RAM. For production use, switch to a persistent ChromaDB instance or use Qdrant.

**Binary files cause errors.** The tool filters by file extension, but some files with supported extensions may contain binary content. These are caught by the UTF-8 read error handler and skipped.

**Embedding API rate limits.** If you hit OpenAI rate limits, the batch size (64 chunks per request) can be reduced in the source code. Look for `EMBEDDING_BATCH_SIZE`.

## Extend This Example

- Add persistent storage -- swap in-memory ChromaDB for a persistent collection so you do not re-index every time
- Support GitHub URLs -- clone a repo to a temp directory and index it
- Add re-ranking -- use a cross-encoder model to re-rank retrieved chunks before sending to Claude
- Stream responses -- use Claude streaming to show answers as they generate
- Add conversation memory -- track previous Q&A pairs for multi-turn follow-up questions

## Related Examples

- [PDF Chatbot](../pdf-chatbot) -- RAG over PDF documents instead of code
- [Agentic RAG](../agentic-rag) -- Smart routing that decides when to retrieve vs answer directly
- [Customer Support Agent](../../agents/starter/customer-support-agent) -- RAG with a knowledge base and escalation logic
