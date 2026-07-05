# PDF Chatbot

A conversational RAG (Retrieval-Augmented Generation) agent that lets you upload a PDF and ask questions about it. The chatbot extracts text, builds a searchable vector index, and answers your questions with page-number citations -- all in an interactive terminal session.

## What You'll Build

A command-line chatbot that:

- Accepts any PDF file as input
- Extracts and chunks the text automatically
- Creates a searchable vector store using embeddings
- Answers questions grounded in the document content
- Maintains conversation history for follow-up questions
- Cites specific page numbers in every response

## What You'll Learn

- **RAG pipeline** -- how retrieval-augmented generation works end to end
- **PDF parsing** -- extracting structured text from PDF documents
- **Text chunking** -- splitting documents into overlapping segments for better retrieval
- **Embeddings** -- converting text into vector representations with OpenAI
- **Vector search** -- storing and querying embeddings with ChromaDB
- **Conversational memory** -- maintaining context across multiple questions

## Architecture

```
                    +------------------+
                    |    PDF File      |
                    +--------+---------+
                             |
                    +--------v---------+
                    |  Text Extraction |
                    |  (pymupdf /      |
                    |   pdf-parse)     |
                    +--------+---------+
                             |
                    +--------v---------+
                    |    Chunking      |
                    |  (800 chars,     |
                    |   100 overlap)   |
                    +--------+---------+
                             |
                    +--------v---------+
                    |   Embeddings     |
                    | (text-embedding- |
                    |  3-small)        |
                    +--------+---------+
                             |
                    +--------v---------+
                    |    ChromaDB      |
                    |  (in-memory      |
                    |   vector store)  |
                    +--------+---------+
                             |
           User question     |     Top 3 chunks
              +-------->  Retrieve  ------+
              |              |             |
              |     +--------v---------+   |
              |     |    GPT-4o-mini   |<--+
              |     |  (with context   |
              |     |   + history)     |
              |     +--------+---------+
              |              |
              +----- Answer with citations
```

## Prerequisites

- **OpenAI API key** -- get one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Python 3.10+** or **Node.js 18+**
- Estimated cost: ~$0.005 per question (embeddings + completion)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env        # add your OPENAI_API_KEY
python main.py --file /path/to/document.pdf
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env        # add your OPENAI_API_KEY
npx tsx index.ts --file /path/to/document.pdf
```

## How It Works

When you provide a PDF, the chatbot first extracts all text content page by page. For Python, it uses pymupdf (the `fitz` library) which handles complex layouts, scanned-text PDFs, and multi-column documents. The TypeScript version uses `pdf-parse` built on top of pdf.js.

The extracted text is then split into overlapping chunks of roughly 800 characters each, with a 100-character overlap between consecutive chunks. This overlap ensures that concepts spanning chunk boundaries are still captured in at least one chunk. Each chunk retains its source page number for citation purposes.

All chunks are converted into vector embeddings using OpenAI's `text-embedding-3-small` model and stored in an in-memory ChromaDB collection. When you ask a question, your query is also embedded and compared against the stored chunks using cosine similarity. The top 3 most relevant chunks are retrieved.

Finally, the retrieved chunks -- along with your question and recent conversation history -- are sent to GPT-4o-mini. The model generates a grounded answer citing specific page numbers. Conversation history is maintained so you can ask follow-up questions naturally.

## Configuration

Both implementations support these environment variables:

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | (required) | Your OpenAI API key |
| `MODEL` | `gpt-4o-mini` | Chat completion model |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |

Internal parameters (adjustable in source):

| Parameter | Default | Description |
|---|---|---|
| `CHUNK_SIZE` | 800 | Characters per chunk |
| `CHUNK_OVERLAP` | 100 | Overlap between chunks |
| `TOP_K` | 3 | Number of chunks to retrieve |
| `TEMPERATURE` | 0.3 | LLM temperature (lower = more focused) |
| `MAX_HISTORY` | 10 | Conversation turns to retain |

## Key Files

```
pdf-chatbot/
  python/
    main.py              # Full RAG pipeline + chat loop
    requirements.txt     # Python dependencies
    .env.example         # Environment template
  typescript/
    index.ts             # Full RAG pipeline + chat loop
    package.json         # Node dependencies
    tsconfig.json        # TypeScript configuration
    .env.example         # Environment template
  README.md              # This file
```

## CLI Usage

```
$ python main.py --file annual-report-2024.pdf

  PDF Chatbot starting...
  File: annual-report-2024.pdf
  Model: gpt-4o-mini
  Embeddings: text-embedding-3-small
  Extracting text from PDF...
  Extracted 42 pages (98,432 characters)
  Created 156 chunks (size=800, overlap=100)
  Generating embeddings...
  Indexed 156 chunks into ChromaDB

============================================================
  Chat with: annual-report-2024.pdf
  Type your questions. Enter "quit" or "exit" to stop.
============================================================

You: What was the total revenue for 2024?

  Searching document...
Assistant: Based on the annual report, total revenue for 2024 was $4.2 billion,
representing a 15% year-over-year increase (page 12). The growth was primarily
driven by the cloud services division which contributed $2.1 billion (page 14).

You: How does that compare to their projections?

  Searching document...
Assistant: The report notes that 2024 revenue exceeded their original projection
of $3.8 billion by approximately 10.5% (page 8). Management attributed the
outperformance to stronger-than-expected enterprise adoption (page 23).

You: quit
  Goodbye!
```

## Troubleshooting

**"OPENAI_API_KEY is not set"** -- Copy `.env.example` to `.env` and paste your API key. Make sure there are no extra spaces or quotes around the value.

**"PDF contains no extractable text"** -- The PDF might be image-based (scanned). This tool requires PDFs with selectable text. Use an OCR tool first to convert scanned PDFs.

**"Failed to open PDF"** -- Check that the file path is correct and the file is a valid PDF. Encrypted or password-protected PDFs are not supported.

**Answers seem irrelevant** -- Try adjusting `CHUNK_SIZE` (smaller chunks for precise documents, larger for narrative text) or increase `TOP_K` to retrieve more context.

**High latency** -- Each question requires an embedding call plus a chat completion call. For large PDFs, the initial indexing step takes longer due to more embedding calls. Subsequent questions are fast since the index is in memory.

## Extend This Example

- **Add a web UI** -- wrap the chat loop with a simple HTTP server and serve a chat interface
- **Support multiple PDFs** -- index several documents into the same ChromaDB collection with source metadata
- **Add re-ranking** -- use a cross-encoder model to re-rank retrieved chunks before sending to the LLM
- **Persist the index** -- save the ChromaDB collection to disk so you do not have to re-index on every run
- **Stream responses** -- use the OpenAI streaming API to show tokens as they arrive
- **Add table extraction** -- use pymupdf's table detection to handle structured data in PDFs

## Related Examples

- [Customer Support Agent](../../agents/starter/customer-support-agent) -- RAG with a knowledge base and escalation logic
- [Codebase RAG](../codebase-rag) -- RAG optimized for source code with language-aware chunking
- [Agentic RAG](../agentic-rag) -- smart routing that decides when to retrieve vs answer directly
