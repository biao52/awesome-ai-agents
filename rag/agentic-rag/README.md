# Agentic RAG

Smart retrieval-augmented generation that decides **when** to retrieve, answer directly, or ask for clarification -- instead of blindly retrieving on every query.

## The Problem

Traditional RAG pipelines always retrieve documents for every user question, even when retrieval is unnecessary. This leads to:

- **Wasted latency** -- embedding + vector search + LLM call for "thanks!" or "can you explain that differently?"
- **Wasted cost** -- unnecessary embedding API calls on every turn
- **Worse answers** -- irrelevant retrieved context can confuse the model
- **No clarification** -- ambiguous questions get bad retrievals instead of a simple "what do you mean?"

## The Solution

An **agentic router** that uses function calling to decide the best action for each query:

```
User Question
     |
     v
+--------------------+
|   Agent (LLM)      |
|   Decides action    |
+----+-------+-------+
     |       |       |
     v       v       v
 search   answer   ask
 kb       directly  clarification
     |       |       |
     v       v       v
  Retrieve  Use      Ask user
  + reflect context  for more
  on        already  info
  relevance in chat
```

## Architecture

The agent has three tools available via OpenAI function calling:

| Tool | When to use | Cost |
|------|------------|------|
| `search_knowledge_base` | Factual questions needing doc lookup | Embedding + vector search |
| `answer_directly` | Follow-ups, greetings, rephrasing | Zero (no retrieval) |
| `ask_clarification` | Ambiguous or vague questions | Zero (no retrieval) |

After retrieval, a **self-reflection step** evaluates whether the retrieved context is actually relevant before generating the final answer.

## How It Works

1. User sends a message
2. The LLM decides which tool(s) to call based on the conversation context
3. If `search_knowledge_base` is called:
   - The query is embedded and searched against ChromaDB
   - A reflection step evaluates if the results are relevant
   - The agent synthesizes an answer from relevant context
4. If `answer_directly` is called, the agent responds from conversation history
5. If `ask_clarification` is called, the agent asks the user for more detail
6. Conversation history is maintained across turns

This means a conversation like:

```
User: "What are the rate limits?"     -> search_knowledge_base
User: "Which plan has the most?"      -> answer_directly (info already in context)
User: "Tell me about the thing"       -> ask_clarification (too vague)
User: "The webhook retry policy"      -> search_knowledge_base
User: "Thanks!"                       -> answer_directly
```

Only 2 out of 5 turns actually hit the vector store. Traditional RAG would retrieve on all 5.

## Project Structure

```
agentic-rag/
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

## Prerequisites

- Python 3.10+ or Node.js 20+
- OpenAI API key
- ChromaDB (installed as dependency, runs in-memory for Python / requires local server for TypeScript)

## Setup -- Python

```bash
cd python
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY
```

## Setup -- TypeScript

```bash
cd typescript
npm install
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY

# ChromaDB requires a running server for the JS client:
# In a separate terminal: pip install chromadb && chroma run
```

## Usage

**Python:**

```bash
cd python
python main.py
```

**TypeScript:**

```bash
cd typescript
npx tsx index.ts
```

Both start an interactive chat session. Ask questions about the sample knowledge base (API docs, billing FAQ, getting started guide, webhooks).

## Example Session

```
You: How do I authenticate API requests?
[Searches knowledge base]
Assistant: API requests require an API key in the Authorization header...

You: What format should it be in?
[Answers directly -- info already in context]
Assistant: The format is: Authorization: Bearer rdr_your_api_key_here

You: Tell me about the limits
[Asks clarification -- "limits" is ambiguous]
Assistant: Could you clarify -- are you asking about rate limits, or request size limits?

You: Rate limits
[Searches knowledge base]
Assistant: Rate limits depend on your plan: Free gets 100/day, Pro gets 10,000/day...
```

## Key Concepts

- **Tool-based routing** -- The LLM decides the action, not hardcoded rules
- **Self-reflection** -- After retrieval, the agent evaluates context relevance
- **Conversation memory** -- Full chat history informs routing decisions
- **Multi-tool turns** -- The agent can call multiple tools in a single turn
- **Graceful degradation** -- Retries with backoff on API failures

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (required) | Your OpenAI API key |
| `MODEL` | `gpt-4o-mini` | Chat model to use |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |

## License

MIT
