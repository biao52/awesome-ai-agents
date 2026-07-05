"""
Customer Support Agent -- A RAG-based support agent with a knowledge base,
conversation memory, and escalation logic.

Uses OpenAI for chat + embeddings and ChromaDB for vector search.
"""

import os
import sys
import json
import glob
import asyncio
import random
import string
from typing import Any

from dotenv import load_dotenv
from openai import AsyncOpenAI
import chromadb

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o-mini"
EMBEDDING_MODEL = "text-embedding-3-small"
MAX_RETRIES = 3
MAX_ITERATIONS = 10
KB_CHUNK_SIZE = 800  # Characters per chunk
KB_CHUNK_OVERLAP = 100

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        print("   Get your OpenAI key at: https://platform.openai.com/api-keys")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Knowledge base loading and indexing
# ---------------------------------------------------------------------------


def chunk_text(text: str, chunk_size: int = KB_CHUNK_SIZE, overlap: int = KB_CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start = end - overlap
    return chunks


def load_knowledge_base(kb_dir: str) -> list[dict[str, str]]:
    """Load and chunk all markdown files from the knowledge base directory."""
    abs_dir = os.path.abspath(kb_dir)
    if not os.path.isdir(abs_dir):
        print(f"❌ Knowledge base directory not found: {kb_dir}")
        sys.exit(1)

    md_files = glob.glob(os.path.join(abs_dir, "*.md"))
    if not md_files:
        print(f"❌ No markdown files found in {kb_dir}")
        sys.exit(1)

    documents: list[dict[str, str]] = []
    for file_path in sorted(md_files):
        filename = os.path.basename(file_path)
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        chunks = chunk_text(content)
        for i, chunk in enumerate(chunks):
            documents.append({
                "id": f"{filename}_{i}",
                "content": chunk,
                "source": filename,
            })

    return documents


async def build_vector_store(documents: list[dict[str, str]]) -> chromadb.Collection:
    """Create an in-memory ChromaDB collection and index all documents."""
    client_openai = AsyncOpenAI()

    # Get embeddings for all chunks
    texts = [doc["content"] for doc in documents]
    embedding_model = os.getenv("EMBEDDING_MODEL", EMBEDDING_MODEL)

    # Batch embeddings (OpenAI supports up to 2048 inputs per request)
    log("🔗", f"Generating embeddings for {len(texts)} chunks...")
    response = await client_openai.embeddings.create(
        model=embedding_model,
        input=texts,
    )
    embeddings = [item.embedding for item in response.data]

    # Create ChromaDB collection
    chroma_client = chromadb.Client()  # In-memory, no persistence
    collection = chroma_client.create_collection(
        name="knowledge_base",
        metadata={"hnsw:space": "cosine"},
    )

    collection.add(
        ids=[doc["id"] for doc in documents],
        documents=[doc["content"] for doc in documents],
        metadatas=[{"source": doc["source"]} for doc in documents],
        embeddings=embeddings,
    )

    return collection


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


async def search_knowledge_base(
    query: str, collection: chromadb.Collection, n_results: int = 3
) -> list[dict[str, str]]:
    """Search the knowledge base for relevant content."""
    client = AsyncOpenAI()
    embedding_model = os.getenv("EMBEDDING_MODEL", EMBEDDING_MODEL)

    # Get query embedding
    response = await client.embeddings.create(
        model=embedding_model,
        input=query,
    )
    query_embedding = response.data[0].embedding

    # Search ChromaDB
    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=n_results,
    )

    search_results = []
    if results["documents"] and results["metadatas"]:
        for doc, meta in zip(results["documents"][0], results["metadatas"][0]):
            search_results.append({
                "content": doc,
                "source": meta.get("source", "unknown"),
            })

    return search_results


def create_escalation_ticket(
    category: str, summary: str, priority: str = "normal"
) -> dict[str, str]:
    """Create a simulated escalation ticket."""
    ticket_id = "ESC-" + "".join(random.choices(string.digits, k=6))
    return {
        "ticket_id": ticket_id,
        "category": category,
        "summary": summary,
        "priority": priority,
        "status": "open",
        "message": f"Ticket {ticket_id} created. A support specialist will follow up within 24 hours.",
    }


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_knowledge_base",
            "description": (
                "Search the company knowledge base for information relevant to the customer's question. "
                "Returns the most relevant articles/sections. Use this to find answers before responding."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query based on the customer's question.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_escalation_ticket",
            "description": (
                "Escalate an issue to a human support specialist. Use this when: "
                "1) The knowledge base doesn't have the answer, "
                "2) The customer explicitly asks to speak to a human, "
                "3) The issue requires account-specific actions you can't perform."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": ["billing", "technical", "account", "shipping", "other"],
                        "description": "The category of the issue.",
                    },
                    "summary": {
                        "type": "string",
                        "description": "Brief summary of the customer's issue for the support specialist.",
                    },
                    "priority": {
                        "type": "string",
                        "enum": ["low", "normal", "high", "urgent"],
                        "description": "Priority level. Use 'urgent' only for service outages or security issues.",
                    },
                },
                "required": ["category", "summary"],
            },
        },
    },
]

SYSTEM_PROMPT = """You are a friendly, helpful customer support agent for a SaaS company. You help customers with questions about products, shipping, returns, pricing, technical issues, and account management.

Your process:
1. When a customer asks a question, ALWAYS search the knowledge base first using the search_knowledge_base tool
2. Answer based on the knowledge base content. Cite which article the info came from (e.g., "According to our Returns Policy...")
3. If the knowledge base doesn't have the answer, be honest and offer to escalate

Rules:
- Be warm, professional, and empathetic
- Keep responses concise but complete (2-4 sentences for simple questions, more for complex ones)
- Always cite your sources when using knowledge base content
- Never make up information. If you don't know, say so and offer to escalate
- If the customer seems frustrated, acknowledge their frustration before providing solutions
- If the customer asks to speak to a human, create an escalation ticket immediately
- For account-specific requests (refunds, password resets, plan changes), create an escalation ticket
- Remember the conversation context -- refer back to earlier messages when relevant

Escalation triggers (always create a ticket):
- Customer explicitly asks for a human/manager/supervisor
- Issue requires accessing the customer's specific account data
- Billing disputes or refund requests for amounts over $100
- Security concerns (compromised account, unauthorized access)
- Bug reports with reproduction steps"""


async def run_support_agent(
    messages: list[dict[str, Any]],
    collection: chromadb.Collection,
    model: str,
) -> str:
    """Run one turn of the support agent. Returns the assistant's response."""
    client = AsyncOpenAI()

    for iteration in range(MAX_ITERATIONS):
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=messages,
                tools=TOOLS,
                temperature=0.3,
            )
        except Exception as e:
            error_str = str(e).lower()
            if "rate" in error_str or "overloaded" in error_str:
                wait = 2 ** (iteration % 3 + 1)
                log("⏳", f"API rate limit, retrying in {wait}s...")
                await asyncio.sleep(wait)
                continue
            raise

        choice = response.choices[0]
        message = choice.message
        messages.append(message.model_dump())

        # If no tool calls, return the response
        if not message.tool_calls:
            return message.content or ""

        # Process tool calls
        for tool_call in message.tool_calls:
            fn_name = tool_call.function.name
            fn_args = json.loads(tool_call.function.arguments)

            if fn_name == "search_knowledge_base":
                query = fn_args.get("query", "")
                log("🔍", f"Searching KB: {query}")
                results = await search_knowledge_base(query, collection)
                result_str = json.dumps(results, indent=2)
                log("   ", f"Found {len(results)} relevant sections")

            elif fn_name == "create_escalation_ticket":
                category = fn_args.get("category", "other")
                summary = fn_args.get("summary", "")
                priority = fn_args.get("priority", "normal")
                log("🎫", f"Creating escalation ticket ({category}, {priority})")
                ticket = create_escalation_ticket(category, summary, priority)
                result_str = json.dumps(ticket, indent=2)
                log("   ", f"Ticket created: {ticket['ticket_id']}")

            else:
                result_str = f"Unknown tool: {fn_name}"

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result_str,
            })

    return "I'm having trouble processing your request. Let me connect you with a specialist."


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the customer support agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)

    # Help flag
    if "--help" in sys.argv or "-h" in sys.argv:
        print("Usage: python main.py")
        print()
        print("Starts an interactive customer support chat session.")
        print("The agent answers questions using a built-in knowledge base.")
        print()
        print("Type your question and press Enter. Type 'quit' to exit.")
        sys.exit(0)

    log("🚀", "Starting customer support agent...")
    log("🤖", f"Model: {model}")

    # Load and index knowledge base
    kb_dir = os.path.join(os.path.dirname(__file__), "..", "knowledge_base")
    documents = load_knowledge_base(kb_dir)
    log("📚", f"Loaded {len(documents)} chunks from knowledge base")

    collection = await build_vector_store(documents)
    log("✅", "Knowledge base indexed and ready!")
    print()
    print("=" * 50)
    print("  Welcome to Customer Support!")
    print("  Ask me anything about our products and services.")
    print("  Type 'quit' to exit.")
    print("=" * 50)
    print()

    # Conversation loop
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
    ]

    while True:
        try:
            user_input = input("You: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\n👋 Thanks for contacting us. Have a great day!")
            break

        if not user_input:
            continue
        if user_input.lower() in ("quit", "exit", "q", "bye"):
            print("\n👋 Thanks for contacting us. Have a great day!")
            break

        messages.append({"role": "user", "content": user_input})

        try:
            response = await run_support_agent(messages, collection, model)
        except Exception as e:
            print(f"\n❌ Error: {e}")
            print("   Please try again or type 'quit' to exit.")
            # Remove the failed user message to keep conversation clean
            messages.pop()
            continue

        print(f"\nAgent: {response}\n")


if __name__ == "__main__":
    asyncio.run(main())
