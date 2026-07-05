"""
Codebase RAG -- Index a local codebase and ask questions about it.

Uses OpenAI embeddings + ChromaDB for retrieval, Anthropic Claude for answering.
"""

import argparse
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional

import anthropic
import chromadb
import openai
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SUPPORTED_EXTENSIONS: set[str] = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".rb",
    ".php", ".c", ".cpp", ".h", ".css", ".html", ".md", ".yaml", ".yml",
    ".json", ".toml", ".sh", ".sql",
}

SKIP_DIRS: set[str] = {
    "node_modules", ".git", "__pycache__", ".next", ".nuxt", "dist", "build",
    ".venv", "venv", "env", ".env", ".tox", ".mypy_cache", ".pytest_cache",
    "coverage", ".turbo", ".cache", "target", "out", ".idea", ".vscode",
}

SKIP_FILES: set[str] = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock",
    "poetry.lock", "Pipfile.lock", "composer.lock", "Gemfile.lock",
}

MAX_FILE_SIZE_BYTES: int = 100_000  # 100 KB
CHUNK_SIZE: int = 1500  # characters for fallback chunking
CHUNK_OVERLAP: int = 200
EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
CHAT_MODEL: str = os.getenv("MODEL", "claude-sonnet-4-20250514")
EMBEDDING_BATCH_SIZE: int = 64

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

_start_time: float = time.time()


def log(msg: str) -> None:
    elapsed = time.time() - _start_time
    print(f"[{elapsed:6.1f}s] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> tuple[anthropic.Anthropic, openai.OpenAI]:
    """Validate required API keys and return configured clients."""
    missing: list[str] = []
    if not os.getenv("ANTHROPIC_API_KEY"):
        missing.append("ANTHROPIC_API_KEY")
    if not os.getenv("OPENAI_API_KEY"):
        missing.append("OPENAI_API_KEY")

    if missing:
        print(f"Error: Missing required environment variables: {', '.join(missing)}")
        print("Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)

    return (
        anthropic.Anthropic(),
        openai.OpenAI(),
    )


# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------

EXTENSION_TO_LANGUAGE: dict[str, str] = {
    ".py": "python", ".js": "javascript", ".ts": "typescript",
    ".tsx": "typescriptreact", ".jsx": "javascriptreact", ".go": "go",
    ".rs": "rust", ".java": "java", ".rb": "ruby", ".php": "php",
    ".c": "c", ".cpp": "cpp", ".h": "c-header", ".css": "css",
    ".html": "html", ".md": "markdown", ".yaml": "yaml", ".yml": "yaml",
    ".json": "json", ".toml": "toml", ".sh": "shell", ".sql": "sql",
}


def detect_language(filepath: str) -> str:
    ext = Path(filepath).suffix.lower()
    return EXTENSION_TO_LANGUAGE.get(ext, "text")


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------


def discover_files(repo_path: str) -> list[str]:
    """Walk the repo and return paths to indexable source files."""
    repo = Path(repo_path).resolve()
    if not repo.is_dir():
        print(f"Error: '{repo_path}' is not a directory.")
        sys.exit(1)

    files: list[str] = []
    for root, dirs, filenames in os.walk(repo):
        # Prune skipped directories in-place
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]

        for fname in filenames:
            if fname in SKIP_FILES:
                continue
            fpath = Path(root) / fname
            if fpath.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            try:
                size = fpath.stat().st_size
            except OSError:
                continue
            if size > MAX_FILE_SIZE_BYTES or size == 0:
                continue
            files.append(str(fpath))

    return sorted(files)


# ---------------------------------------------------------------------------
# Code-aware chunking
# ---------------------------------------------------------------------------

# Regex patterns for function/class boundaries across languages
_BOUNDARY_PATTERNS: list[re.Pattern[str]] = [
    # Python: def / class / async def
    re.compile(r"^(?:async\s+)?(?:def|class)\s+\w+", re.MULTILINE),
    # JS/TS: function, export function, export default function, arrow const
    re.compile(
        r"^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+\w+|"
        r"^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(",
        re.MULTILINE,
    ),
    # Go: func
    re.compile(r"^func\s+", re.MULTILINE),
    # Rust: fn, pub fn, impl, struct, enum
    re.compile(r"^(?:pub\s+)?(?:fn|impl|struct|enum)\s+\w+", re.MULTILINE),
    # Java/C/C++: class, public/private/protected, struct
    re.compile(
        r"^(?:public|private|protected|static|abstract|final|virtual)?\s*"
        r"(?:class|struct|interface|enum)\s+\w+",
        re.MULTILINE,
    ),
    # Ruby: def, class, module
    re.compile(r"^(?:def|class|module)\s+\w+", re.MULTILINE),
    # PHP: function, class
    re.compile(r"^(?:public|private|protected|static)?\s*(?:function|class)\s+\w+", re.MULTILINE),
]


def _find_boundaries(content: str) -> list[int]:
    """Find line offsets where function/class definitions start."""
    positions: set[int] = set()
    for pattern in _BOUNDARY_PATTERNS:
        for match in pattern.finditer(content):
            positions.add(match.start())
    return sorted(positions)


def _offset_to_line(content: str, offset: int) -> int:
    """Convert a character offset to a 1-based line number."""
    return content[:offset].count("\n") + 1


def chunk_code(content: str, filepath: str) -> list[dict]:
    """Split source code into chunks, preferring function/class boundaries."""
    language = detect_language(filepath)
    lines = content.split("\n")
    total_lines = len(lines)

    if len(content) <= CHUNK_SIZE:
        return [{
            "text": content,
            "file": filepath,
            "language": language,
            "start_line": 1,
            "end_line": total_lines,
        }]

    boundaries = _find_boundaries(content)

    # If we found meaningful boundaries, use them
    if len(boundaries) >= 2:
        chunks: list[dict] = []
        # Add start if not already there
        if boundaries[0] != 0:
            boundaries.insert(0, 0)
        # Add end
        boundaries.append(len(content))

        for i in range(len(boundaries) - 1):
            start_off = boundaries[i]
            end_off = boundaries[i + 1]
            text = content[start_off:end_off].strip()
            if not text:
                continue

            start_line = _offset_to_line(content, start_off)
            end_line = _offset_to_line(content, end_off - 1)

            # If this chunk is too large, sub-chunk it with fixed-size
            if len(text) > CHUNK_SIZE * 2:
                sub_chunks = _fixed_size_chunk(text, filepath, language, start_line)
                chunks.extend(sub_chunks)
            else:
                chunks.append({
                    "text": text,
                    "file": filepath,
                    "language": language,
                    "start_line": start_line,
                    "end_line": end_line,
                })
        return chunks

    # Fallback: fixed-size chunking
    return _fixed_size_chunk(content, filepath, language, 1)


def _fixed_size_chunk(
    content: str,
    filepath: str,
    language: str,
    base_line: int,
) -> list[dict]:
    """Split content into fixed-size overlapping chunks."""
    chunks: list[dict] = []
    pos = 0
    while pos < len(content):
        end = pos + CHUNK_SIZE
        text = content[pos:end]

        start_line = base_line + content[:pos].count("\n")
        end_line = start_line + text.count("\n")

        chunks.append({
            "text": text.strip(),
            "file": filepath,
            "language": language,
            "start_line": start_line,
            "end_line": end_line,
        })

        pos += CHUNK_SIZE - CHUNK_OVERLAP
        if end >= len(content):
            break

    return chunks


# ---------------------------------------------------------------------------
# Indexing pipeline
# ---------------------------------------------------------------------------


def read_and_chunk(files: list[str]) -> list[dict]:
    """Read all files and produce chunks with metadata."""
    all_chunks: list[dict] = []
    skipped = 0

    for filepath in files:
        try:
            with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
        except (OSError, UnicodeDecodeError):
            skipped += 1
            continue

        if not content.strip():
            continue

        file_chunks = chunk_code(content, filepath)
        all_chunks.extend(file_chunks)

    if skipped > 0:
        log(f"Skipped {skipped} unreadable files")

    return all_chunks


def embed_chunks(
    oai: openai.OpenAI,
    chunks: list[dict],
) -> list[list[float]]:
    """Embed all chunk texts using OpenAI embeddings API."""
    embeddings: list[list[float]] = []
    texts = [c["text"] for c in chunks]
    total_batches = (len(texts) + EMBEDDING_BATCH_SIZE - 1) // EMBEDDING_BATCH_SIZE

    for i in range(0, len(texts), EMBEDDING_BATCH_SIZE):
        batch = texts[i : i + EMBEDDING_BATCH_SIZE]
        batch_num = i // EMBEDDING_BATCH_SIZE + 1
        log(f"Embedding batch {batch_num}/{total_batches} ({len(batch)} chunks)")

        try:
            response = oai.embeddings.create(
                model=EMBEDDING_MODEL,
                input=batch,
            )
            for item in response.data:
                embeddings.append(item.embedding)
        except openai.APIError as e:
            print(f"Error: OpenAI embedding API failed: {e}")
            sys.exit(1)

    return embeddings


def build_index(
    oai: openai.OpenAI,
    repo_path: str,
) -> chromadb.Collection:
    """Discover files, chunk, embed, and store in ChromaDB."""
    log(f"Scanning {repo_path} for source files...")
    files = discover_files(repo_path)
    if not files:
        print("Error: No indexable source files found in the repository.")
        sys.exit(1)
    log(f"Found {len(files)} files")

    log("Chunking files...")
    chunks = read_and_chunk(files)
    if not chunks:
        print("Error: No chunks produced from the source files.")
        sys.exit(1)
    log(f"Produced {len(chunks)} chunks")

    log("Generating embeddings...")
    embeddings = embed_chunks(oai, chunks)

    log("Storing in ChromaDB...")
    client = chromadb.Client()
    collection = client.create_collection(
        name="codebase",
        metadata={"hnsw:space": "cosine"},
    )

    ids = [f"chunk-{i}" for i in range(len(chunks))]
    documents = [c["text"] for c in chunks]
    metadatas = [
        {
            "file": c["file"],
            "language": c["language"],
            "start_line": c["start_line"],
            "end_line": c["end_line"],
        }
        for c in chunks
    ]

    # ChromaDB has a batch limit; insert in batches
    batch = 500
    for i in range(0, len(ids), batch):
        collection.add(
            ids=ids[i : i + batch],
            documents=documents[i : i + batch],
            embeddings=embeddings[i : i + batch],
            metadatas=metadatas[i : i + batch],
        )

    log(f"Index built: {len(chunks)} chunks from {len(files)} files")
    return collection


# ---------------------------------------------------------------------------
# Query pipeline
# ---------------------------------------------------------------------------


def retrieve(
    oai: openai.OpenAI,
    collection: chromadb.Collection,
    query: str,
    top_k: int = 10,
) -> list[dict]:
    """Embed query and retrieve top-k relevant chunks."""
    try:
        response = oai.embeddings.create(
            model=EMBEDDING_MODEL,
            input=[query],
        )
        query_embedding = response.data[0].embedding
    except openai.APIError as e:
        log(f"Embedding error: {e}")
        return []

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=top_k,
    )

    chunks: list[dict] = []
    if results and results["documents"] and results["metadatas"]:
        for doc, meta in zip(results["documents"][0], results["metadatas"][0]):
            chunks.append({
                "text": doc,
                "file": meta["file"],
                "language": meta["language"],
                "start_line": meta["start_line"],
                "end_line": meta["end_line"],
            })
    return chunks


def build_context(chunks: list[dict]) -> str:
    """Format retrieved chunks into a context string for the LLM."""
    parts: list[str] = []
    for i, chunk in enumerate(chunks, 1):
        header = (
            f"--- Source {i}: {chunk['file']} "
            f"(lines {chunk['start_line']}-{chunk['end_line']}, "
            f"{chunk['language']}) ---"
        )
        parts.append(header)
        parts.append(chunk["text"])
        parts.append("")
    return "\n".join(parts)


def ask(
    claude: anthropic.Anthropic,
    oai: openai.OpenAI,
    collection: chromadb.Collection,
    question: str,
    repo_path: str,
) -> str:
    """Retrieve relevant code and answer the question using Claude."""
    chunks = retrieve(oai, collection, question)
    if not chunks:
        return "No relevant code found for that question."

    context = build_context(chunks)

    system_prompt = (
        f"You are a code expert analyzing the repository at {repo_path}. "
        "Answer questions based on the provided source code context. "
        "Be specific -- reference file paths, function names, and line numbers. "
        "If the context doesn't contain enough information, say so clearly."
    )

    try:
        response = claude.messages.create(
            model=CHAT_MODEL,
            max_tokens=4096,
            system=system_prompt,
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"## Retrieved Code Context\n\n{context}\n\n"
                        f"## Question\n\n{question}"
                    ),
                }
            ],
        )
        text_blocks = [b.text for b in response.content if b.type == "text"]
        return "\n".join(text_blocks)
    except anthropic.APIError as e:
        return f"Claude API error: {e}"


# ---------------------------------------------------------------------------
# Interactive loop
# ---------------------------------------------------------------------------


def interactive_loop(
    claude: anthropic.Anthropic,
    oai: openai.OpenAI,
    collection: chromadb.Collection,
    repo_path: str,
) -> None:
    """Run the interactive Q&A session."""
    print("\n" + "=" * 60)
    print("Codebase RAG -- Ask questions about your code")
    print("Type 'quit' or 'exit' to stop, 'help' for tips")
    print("=" * 60 + "\n")

    while True:
        try:
            question = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break

        if not question:
            continue
        if question.lower() in ("quit", "exit", "q"):
            print("Goodbye!")
            break
        if question.lower() == "help":
            print(
                "\nTips:\n"
                "  - Ask about specific functions, classes, or modules\n"
                "  - Ask 'What does X do?' or 'How does Y work?'\n"
                "  - Ask 'Where is Z implemented?'\n"
                "  - Ask about architecture, patterns, or dependencies\n"
            )
            continue

        print("\nSearching codebase...\n")
        answer = ask(claude, oai, collection, question, repo_path)
        print(f"Assistant: {answer}\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Codebase RAG -- Index and query a local codebase",
    )
    parser.add_argument(
        "--repo",
        required=True,
        help="Path to the repository to index",
    )
    args = parser.parse_args()

    repo_path = str(Path(args.repo).resolve())
    if not Path(repo_path).is_dir():
        print(f"Error: '{args.repo}' is not a valid directory.")
        sys.exit(1)

    claude, oai = validate_env()
    collection = build_index(oai, repo_path)
    interactive_loop(claude, oai, collection, repo_path)


if __name__ == "__main__":
    main()
