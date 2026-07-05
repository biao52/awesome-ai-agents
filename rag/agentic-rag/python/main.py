"""
Agentic RAG -- Smart retrieval-augmented generation that decides
when to retrieve, answer directly, or ask for clarification.

Usage:
    python main.py
"""

import asyncio
import json
import os
import sys
import time
from typing import Any

import chromadb
import openai
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL = os.getenv("MODEL", "gpt-4o-mini")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
TEMPERATURE = 0.3
CHUNK_SIZE = 512
CHUNK_OVERLAP = 64
MAX_RETRIES = 3
RETRY_DELAY = 1.0
TOP_K = 3

# ---------------------------------------------------------------------------
# Sample knowledge base (inline markdown documents)
# ---------------------------------------------------------------------------

KNOWLEDGE_BASE: list[dict[str, str]] = [
    {
        "title": "API Documentation",
        "content": """# Reader API Documentation

## Authentication

All API requests require an API key passed via the `Authorization` header:

```
Authorization: Bearer rdr_your_api_key_here
```

API keys can be generated from your dashboard at https://app.reader.dev/settings/api-keys.

## Endpoints

### POST /v1/read

Scrape and convert a web page to clean markdown.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| url | string | yes | The URL to scrape |
| format | string | no | Output format: "markdown" (default), "html", "text" |
| timeout | number | no | Timeout in milliseconds (default: 30000) |
| waitFor | string | no | CSS selector to wait for before scraping |

**Response:**

```json
{
  "success": true,
  "data": {
    "content": "# Page Title\\n\\nPage content in markdown...",
    "metadata": {
      "title": "Page Title",
      "url": "https://example.com",
      "statusCode": 200
    }
  }
}
```

### GET /v1/health

Returns API health status. No authentication required.

### POST /v1/batch

Submit multiple URLs for batch processing. Returns a job ID for polling.

## Rate Limits

- Free tier: 100 requests/day
- Pro tier: 10,000 requests/day
- Enterprise: Custom limits

Rate limit headers are included in every response:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

## Error Codes

| Code | Meaning |
|------|---------|
| 401 | Invalid or missing API key |
| 429 | Rate limit exceeded |
| 422 | Invalid request parameters |
| 502 | Target site unreachable |
| 504 | Scrape timeout |
""",
    },
    {
        "title": "Billing FAQ",
        "content": """# Billing FAQ

## Plans and Pricing

### What plans are available?

We offer three plans:

1. **Free** -- 100 requests/day, community support, single API key
2. **Pro ($29/month)** -- 10,000 requests/day, priority support, unlimited API keys, webhook notifications
3. **Enterprise (custom)** -- Custom rate limits, SLA, dedicated support, SSO, audit logs

### How do I upgrade my plan?

Go to your dashboard at https://app.reader.dev/settings/billing and click "Upgrade Plan". You can upgrade at any time and will be prorated for the remainder of your billing cycle.

### Can I get a refund?

We offer a 14-day money-back guarantee on Pro plans. Contact support@reader.dev within 14 days of your first payment.

### What payment methods do you accept?

We accept all major credit cards (Visa, Mastercard, Amex) and process payments through Stripe. Enterprise customers can pay via invoice.

## Usage and Overages

### What happens if I exceed my rate limit?

Requests beyond your rate limit will receive a 429 status code. The response includes a `Retry-After` header indicating when you can make the next request.

### Can I purchase additional requests?

Pro plan users can purchase add-on packs of 5,000 requests for $10 each. Go to Settings > Billing > Add-ons.

### How is usage calculated?

Each API call to /v1/read counts as one request, regardless of the page size. Batch API calls count each URL separately. Health check endpoints are free.

## Invoices

### Where can I find my invoices?

All invoices are available at https://app.reader.dev/settings/billing/invoices. You can also configure automatic invoice emails.

### Can I change my billing email?

Yes, go to Settings > Billing > Billing Email to update the email address where invoices are sent.
""",
    },
    {
        "title": "Getting Started Guide",
        "content": """# Getting Started with Reader

## Quick Start

### 1. Create an Account

Sign up at https://app.reader.dev/signup. You can use email/password or sign in with GitHub.

### 2. Get Your API Key

After signing in, go to Settings > API Keys and click "Generate New Key". Copy the key -- it will only be shown once.

### 3. Make Your First Request

```bash
curl -X POST https://api.reader.dev/v1/read \\
  -H "Authorization: Bearer rdr_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com"}'
```

### 4. Install an SDK (Optional)

**JavaScript/TypeScript:**
```bash
npm install @reader/sdk
```

```javascript
import { Reader } from '@reader/sdk';

const reader = new Reader({ apiKey: 'rdr_your_key' });
const result = await reader.read('https://example.com');
console.log(result.content);
```

**Python:**
```bash
pip install reader-sdk
```

```python
from reader_sdk import Reader

reader = Reader(api_key="rdr_your_key")
result = reader.read("https://example.com")
print(result.content)
```

## Common Use Cases

- **AI training data** -- Convert web pages to clean markdown for LLM fine-tuning
- **Content aggregation** -- Build feeds from multiple sources
- **Research** -- Extract and summarize articles programmatically
- **Monitoring** -- Track changes on specific web pages

## Troubleshooting

### "401 Unauthorized"
Make sure your API key starts with `rdr_` and is included in the `Authorization` header as a Bearer token.

### "504 Timeout"
Some pages take longer to load. Try increasing the `timeout` parameter (max: 60000ms). If the page requires JavaScript, the engine will wait for rendering.

### "502 Bad Gateway"
The target site may be down or blocking requests. Check if you can access the URL in your browser first.

## Need Help?

- Documentation: https://docs.reader.dev
- Email: support@reader.dev
- Discord: https://discord.gg/reader
""",
    },
    {
        "title": "Webhooks Guide",
        "content": """# Webhooks

## Overview

Webhooks let you receive real-time notifications when batch jobs complete or when monitored pages change. Available on Pro and Enterprise plans.

## Setup

### 1. Register a Webhook Endpoint

```bash
curl -X POST https://api.reader.dev/v1/webhooks \\
  -H "Authorization: Bearer rdr_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://yourapp.com/webhook",
    "events": ["batch.completed", "monitor.changed"],
    "secret": "your_webhook_secret"
  }'
```

### 2. Verify Signatures

Every webhook request includes an `X-Reader-Signature` header. Verify it using HMAC-SHA256:

```python
import hmac
import hashlib

def verify_signature(payload: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)
```

### 3. Event Types

| Event | Description |
|-------|-------------|
| batch.completed | A batch job has finished processing all URLs |
| batch.failed | A batch job encountered a fatal error |
| monitor.changed | A monitored page has changed content |
| monitor.error | A monitored page could not be reached |

### 4. Retry Policy

Failed webhook deliveries are retried up to 5 times with exponential backoff (1min, 5min, 30min, 2hr, 12hr). After all retries are exhausted, the webhook is marked as failed in your dashboard.

## Managing Webhooks

- List: `GET /v1/webhooks`
- Delete: `DELETE /v1/webhooks/{id}`
- Test: `POST /v1/webhooks/{id}/test`
""",
    },
]

# ---------------------------------------------------------------------------
# Tool definitions for OpenAI function calling
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_knowledge_base",
            "description": (
                "Search the knowledge base for relevant documentation. "
                "Use this when the user asks a factual question that requires "
                "looking up specific information from docs, guides, or FAQs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query to find relevant documents.",
                    }
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "answer_directly",
            "description": (
                "Answer the user's question directly from the conversation context "
                "without retrieving any documents. Use this for follow-up questions, "
                "greetings, simple clarifications about a previous answer, or when "
                "the answer is already present in the conversation history."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "answer": {
                        "type": "string",
                        "description": "The direct answer to the user's question.",
                    }
                },
                "required": ["answer"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_clarification",
            "description": (
                "Ask the user a clarifying question when their query is ambiguous, "
                "too vague, or could refer to multiple topics. Use this to get more "
                "context before attempting to answer."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The clarifying question to ask the user.",
                    }
                },
                "required": ["question"],
                "additionalProperties": False,
            },
        },
    },
]

SYSTEM_PROMPT = """You are a helpful support agent for the Reader API platform. You have \
access to a knowledge base of documentation, FAQs, and guides.

For each user message, decide which tool to use:

1. **search_knowledge_base** -- When the user asks a factual question that needs information \
from the docs (pricing, endpoints, authentication, setup, etc.)
2. **answer_directly** -- When you can answer from the current conversation context: \
follow-ups ("can you explain that more?"), greetings, or when the information was already \
retrieved in a prior turn.
3. **ask_clarification** -- When the question is ambiguous or too vague to answer well.

You may call multiple tools in a single turn if needed (e.g., search for info and then \
answer). Always prefer the most efficient route -- do not search if you already have the \
answer in context.

After retrieving documents, evaluate their relevance before answering. If the retrieved \
context does not sufficiently answer the question, say so honestly rather than guessing."""


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def log(message: str, level: str = "INFO") -> None:
    """Print a timestamped log message to stderr."""
    timestamp = time.strftime("%H:%M:%S")
    print(f"[{timestamp}] [{level}] {message}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> str:
    """Validate required environment variables and return the API key."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("Error: OPENAI_API_KEY environment variable is required.")
        print("Copy .env.example to .env and add your key.")
        sys.exit(1)
    return api_key


# ---------------------------------------------------------------------------
# Text chunking
# ---------------------------------------------------------------------------


def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks by character count."""
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start += chunk_size - overlap
    return chunks


# ---------------------------------------------------------------------------
# Knowledge base indexing
# ---------------------------------------------------------------------------


async def build_vector_store(client: openai.AsyncOpenAI) -> chromadb.Collection:
    """Chunk documents and embed them into a ChromaDB in-memory collection."""
    log("Building vector store from knowledge base...")

    chroma = chromadb.Client()
    collection = chroma.create_collection(
        name="knowledge_base",
        metadata={"hnsw:space": "cosine"},
    )

    all_chunks: list[str] = []
    all_ids: list[str] = []
    all_metadata: list[dict[str, str]] = []

    for doc in KNOWLEDGE_BASE:
        chunks = chunk_text(doc["content"])
        for i, chunk in enumerate(chunks):
            all_chunks.append(chunk)
            all_ids.append(f"{doc['title']}::chunk_{i}")
            all_metadata.append({"title": doc["title"], "chunk_index": str(i)})

    # Embed in batches to stay within API limits
    batch_size = 100
    all_embeddings: list[list[float]] = []

    for i in range(0, len(all_chunks), batch_size):
        batch = all_chunks[i : i + batch_size]
        for attempt in range(MAX_RETRIES):
            try:
                response = await client.embeddings.create(
                    model=EMBEDDING_MODEL,
                    input=batch,
                )
                all_embeddings.extend([e.embedding for e in response.data])
                break
            except openai.APIError as exc:
                if attempt < MAX_RETRIES - 1:
                    log(f"Embedding API error (attempt {attempt + 1}): {exc}", "WARN")
                    await asyncio.sleep(RETRY_DELAY * (attempt + 1))
                else:
                    raise

    collection.add(
        ids=all_ids,
        documents=all_chunks,
        embeddings=all_embeddings,
        metadatas=all_metadata,
    )

    log(f"Indexed {len(all_chunks)} chunks from {len(KNOWLEDGE_BASE)} documents")
    return collection


# ---------------------------------------------------------------------------
# Tool execution
# ---------------------------------------------------------------------------


async def execute_search(
    query: str,
    collection: chromadb.Collection,
    client: openai.AsyncOpenAI,
) -> str:
    """Search the vector store and return relevant chunks."""
    log(f"Searching knowledge base: '{query}'")

    for attempt in range(MAX_RETRIES):
        try:
            embedding_resp = await client.embeddings.create(
                model=EMBEDDING_MODEL,
                input=query,
            )
            query_embedding = embedding_resp.data[0].embedding
            break
        except openai.APIError as exc:
            if attempt < MAX_RETRIES - 1:
                log(f"Embedding error (attempt {attempt + 1}): {exc}", "WARN")
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
            else:
                return f"Error generating query embedding: {exc}"

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=TOP_K,
    )

    if not results["documents"] or not results["documents"][0]:
        return "No relevant documents found."

    chunks = results["documents"][0]
    metadatas = results["metadatas"][0] if results["metadatas"] else []
    distances = results["distances"][0] if results["distances"] else []

    output_parts: list[str] = []
    for i, chunk in enumerate(chunks):
        source = metadatas[i]["title"] if i < len(metadatas) else "Unknown"
        distance = f" (distance: {distances[i]:.3f})" if i < len(distances) else ""
        output_parts.append(f"--- Source: {source}{distance} ---\n{chunk}")

    return "\n\n".join(output_parts)


def execute_answer_directly(answer: str) -> str:
    """Return a direct answer (pass-through)."""
    log("Answering directly from context")
    return answer


def execute_ask_clarification(question: str) -> str:
    """Return a clarifying question."""
    log(f"Asking for clarification: '{question}'")
    return question


# ---------------------------------------------------------------------------
# Self-reflection step
# ---------------------------------------------------------------------------

REFLECTION_PROMPT = """You just retrieved the following context from the knowledge base in \
response to the user's question.

User question: {question}

Retrieved context:
{context}

Evaluate: Is this context relevant and sufficient to answer the user's question?
Respond with a JSON object:
{{"relevant": true/false, "reasoning": "brief explanation"}}"""


async def reflect_on_retrieval(
    client: openai.AsyncOpenAI,
    question: str,
    context: str,
) -> dict[str, Any]:
    """Ask the model to evaluate whether retrieved context is relevant."""
    for attempt in range(MAX_RETRIES):
        try:
            response = await client.chat.completions.create(
                model=MODEL,
                temperature=0,
                messages=[
                    {
                        "role": "user",
                        "content": REFLECTION_PROMPT.format(
                            question=question, context=context
                        ),
                    }
                ],
                response_format={"type": "json_object"},
            )
            content = response.choices[0].message.content or "{}"
            return json.loads(content)
        except (openai.APIError, json.JSONDecodeError) as exc:
            if attempt < MAX_RETRIES - 1:
                log(f"Reflection error (attempt {attempt + 1}): {exc}", "WARN")
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
            else:
                log(f"Reflection failed after retries: {exc}", "ERROR")
                return {"relevant": True, "reasoning": "Reflection unavailable"}


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------


async def agent_turn(
    client: openai.AsyncOpenAI,
    collection: chromadb.Collection,
    conversation: list[dict[str, Any]],
    user_message: str,
) -> str:
    """Process one turn of conversation with tool-use routing."""
    conversation.append({"role": "user", "content": user_message})

    for attempt in range(MAX_RETRIES):
        try:
            response = await client.chat.completions.create(
                model=MODEL,
                temperature=TEMPERATURE,
                messages=conversation,
                tools=TOOLS,
                tool_choice="auto",
            )
            break
        except openai.APIError as exc:
            if attempt < MAX_RETRIES - 1:
                log(f"Chat API error (attempt {attempt + 1}): {exc}", "WARN")
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
            else:
                error_msg = f"Sorry, I encountered an API error: {exc}"
                conversation.append({"role": "assistant", "content": error_msg})
                return error_msg

    message = response.choices[0].message

    # If no tool calls, return the direct text response
    if not message.tool_calls:
        content = message.content or ""
        conversation.append({"role": "assistant", "content": content})
        return content

    # Process tool calls
    conversation.append(message)

    tool_results: dict[str, str] = {}

    for tool_call in message.tool_calls:
        fn_name = tool_call.function.name
        fn_args = json.loads(tool_call.function.arguments)

        log(f"Tool call: {fn_name}({json.dumps(fn_args, ensure_ascii=False)[:120]})")

        if fn_name == "search_knowledge_base":
            result = await execute_search(fn_args["query"], collection, client)

            # Self-reflection: evaluate relevance
            reflection = await reflect_on_retrieval(
                client, user_message, result
            )
            if not reflection.get("relevant", True):
                log(f"Reflection: context not relevant -- {reflection.get('reasoning')}", "WARN")
                result += (
                    "\n\n[Note: The retrieved context may not be directly relevant. "
                    f"Reason: {reflection.get('reasoning', 'unknown')}. "
                    "Answer honestly if the information is insufficient.]"
                )

            tool_results[tool_call.id] = result

        elif fn_name == "answer_directly":
            tool_results[tool_call.id] = execute_answer_directly(fn_args["answer"])

        elif fn_name == "ask_clarification":
            tool_results[tool_call.id] = execute_ask_clarification(fn_args["question"])

        else:
            tool_results[tool_call.id] = f"Unknown tool: {fn_name}"

        conversation.append(
            {
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": tool_results[tool_call.id],
            }
        )

    # Get the final response after tool execution
    for attempt in range(MAX_RETRIES):
        try:
            final_response = await client.chat.completions.create(
                model=MODEL,
                temperature=TEMPERATURE,
                messages=conversation,
            )
            break
        except openai.APIError as exc:
            if attempt < MAX_RETRIES - 1:
                log(f"Final response error (attempt {attempt + 1}): {exc}", "WARN")
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
            else:
                error_msg = f"Sorry, I encountered an API error: {exc}"
                conversation.append({"role": "assistant", "content": error_msg})
                return error_msg

    final_content = final_response.choices[0].message.content or ""
    conversation.append({"role": "assistant", "content": final_content})
    return final_content


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main() -> None:
    """Run the interactive agentic RAG chat loop."""
    api_key = validate_env()
    client = openai.AsyncOpenAI(api_key=api_key)

    # Build the vector store
    collection = await build_vector_store(client)

    # Initialize conversation with system prompt
    conversation: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT}
    ]

    print("\n=== Agentic RAG Chat ===")
    print("Ask questions about Reader API docs, billing, or getting started.")
    print("Type 'quit' or 'exit' to end the session.\n")

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break

        if not user_input:
            continue

        if user_input.lower() in ("quit", "exit"):
            print("Goodbye!")
            break

        response = await agent_turn(client, collection, conversation, user_input)
        print(f"\nAssistant: {response}\n")


if __name__ == "__main__":
    asyncio.run(main())
