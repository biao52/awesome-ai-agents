# Customer Support Agent

> A conversational support agent that answers customer questions from a knowledge base using RAG, maintains conversation memory, and escalates to humans when it can't help.

## What You'll Build

An interactive CLI support chatbot that loads a knowledge base (markdown articles), indexes them into a vector store, and answers customer questions by searching for relevant content first. It handles multi-turn conversations, cites its sources, and can create escalation tickets when it needs to hand off to a human.

## What You'll Learn

- How to build a RAG (Retrieval-Augmented Generation) pipeline from scratch
- How to use OpenAI embeddings + ChromaDB for semantic search
- How to implement multi-turn conversation memory in an agent loop
- How to use tool calling for structured actions (search + escalation)
- How to design escalation logic so the agent knows when to hand off

## Architecture

```
Knowledge base (5 markdown articles)
    ↓ (startup: chunk + embed + index)
ChromaDB in-memory vector store
    ↓
User asks a question
    ↓
Agent calls search_knowledge_base tool:
    → Embed query with OpenAI
    → Vector similarity search in ChromaDB
    → Return top 3 relevant chunks with sources
    ↓
Agent generates answer citing sources
    ↓
If knowledge base can't answer OR user asks for human:
    → Agent calls create_escalation_ticket tool
    → Returns ticket ID to user
    ↓
Conversation history maintained for follow-up questions
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **OpenAI API key** -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- **Estimated cost:** ~$0.001-0.005 per question (embeddings + gpt-4o-mini are very cheap)
- **No external services needed** -- ChromaDB runs in-memory, no database to set up

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

4. Open `.env` and add your OpenAI API key.

5. Start the support chat:
   ```bash
   python main.py
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

4. Open `.env` and add your OpenAI API key.

5. Start the support chat:
   ```bash
   npx tsx index.ts
   ```

## How It Works

This agent demonstrates the **RAG (Retrieval-Augmented Generation) pattern** -- the most important pattern for grounding LLM responses in factual data. Instead of relying on the model's training data (which might be wrong or outdated), the agent searches a knowledge base for relevant content and uses that to generate accurate, cited answers.

At startup, the agent loads all markdown files from the `knowledge_base/` directory, splits them into ~800-character chunks with 100-character overlap, generates embeddings using OpenAI's `text-embedding-3-small` model, and stores them in an in-memory ChromaDB collection. This takes 2-3 seconds. No external database is needed -- ChromaDB runs entirely in-process.

When a user asks a question, the agent uses OpenAI function calling to invoke `search_knowledge_base`. The tool embeds the query, runs a cosine similarity search against the stored chunks, and returns the top 3 most relevant sections with their source filenames. The agent then crafts a response citing the sources ("According to our Returns Policy...").

The escalation system uses a second tool: `create_escalation_ticket`. The system prompt defines clear triggers: customer asks for a human, account-specific requests, billing disputes over $100, security concerns, or bug reports. When triggered, the agent creates a ticket with a unique ID, category, and priority. Conversation history is maintained throughout -- the agent remembers earlier context for follow-up questions.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `MODEL` | No | `gpt-4o-mini` | Override the chat model |
| `EMBEDDING_MODEL` | No | `text-embedding-3-small` | Override the embedding model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: KB loading, vector indexing, agent loop, conversation |
| `../knowledge_base/*.md` | Sample knowledge base articles (5 files) |
| `.env.example` | Template for required environment variables |

## Knowledge Base Articles

| File | Contents |
|------|----------|
| `returns-policy.md` | Return windows, process, exceptions, defective items |
| `shipping-info.md` | Shipping methods, costs, tracking, international |
| `pricing-faq.md` | Plans (Free/Pro/Enterprise), billing, upgrades |
| `technical-specs.md` | API overview, rate limits, SDKs, webhooks |
| `troubleshooting.md` | Common errors (401, 429, 500), account issues |

## CLI Usage

```bash
# Start interactive support session
python main.py

# Show help
python main.py --help
```

**Example conversation:**

```
🚀 Starting customer support agent...
📚 Loaded 24 chunks from knowledge base
🔗 Generating embeddings for 24 chunks...
✅ Knowledge base indexed and ready!

==================================================
  Welcome to Customer Support!
  Ask me anything about our products and services.
  Type 'quit' to exit.
==================================================

You: How do I return an item?

🔍 Searching KB: return item process

Agent: According to our Returns Policy, you can return most items within 30
days of delivery for a full refund. Here's how:

1. Log into your account at dashboard.example.com
2. Go to "Order History" and find the order
3. Click "Return Item" and select a reason
4. Print the prepaid shipping label
5. Drop the package at any authorized shipping location

Refunds are processed within 5-7 business days after we receive the item.
Please note that items must be in original packaging and unused condition.

You: What if the item is defective?

Agent: Great question! If you received a defective item, the process is
different and more favorable for you. Contact us within 48 hours and we will:
- Send a prepaid return label at no cost to you
- Ship a replacement immediately (or issue a full refund including shipping)
- Cover all return shipping costs

This is based on our Returns Policy's defective items section.

You: I want to talk to a human

🎫 Creating escalation ticket (other, normal)

Agent: I completely understand. I've created an escalation ticket for you:
Ticket ESC-847291. A support specialist will follow up within 24 hours.
Is there anything else I can help with in the meantime?
```

## Common Issues & Troubleshooting

**"No markdown files found in knowledge_base/"**
- Make sure you're running from the `python/` or `typescript/` directory
- The knowledge base should be at `../knowledge_base/` relative to where you run

**Slow startup**
- The first run generates embeddings for all KB chunks (~24 chunks). This takes 2-3 seconds.
- If you add many more articles, consider caching embeddings to disk.

**"Rate limit" errors**
- The agent generates embeddings per search query. With rapid questions, you might hit OpenAI's rate limit.
- Wait a moment and try again, or upgrade your OpenAI plan.

**ChromaDB import errors (TypeScript)**
- ChromaDB for JavaScript requires Node.js 18+
- Run `npm install` again to ensure all native dependencies are built

**Agent doesn't find relevant answers**
- The knowledge base only covers 5 topics. For questions outside these, the agent should offer to escalate.
- You can add more markdown files to `knowledge_base/` and restart.

## Extend This Example

- **Add more knowledge base articles** -- drop any markdown file into `knowledge_base/` and restart
- **Persistent vector store** -- switch ChromaDB to persistent mode so embeddings survive restarts
- **Add user authentication** -- track customer IDs to pull account-specific data
- **Sentiment detection** -- detect frustrated customers and auto-escalate with higher priority
- **Feedback loop** -- after each answer, ask "Was this helpful?" and log for quality improvement

## Related Examples

- [PDF Chatbot](../../../rag/pdf-chatbot) -- Similar RAG pattern but over uploaded PDFs instead of markdown files
- [Agentic RAG](../../../rag/agentic-rag) -- Advanced version with smart routing (retrieve vs answer vs clarify)
- [Conversation Memory](../../../memory/conversation-memory) -- Persistent memory that works across sessions, not just within one
