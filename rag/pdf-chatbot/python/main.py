"""
PDF Chatbot -- Conversational RAG agent for PDF documents.

Upload a PDF and ask questions about it. Uses OpenAI embeddings + ChromaDB
for retrieval, GPT-4o-mini for generation, and maintains conversation
history for follow-up questions.

Usage:
    python main.py --file document.pdf
"""

import argparse
import asyncio
import os
import sys
import textwrap
from dataclasses import dataclass, field
from typing import Optional

import chromadb
import fitz  # pymupdf
from dotenv import load_dotenv
from openai import AsyncOpenAI

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
CHUNK_SIZE = 800
CHUNK_OVERLAP = 100
TOP_K = 3
TEMPERATURE = 0.3
MAX_HISTORY = 10  # max conversation turns to keep

SYSTEM_PROMPT = textwrap.dedent("""\
    You are a helpful assistant that answers questions about a PDF document.
    Use ONLY the provided context chunks to answer. If the context does not
    contain enough information to answer, say so honestly.

    Rules:
    - Cite page numbers when referencing information, e.g. (page 3).
    - Be concise and accurate.
    - If the user asks a follow-up, use conversation history for continuity
      but still ground answers in the provided context.
    - Never fabricate information not present in the context.
""")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def log(emoji: str, message: str) -> None:
    """Print a prefixed log message."""
    print(f"  {emoji}  {message}")


def validate_env() -> str:
    """Ensure required environment variables are set. Returns the API key."""
    load_dotenv()
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key or api_key == "your-openai-api-key-here":
        log("!", "OPENAI_API_KEY is not set.")
        log("!", "Copy .env.example to .env and add your key:")
        log("!", "  cp .env.example .env")
        sys.exit(1)
    return api_key


def get_model(env_var: str, default: str) -> str:
    """Read a model name from env or fall back to the default."""
    return os.getenv(env_var, default)


# ---------------------------------------------------------------------------
# PDF extraction
# ---------------------------------------------------------------------------


@dataclass
class PageText:
    """Text content from a single PDF page."""

    page_number: int  # 1-indexed
    text: str


def extract_pdf(file_path: str) -> list[PageText]:
    """Extract text from every page of a PDF using pymupdf."""
    if not os.path.isfile(file_path):
        log("!", f"File not found: {file_path}")
        sys.exit(1)

    try:
        doc = fitz.open(file_path)
    except Exception as exc:
        log("!", f"Failed to open PDF: {exc}")
        sys.exit(1)

    pages: list[PageText] = []
    for i, page in enumerate(doc):
        raw = page.get_text()
        # Collapse excessive whitespace but preserve paragraph breaks
        cleaned = "\n".join(
            line.strip() for line in raw.splitlines() if line.strip()
        )
        if cleaned:
            pages.append(PageText(page_number=i + 1, text=cleaned))

    doc.close()

    if not pages:
        log("!", "PDF contains no extractable text.")
        sys.exit(1)

    return pages


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------


@dataclass
class Chunk:
    """A text chunk with source metadata."""

    text: str
    page_number: int
    chunk_index: int


def chunk_pages(
    pages: list[PageText],
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[Chunk]:
    """Split page texts into overlapping chunks."""
    chunks: list[Chunk] = []
    idx = 0

    for page in pages:
        text = page.text
        start = 0
        while start < len(text):
            end = start + chunk_size
            chunk_text = text[start:end].strip()
            if chunk_text:
                chunks.append(
                    Chunk(
                        text=chunk_text,
                        page_number=page.page_number,
                        chunk_index=idx,
                    )
                )
                idx += 1
            start += chunk_size - overlap

    return chunks


# ---------------------------------------------------------------------------
# Embedding + vector store
# ---------------------------------------------------------------------------


async def generate_embeddings(
    client: AsyncOpenAI,
    texts: list[str],
    model: str,
) -> list[list[float]]:
    """Generate embeddings for a batch of texts."""
    # OpenAI supports batches up to 2048; chunk if needed
    batch_size = 512
    all_embeddings: list[list[float]] = []

    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        response = await client.embeddings.create(input=batch, model=model)
        for item in response.data:
            all_embeddings.append(item.embedding)

    return all_embeddings


async def build_vector_store(
    client: AsyncOpenAI,
    chunks: list[Chunk],
    embedding_model: str,
) -> chromadb.Collection:
    """Create an in-memory ChromaDB collection from chunks."""
    log("\U0001f9e0", "Generating embeddings...")

    texts = [c.text for c in chunks]
    embeddings = await generate_embeddings(client, texts, embedding_model)

    chroma = chromadb.Client()
    collection = chroma.create_collection(
        name="pdf_chunks",
        metadata={"hnsw:space": "cosine"},
    )

    ids = [f"chunk_{c.chunk_index}" for c in chunks]
    metadatas = [
        {"page_number": c.page_number, "chunk_index": c.chunk_index}
        for c in chunks
    ]

    collection.add(
        ids=ids,
        embeddings=embeddings,
        documents=texts,
        metadatas=metadatas,
    )

    log("\u2705", f"Indexed {len(chunks)} chunks into ChromaDB")
    return collection


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------


async def retrieve_chunks(
    client: AsyncOpenAI,
    collection: chromadb.Collection,
    query: str,
    embedding_model: str,
    top_k: int = TOP_K,
) -> list[dict]:
    """Embed the query and retrieve the most relevant chunks."""
    query_embedding = await generate_embeddings(client, [query], embedding_model)

    results = collection.query(
        query_embeddings=query_embedding,
        n_results=top_k,
        include=["documents", "metadatas", "distances"],
    )

    retrieved: list[dict] = []
    if results["documents"] and results["metadatas"]:
        for doc, meta in zip(results["documents"][0], results["metadatas"][0]):
            retrieved.append({
                "text": doc,
                "page_number": meta["page_number"],
            })

    return retrieved


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------


@dataclass
class ConversationHistory:
    """Maintains the rolling conversation context."""

    messages: list[dict] = field(default_factory=list)

    def add_user(self, content: str) -> None:
        self.messages.append({"role": "user", "content": content})
        self._trim()

    def add_assistant(self, content: str) -> None:
        self.messages.append({"role": "assistant", "content": content})
        self._trim()

    def _trim(self) -> None:
        # Keep only the last MAX_HISTORY * 2 messages (user + assistant pairs)
        max_messages = MAX_HISTORY * 2
        if len(self.messages) > max_messages:
            self.messages = self.messages[-max_messages:]

    def to_openai_messages(self) -> list[dict]:
        return list(self.messages)


def format_context(chunks: list[dict]) -> str:
    """Format retrieved chunks into a context block for the LLM."""
    parts: list[str] = []
    for i, chunk in enumerate(chunks, 1):
        parts.append(
            f"[Chunk {i} | Page {chunk['page_number']}]\n{chunk['text']}"
        )
    return "\n\n---\n\n".join(parts)


async def ask_question(
    client: AsyncOpenAI,
    collection: chromadb.Collection,
    question: str,
    history: ConversationHistory,
    model: str,
    embedding_model: str,
) -> str:
    """Process a question: retrieve context, generate answer."""
    # Retrieve relevant chunks
    chunks = await retrieve_chunks(
        client, collection, question, embedding_model
    )

    if not chunks:
        return "I couldn't find any relevant information in the document."

    context = format_context(chunks)

    # Build the prompt with context
    context_message = (
        f"Context from the PDF:\n\n{context}\n\n"
        f"Question: {question}"
    )

    # Build messages for the API call
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(history.to_openai_messages())
    messages.append({"role": "user", "content": context_message})

    try:
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=TEMPERATURE,
        )
    except Exception as exc:
        return f"Error calling OpenAI: {exc}"

    answer = response.choices[0].message.content or "No response generated."

    # Update history with the plain question and answer (not the context)
    history.add_user(question)
    history.add_assistant(answer)

    return answer


# ---------------------------------------------------------------------------
# Interactive loop
# ---------------------------------------------------------------------------


async def chat_loop(
    client: AsyncOpenAI,
    collection: chromadb.Collection,
    model: str,
    embedding_model: str,
    pdf_name: str,
) -> None:
    """Run the interactive chat loop."""
    history = ConversationHistory()

    print()
    print("=" * 60)
    log("\U0001f4ac", f"Chat with: {pdf_name}")
    log("\U0001f4a1", 'Type your questions. Enter "quit" or "exit" to stop.')
    print("=" * 60)
    print()

    while True:
        try:
            question = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            log("\U0001f44b", "Goodbye!")
            break

        if not question:
            continue

        if question.lower() in ("quit", "exit", "q"):
            log("\U0001f44b", "Goodbye!")
            break

        log("\U0001f50d", "Searching document...")
        answer = await ask_question(
            client, collection, question, history, model, embedding_model
        )
        print(f"\nAssistant: {answer}\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main() -> None:
    """Entry point."""
    parser = argparse.ArgumentParser(
        description="Chat with a PDF document using RAG."
    )
    parser.add_argument(
        "--file",
        required=True,
        help="Path to the PDF file to chat with.",
    )
    args = parser.parse_args()

    # Validate environment
    api_key = validate_env()
    model = get_model("MODEL", DEFAULT_MODEL)
    embedding_model = get_model("EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL)

    log("\U0001f680", "PDF Chatbot starting...")
    log("\U0001f4c4", f"File: {args.file}")
    log("\U0001f916", f"Model: {model}")
    log("\U0001f9e9", f"Embeddings: {embedding_model}")

    # Initialize OpenAI client
    client = AsyncOpenAI(api_key=api_key)

    # Extract text from PDF
    log("\U0001f4c4", "Extracting text from PDF...")
    pages = extract_pdf(args.file)
    total_chars = sum(len(p.text) for p in pages)
    log("\u2705", f"Extracted {len(pages)} pages ({total_chars:,} characters)")

    # Chunk the text
    chunks = chunk_pages(pages)
    log("\u2705", f"Created {len(chunks)} chunks (size={CHUNK_SIZE}, overlap={CHUNK_OVERLAP})")

    # Build vector store
    collection = await build_vector_store(client, chunks, embedding_model)

    # Start chat
    pdf_name = os.path.basename(args.file)
    await chat_loop(client, collection, model, embedding_model, pdf_name)


if __name__ == "__main__":
    asyncio.run(main())
