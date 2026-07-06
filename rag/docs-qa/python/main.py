"""
Documentation Q&A -- Crawl any docs site via Reader, build a RAG index,
and answer questions interactively.

Usage:
    python main.py --url "https://docs.example.com"
"""

import argparse
import asyncio
import os
import re
import sys
import time
from typing import Any
from urllib.parse import urljoin, urlparse

import chromadb
import httpx
import openai
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL = os.getenv("MODEL", "gpt-4o-mini")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
READER_BASE_URL = "https://r.reader.dev"
TEMPERATURE = 0.3
CHUNK_SIZE = 512
CHUNK_OVERLAP = 64
MAX_RETRIES = 3
RETRY_DELAY = 1.0
TOP_K = 5
MAX_PAGES = 20
CONCURRENCY = 5

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
    """Validate required environment variables and return the OpenAI API key."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("Error: OPENAI_API_KEY environment variable is required.")
        print("Copy .env.example to .env and add your key.")
        sys.exit(1)
    return api_key


# ---------------------------------------------------------------------------
# URL helpers
# ---------------------------------------------------------------------------


def get_domain(url: str) -> str:
    """Extract the domain from a URL."""
    parsed = urlparse(url)
    return parsed.netloc


def normalize_url(url: str) -> str:
    """Strip fragments and trailing slashes for deduplication."""
    parsed = urlparse(url)
    path = parsed.path.rstrip("/") or "/"
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def is_same_domain(url: str, domain: str) -> bool:
    """Check if a URL belongs to the same domain."""
    try:
        return get_domain(url) == domain
    except Exception:
        return False


def is_doc_link(url: str) -> bool:
    """Filter out non-documentation links (images, stylesheets, anchors, etc.)."""
    parsed = urlparse(url)
    path = parsed.path.lower()
    skip_extensions = (
        ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
        ".css", ".js", ".woff", ".woff2", ".ttf", ".eot",
        ".pdf", ".zip", ".tar", ".gz",
    )
    if any(path.endswith(ext) for ext in skip_extensions):
        return False
    if parsed.scheme not in ("http", "https", ""):
        return False
    return True


# ---------------------------------------------------------------------------
# Reader integration
# ---------------------------------------------------------------------------


async def read_page(client: httpx.AsyncClient, url: str) -> str | None:
    """Read a single page through Reader and return its markdown content."""
    reader_url = f"{READER_BASE_URL}/{url}"
    for attempt in range(MAX_RETRIES):
        try:
            response = await client.get(reader_url, timeout=30.0)
            if response.status_code == 200:
                content = response.text.strip()
                if content:
                    return content
                return None
            if response.status_code == 429:
                wait = RETRY_DELAY * (attempt + 1) * 2
                log(f"Rate limited, waiting {wait:.0f}s...", "WARN")
                await asyncio.sleep(wait)
                continue
            log(f"Reader returned {response.status_code} for {url}", "WARN")
            return None
        except (httpx.TimeoutException, httpx.ConnectError) as exc:
            if attempt < MAX_RETRIES - 1:
                log(f"Request error (attempt {attempt + 1}): {exc}", "WARN")
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
            else:
                log(f"Failed to read {url} after {MAX_RETRIES} attempts", "ERROR")
                return None
    return None


# ---------------------------------------------------------------------------
# Link extraction
# ---------------------------------------------------------------------------


def extract_links(markdown: str, base_url: str, domain: str) -> list[str]:
    """Extract same-domain links from markdown content."""
    # Match markdown links: [text](url)
    link_pattern = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")
    matches = link_pattern.findall(markdown)

    seen: set[str] = set()
    links: list[str] = []

    for _text, href in matches:
        # Skip anchor-only links
        if href.startswith("#"):
            continue

        # Resolve relative URLs
        if not href.startswith(("http://", "https://")):
            href = urljoin(base_url, href)

        # Strip fragment
        href = href.split("#")[0]

        if not href:
            continue

        normalized = normalize_url(href)

        if normalized in seen:
            continue
        seen.add(normalized)

        if is_same_domain(normalized, domain) and is_doc_link(normalized):
            links.append(normalized)

    return links


# ---------------------------------------------------------------------------
# Crawling
# ---------------------------------------------------------------------------


async def crawl_docs(start_url: str) -> list[dict[str, str]]:
    """Crawl a docs site starting from the given URL.

    Reads the start page via Reader, extracts same-domain links from the
    markdown, then reads linked pages in parallel. Returns a list of
    dicts with 'url' and 'content' keys.
    """
    domain = get_domain(start_url)
    log(f"Starting crawl from {start_url} (domain: {domain})")

    pages: list[dict[str, str]] = []
    visited: set[str] = {normalize_url(start_url)}

    async with httpx.AsyncClient() as client:
        # Step 1: Read the start page
        log("Reading start page...")
        start_content = await read_page(client, start_url)
        if not start_content:
            log("Failed to read the start page. Check the URL and try again.", "ERROR")
            sys.exit(1)

        pages.append({"url": start_url, "content": start_content})
        log(f"Start page loaded ({len(start_content)} chars)")

        # Step 2: Extract links from the start page
        discovered_links = extract_links(start_content, start_url, domain)
        log(f"Found {len(discovered_links)} same-domain links")

        # Deduplicate against visited
        to_visit = [
            link for link in discovered_links
            if normalize_url(link) not in visited
        ]

        # Cap at MAX_PAGES - 1 (we already have the start page)
        remaining = MAX_PAGES - 1
        to_visit = to_visit[:remaining]
        log(f"Will read {len(to_visit)} linked pages (max {MAX_PAGES} total)")

        # Step 3: Read linked pages in parallel batches
        semaphore = asyncio.Semaphore(CONCURRENCY)
        total = len(to_visit)

        async def read_with_progress(url: str, index: int) -> dict[str, str] | None:
            async with semaphore:
                log(f"Reading page {index + 1}/{total}: {url}")
                content = await read_page(client, url)
                if content:
                    return {"url": url, "content": content}
                return None

        # Mark all as visited to avoid duplicates
        for link in to_visit:
            visited.add(normalize_url(link))

        tasks = [
            read_with_progress(url, i)
            for i, url in enumerate(to_visit)
        ]
        results = await asyncio.gather(*tasks)

        for result in results:
            if result is not None:
                pages.append(result)

    log(f"Crawl complete: {len(pages)} pages loaded")
    return pages


# ---------------------------------------------------------------------------
# Text chunking
# ---------------------------------------------------------------------------


def chunk_text(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[str]:
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
# Indexing
# ---------------------------------------------------------------------------


async def build_vector_store(
    pages: list[dict[str, str]],
    client: openai.AsyncOpenAI,
) -> chromadb.Collection:
    """Chunk crawled pages and embed them into a ChromaDB in-memory collection."""
    log("Building vector store...")

    chroma = chromadb.Client()
    collection = chroma.create_collection(
        name="docs",
        metadata={"hnsw:space": "cosine"},
    )

    all_chunks: list[str] = []
    all_ids: list[str] = []
    all_metadata: list[dict[str, str]] = []

    for page in pages:
        chunks = chunk_text(page["content"])
        for i, chunk in enumerate(chunks):
            all_chunks.append(chunk)
            all_ids.append(f"{page['url']}::chunk_{i}")
            all_metadata.append({"url": page["url"], "chunk_index": str(i)})

    log(f"Created {len(all_chunks)} chunks from {len(pages)} pages")

    # Embed in batches
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

    log(f"Indexed {len(all_chunks)} chunks into vector store")
    return collection


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


async def search_docs(
    query: str,
    collection: chromadb.Collection,
    client: openai.AsyncOpenAI,
) -> str:
    """Search the vector store and return relevant chunks with sources."""
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
        return "No relevant documentation found."

    chunks = results["documents"][0]
    metadatas = results["metadatas"][0] if results["metadatas"] else []
    distances = results["distances"][0] if results["distances"] else []

    output_parts: list[str] = []
    for i, chunk in enumerate(chunks):
        source = metadatas[i]["url"] if i < len(metadatas) else "Unknown"
        distance = f" (distance: {distances[i]:.3f})" if i < len(distances) else ""
        output_parts.append(f"--- Source: {source}{distance} ---\n{chunk}")

    return "\n\n".join(output_parts)


# ---------------------------------------------------------------------------
# Q&A loop
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a helpful documentation assistant. You answer questions based on \
the documentation that has been indexed from a docs site.

When answering:
- Base your answers strictly on the provided documentation context
- Cite the source URL when referencing specific information
- If the context does not contain enough information to answer, say so honestly
- Keep answers clear and concise
- Use code examples from the docs when relevant"""


async def answer_question(
    question: str,
    collection: chromadb.Collection,
    client: openai.AsyncOpenAI,
    conversation: list[dict[str, Any]],
) -> str:
    """Search docs and generate an answer for the given question."""
    # Retrieve relevant context
    context = await search_docs(question, collection, client)
    log(f"Retrieved {len(context)} chars of context")

    # Build the user message with context
    user_message = (
        f"Documentation context:\n\n{context}\n\n"
        f"Question: {question}\n\n"
        f"Answer based on the documentation above."
    )

    conversation.append({"role": "user", "content": user_message})

    for attempt in range(MAX_RETRIES):
        try:
            response = await client.chat.completions.create(
                model=MODEL,
                temperature=TEMPERATURE,
                messages=conversation,
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

    answer = response.choices[0].message.content or ""
    conversation.append({"role": "assistant", "content": answer})
    return answer


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Crawl a docs site and answer questions about it."
    )
    parser.add_argument(
        "--url",
        required=True,
        help="The docs site URL to crawl (e.g., https://docs.example.com)",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=MAX_PAGES,
        help=f"Maximum number of pages to crawl (default: {MAX_PAGES})",
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main() -> None:
    """Crawl a docs site, build a RAG index, and start interactive Q&A."""
    args = parse_args()
    api_key = validate_env()

    global MAX_PAGES
    MAX_PAGES = args.max_pages

    oai_client = openai.AsyncOpenAI(api_key=api_key)

    # Phase 1: Crawl
    print(f"\n=== Documentation Q&A ===")
    print(f"Crawling: {args.url}")
    print(f"Max pages: {MAX_PAGES}\n")

    pages = await crawl_docs(args.url)

    if not pages:
        print("No pages were loaded. Exiting.")
        sys.exit(1)

    # Phase 2: Index
    collection = await build_vector_store(pages, oai_client)

    # Phase 3: Interactive Q&A
    conversation: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT}
    ]

    print(f"\nReady! {len(pages)} pages indexed.")
    print("Ask questions about the documentation.")
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

        answer = await answer_question(
            user_input, collection, oai_client, conversation
        )
        print(f"\nAssistant: {answer}\n")


if __name__ == "__main__":
    asyncio.run(main())
