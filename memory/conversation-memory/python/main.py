"""
Conversation Memory Agent

An AI agent with persistent conversation memory using SQLite.
Remembers conversations across sessions and can recall past discussions.

Usage:
    python main.py          # Start interactive chat
    python main.py --reset  # Clear all stored memory
"""

import os
import sys
import uuid
import sqlite3
import datetime
from typing import Optional

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "memory.db")
MODEL = os.environ.get("MODEL", "gpt-4o-mini")
MAX_CONTEXT_CHARS = 2000
PAST_SESSIONS_TO_LOAD = 3

SYSTEM_PROMPT = """You are a helpful AI assistant with persistent memory across conversations.

You have access to memories from past conversation sessions. When the user asks about
previous conversations, references something discussed before, or says things like
"What did we talk about last time?", use your memory context to answer accurately.

If memory context is provided below, reference it naturally. Do not fabricate memories
that are not present in the provided context.

Be conversational, helpful, and acknowledge when you remember past interactions."""


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(message: str, level: str = "info") -> None:
    """Print a formatted log message to stderr."""
    timestamp = datetime.datetime.now().strftime("%H:%M:%S")
    prefix = {"info": "[*]", "warn": "[!]", "error": "[x]", "ok": "[+]"}.get(level, "[*]")
    print(f"{prefix} {timestamp} {message}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------

def validate_env() -> str:
    """Validate required environment variables and return the API key."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        log("OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.", "error")
        sys.exit(1)
    if not api_key.startswith("sk-"):
        log("OPENAI_API_KEY does not look valid (should start with 'sk-').", "warn")
    return api_key


# ---------------------------------------------------------------------------
# Database layer
# ---------------------------------------------------------------------------

class MemoryDB:
    """SQLite-backed conversation memory store."""

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        """Create tables if they do not exist."""
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        self.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_messages_session
            ON messages(session_id)
        """)
        self.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_messages_timestamp
            ON messages(timestamp)
        """)
        self.conn.commit()

    def save_message(self, session_id: str, role: str, content: str) -> None:
        """Persist a single message."""
        self.conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
            (session_id, role, content, datetime.datetime.utcnow().isoformat()),
        )
        self.conn.commit()

    def get_past_sessions(self, current_session_id: str, limit: int = 3) -> list[str]:
        """Return the most recent session IDs excluding the current one."""
        cursor = self.conn.execute(
            """
            SELECT DISTINCT session_id
            FROM messages
            WHERE session_id != ?
            ORDER BY MAX(timestamp) DESC
            LIMIT ?
            """,
            (current_session_id, limit),
        )
        # The query needs a GROUP BY for MAX to work properly across sessions
        cursor = self.conn.execute(
            """
            SELECT session_id, MAX(timestamp) as last_ts
            FROM messages
            WHERE session_id != ?
            GROUP BY session_id
            ORDER BY last_ts DESC
            LIMIT ?
            """,
            (current_session_id, limit),
        )
        return [row["session_id"] for row in cursor.fetchall()]

    def get_session_messages(self, session_id: str) -> list[dict]:
        """Return all messages for a given session, ordered by timestamp."""
        cursor = self.conn.execute(
            """
            SELECT role, content, timestamp
            FROM messages
            WHERE session_id = ?
            ORDER BY timestamp ASC
            """,
            (session_id,),
        )
        return [dict(row) for row in cursor.fetchall()]

    def get_total_message_count(self) -> int:
        """Return total number of messages across all sessions."""
        cursor = self.conn.execute("SELECT COUNT(*) as cnt FROM messages")
        return cursor.fetchone()["cnt"]

    def get_session_count(self) -> int:
        """Return total number of distinct sessions."""
        cursor = self.conn.execute("SELECT COUNT(DISTINCT session_id) as cnt FROM messages")
        return cursor.fetchone()["cnt"]

    def reset(self) -> None:
        """Delete all stored messages."""
        self.conn.execute("DELETE FROM messages")
        self.conn.commit()

    def close(self) -> None:
        """Close the database connection."""
        self.conn.close()


# ---------------------------------------------------------------------------
# Memory summarization
# ---------------------------------------------------------------------------

def summarize_memory(client: OpenAI, messages: list[dict]) -> str:
    """Use the LLM to summarize a block of past messages when they exceed the token budget."""
    transcript = format_messages_as_transcript(messages)
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "Summarize the following conversation concisely. "
                    "Preserve key facts, preferences, names, and decisions. "
                    "Keep it under 500 characters."
                ),
            },
            {"role": "user", "content": transcript},
        ],
        max_tokens=300,
        temperature=0.3,
    )
    return response.choices[0].message.content or ""


def format_messages_as_transcript(messages: list[dict]) -> str:
    """Format a list of message dicts into a readable transcript."""
    lines: list[str] = []
    for msg in messages:
        role_label = "User" if msg["role"] == "user" else "Assistant"
        lines.append(f"{role_label}: {msg['content']}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Memory context builder
# ---------------------------------------------------------------------------

def build_memory_context(client: OpenAI, db: MemoryDB, session_id: str) -> tuple[str, int, int]:
    """
    Load past sessions and build a memory context string.

    Returns (context_string, message_count, session_count).
    """
    past_session_ids = db.get_past_sessions(session_id, limit=PAST_SESSIONS_TO_LOAD)

    if not past_session_ids:
        return "", 0, 0

    total_messages = 0
    session_blocks: list[str] = []

    for sid in past_session_ids:
        messages = db.get_session_messages(sid)
        # Skip sessions with only system messages
        user_assistant_msgs = [m for m in messages if m["role"] in ("user", "assistant")]
        if not user_assistant_msgs:
            continue

        total_messages += len(user_assistant_msgs)
        transcript = format_messages_as_transcript(user_assistant_msgs)

        # Summarize if too long
        if len(transcript) > MAX_CONTEXT_CHARS:
            log(f"Summarizing session {sid[:8]}... ({len(transcript)} chars)", "info")
            transcript = summarize_memory(client, user_assistant_msgs)

        timestamp = user_assistant_msgs[0].get("timestamp", "unknown")
        session_blocks.append(f"[Session from {timestamp}]\n{transcript}")

    if not session_blocks:
        return "", 0, 0

    context = "MEMORY FROM PAST CONVERSATIONS:\n\n" + "\n\n---\n\n".join(session_blocks)
    return context, total_messages, len(session_blocks)


# ---------------------------------------------------------------------------
# Chat agent
# ---------------------------------------------------------------------------

class ConversationAgent:
    """Interactive chat agent with persistent memory."""

    def __init__(self, client: OpenAI, db: MemoryDB, session_id: str) -> None:
        self.client = client
        self.db = db
        self.session_id = session_id
        self.conversation: list[dict] = []
        self.memory_context: Optional[str] = None

    def initialize(self) -> None:
        """Load memory and build the system prompt."""
        context, msg_count, sess_count = build_memory_context(
            self.client, self.db, self.session_id
        )

        if context:
            self.memory_context = context
            log(f"Loaded {msg_count} messages from {sess_count} past sessions", "ok")
        else:
            log("No past conversation memory found. Starting fresh.", "info")

        system_content = SYSTEM_PROMPT
        if self.memory_context:
            system_content += f"\n\n{self.memory_context}"

        self.conversation = [{"role": "system", "content": system_content}]

    def chat(self, user_message: str) -> str:
        """Send a message and get a response. Both are persisted to the database."""
        self.db.save_message(self.session_id, "user", user_message)
        self.conversation.append({"role": "user", "content": user_message})

        try:
            response = self.client.chat.completions.create(
                model=MODEL,
                messages=self.conversation,
                max_tokens=1024,
                temperature=0.7,
            )
            assistant_message = response.choices[0].message.content or ""
        except Exception as exc:
            log(f"API error: {exc}", "error")
            assistant_message = "I encountered an error processing your request. Please try again."

        self.db.save_message(self.session_id, "assistant", assistant_message)
        self.conversation.append({"role": "assistant", "content": assistant_message})

        return assistant_message


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    """Entry point for the conversation memory agent."""
    # Handle --reset flag
    if "--reset" in sys.argv:
        db = MemoryDB(DB_PATH)
        count = db.get_total_message_count()
        db.reset()
        db.close()
        log(f"Cleared all memory ({count} messages deleted).", "ok")
        return

    api_key = validate_env()
    client = OpenAI(api_key=api_key)
    db = MemoryDB(DB_PATH)
    session_id = uuid.uuid4().hex

    log(f"Session: {session_id[:8]}...", "info")
    log(f"Model: {MODEL}", "info")
    log(f"Database: {DB_PATH}", "info")

    agent = ConversationAgent(client, db, session_id)

    try:
        agent.initialize()
    except Exception as exc:
        log(f"Failed to initialize memory: {exc}", "error")
        log("Starting without memory context.", "warn")
        agent.conversation = [{"role": "system", "content": SYSTEM_PROMPT}]

    print("\nConversation Memory Agent")
    print("Type your message, or 'quit' to exit.\n")

    try:
        while True:
            try:
                user_input = input("You: ").strip()
            except EOFError:
                break

            if not user_input:
                continue
            if user_input.lower() in ("quit", "exit", "q"):
                break

            response = agent.chat(user_input)
            print(f"\nAssistant: {response}\n")

    except KeyboardInterrupt:
        print()

    total = db.get_total_message_count()
    sessions = db.get_session_count()
    db.close()
    log(f"Session ended. Total memory: {total} messages across {sessions} sessions.", "ok")


if __name__ == "__main__":
    main()
