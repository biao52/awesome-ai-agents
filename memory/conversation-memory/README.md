# Conversation Memory

> An agent that remembers conversations across sessions using SQLite for persistent storage.

## What You'll Learn

- Persistent memory with SQLite for conversation storage and retrieval
- Session management to isolate conversations while enabling cross-session recall
- Memory summarization to compress long histories and fit context windows
- Context injection to load relevant memory into system prompts at startup

## Architecture

```
User Input
    |
    v
+-------------------+      +-----------+
| ConversationAgent | <--> | SQLite DB |
|  (chat loop)      |      | memory.db |
+-------------------+      +-----------+
    |
    v
OpenAI API (gpt-4o-mini)
```

**Database schema:**

```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Prerequisites

- Python 3.10+ or Node.js 18+
- An OpenAI API key -- get one at https://platform.openai.com/api-keys

## Quick Start

### Python

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # Then add your OpenAI API key
python main.py
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your OpenAI API key
npx tsx index.ts
```

## How It Works

Every time the agent starts, it creates a new session with a unique ID. As you chat, each user message and assistant response is immediately written to a local SQLite database. This means your conversation history survives process restarts, crashes, and reboots.

On startup, the agent loads the last 3 sessions from the database. If any session transcript exceeds 2000 characters, the agent uses the LLM to summarize it into a compact representation that preserves key facts, names, and decisions. The raw or summarized memory is then injected into the system prompt so the model can naturally reference past conversations.

The `MemoryDB` class handles all database operations: saving messages, querying past sessions, and counting stored data. The `ConversationAgent` class manages the chat loop, system prompt construction, and API calls. The summarization step uses a separate, low-temperature API call with explicit instructions to preserve factual content.

The `--reset` flag wipes all stored memory by deleting every row from the messages table. This is useful for testing or starting fresh without manually deleting the database file.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `MODEL` | No | Override the default model (default: `gpt-4o-mini`) |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point, chat loop, and agent orchestration |
| `memory.db` | SQLite database created at runtime (gitignored) |

## Example Session

**Session 1:**

```
[*] 14:30:00 Session: a1b2c3d4...
[*] 14:30:00 No past conversation memory found. Starting fresh.

Conversation Memory Agent
Type your message, or "quit" to exit.

You: My name is Alex and I am working on a robotics project.

Assistant: Nice to meet you, Alex! A robotics project sounds exciting.
What kind of robotics are you working on?

You: quit
[+] 14:32:15 Session ended. Total memory: 2 messages across 1 sessions.
```

**Session 2 (later):**

```
[*] 16:00:00 Session: e5f6g7h8...
[+] 16:00:01 Loaded 2 messages from 1 past sessions

Conversation Memory Agent
Type your message, or "quit" to exit.

You: What do you remember about me?

Assistant: I remember you! Your name is Alex and you told me you are
working on a robotics project. You did not get into the specifics of
what kind of robotics, though. How is the project going?
```

## Memory Summarization

When past sessions contain long conversations, injecting the full transcript into the system prompt would consume too many tokens. The agent handles this by detecting when a session transcript exceeds 2000 characters and automatically summarizing it before injection.

The summarization prompt instructs the model to preserve key facts, names, preferences, and decisions while keeping the summary under 500 characters. This means the agent can recall important details from long conversations without wasting context window space on verbose back-and-forth.

You can adjust the threshold by changing `MAX_CONTEXT_CHARS` in the source code. Lower values produce more aggressive summarization; higher values preserve more raw detail at the cost of token usage.

## Extend This Example

- Add semantic search over past messages using embeddings instead of loading recent sessions
- Implement a `--search` flag to query memory without starting a chat session
- Add topic tagging so the agent can retrieve conversations by subject
- Store conversation summaries as a separate table for faster startup
- Add a web UI that displays the memory timeline alongside the chat

## Related Examples

- [Entity Memory](../entity-memory) -- tracks people, projects, and relationships across conversations
- [Customer Support Agent](../../agents/starter/customer-support-agent) -- uses RAG for knowledge retrieval with in-session memory
