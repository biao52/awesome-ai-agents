# 🧠 Entity Memory Agent

> An agent that tracks entities (people, projects, companies, technologies) and their relationships over time, building a persistent knowledge graph from natural conversation.

## What You'll Learn

- Entity extraction from unstructured conversation using LLM-as-a-parser
- Graph-like memory with SQLite adjacency tables (no graph database needed)
- Temporal tracking of when entities were first and last mentioned
- Entity-aware retrieval to enrich agent responses with accumulated knowledge

## Architecture

```
User message
    |
    v
Entity Extraction (Claude)
    |  Extract names, types, attributes, relationships
    v
SQLite Entity Store
    |  entities table + relationships table (adjacency list)
    v
Entity Retrieval
    |  Find entities mentioned in the current message
    v
Context-Enriched Response (Claude)
    |  System prompt includes relevant entity context
    v
Extract entities from response too
    |
    v
Updated Entity Store
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- Anthropic API key -- get one at [console.anthropic.com](https://console.anthropic.com/)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env  # Then add your API key
python main.py
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your API key
npx tsx index.ts
```

## How It Works

The agent uses a **two-pass extraction pattern**. On every user message, a separate Claude call analyzes the text and extracts structured entity data: names, types (person/company/project/technology), attributes, and relationships between entities. This extracted data gets stored in SQLite using an adjacency list pattern for relationships, which gives you graph-like queries without needing a graph database.

Before generating a response, the agent queries the entity store for any entities mentioned in the current message. It builds a context block with entity details and relationship data, then injects that into the system prompt. This means the agent can reference facts from much earlier in the conversation -- or even from previous sessions -- because the entity store persists on disk.

The entity store uses two tables: `entities` for the nodes (with a JSON `attributes` column for flexible schema) and `relationships` for the edges (with `entity1_id`, `entity2_id`, `relationship_type`, and `context`). The `UNIQUE` constraint on relationships prevents duplicates, and `ON CONFLICT ... DO UPDATE` keeps the context fresh. Entity mentions are counted and timestamped, so you can see which entities come up most often and when they were last relevant.

The agent also extracts entities from its own responses. This captures any new information the model synthesizes or infers, keeping the entity graph growing even when the user does not explicitly name entities.

## Database Schema

The entity store uses two tables that together form a simple graph structure:

```sql
-- Nodes: each entity is a row with flexible JSON attributes
CREATE TABLE entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'other',        -- person, company, project, technology, other
    attributes TEXT NOT NULL DEFAULT '{}',      -- JSON blob for flexible schema
    first_mentioned TEXT NOT NULL,              -- ISO timestamp
    last_mentioned TEXT NOT NULL,               -- ISO timestamp
    mention_count INTEGER NOT NULL DEFAULT 1,   -- how often this entity comes up
    UNIQUE(name COLLATE NOCASE)
);

-- Edges: relationships between entities (adjacency list pattern)
CREATE TABLE relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity1_id INTEGER NOT NULL,
    entity2_id INTEGER NOT NULL,
    relationship_type TEXT NOT NULL,            -- works_at, founded, uses, manages, etc.
    context TEXT NOT NULL DEFAULT '',           -- human-readable description
    created_at TEXT NOT NULL,
    FOREIGN KEY (entity1_id) REFERENCES entities(id),
    FOREIGN KEY (entity2_id) REFERENCES entities(id),
    UNIQUE(entity1_id, entity2_id, relationship_type)
);
```

This adjacency list approach gives you graph traversal capabilities (find all entities connected to X) without requiring a dedicated graph database. For most agent use cases, this is more than sufficient.

## Configuration

| Variable            | Required | Description                                         |
| ------------------- | -------- | --------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Yes      | Your Anthropic API key                              |
| `MODEL`             | No       | Model override (default: claude-sonnet-4-20250514)  |

## Key Files

| File                     | Purpose                              |
| ------------------------ | ------------------------------------ |
| `main.py` / `index.ts`  | Entry point, chat loop, CLI commands |
| `entities.db`            | SQLite database (created at runtime) |

## Commands

The agent supports these slash commands during a chat session:

| Command            | Description                   |
| ------------------ | ----------------------------- |
| `/entities`        | List all tracked entities     |
| `/find <name>`     | Look up a specific entity     |
| `/reset`           | Clear all entity memory       |
| `/quit` or `/exit` | Exit the agent                |

You can also pass `--reset` as a CLI flag to clear the entity store before starting.

## Example Conversation

```
$ python main.py
🚀 Starting entity memory agent...
🧠 Using model: claude-sonnet-4-20250514
📊 Entity store: 0 entities, 0 relationships

You: I am working with Sarah Chen on the Atlas project at Meridian Labs.

🧠 Extracted 3 entities, 2 relationships

Assistant: That sounds like an interesting setup\! Tell me more about the Atlas
project and what Sarah's role is.

You: Sarah is the lead engineer. Atlas is a data pipeline tool built with Rust.

🧠 Extracted 2 entities, 1 relationships

Assistant: Got it\! So Sarah Chen is the lead engineer on Atlas, which is a
Rust-based data pipeline tool at Meridian Labs. What kind of data are you
processing with it?

You: What do you know about Sarah?

Assistant: Here is what I know about Sarah Chen:
- She is a person who works at Meridian Labs
- She is the lead engineer on the Atlas project
- Atlas is a data pipeline tool built with Rust
- I first heard about her in this conversation
```

Notice how the entity count grows with each message. The agent extracts entities from both user messages and its own responses, so the knowledge graph builds up quickly.

After exiting and restarting, the agent still remembers all entities from previous sessions because the SQLite database persists on disk. You can use `/entities` to see everything tracked so far, or `/find Sarah` to look up a specific entity and all its relationships.

## Extend This Example

- Add entity type-specific extraction prompts (e.g., extract funding amounts for companies, tech stack for projects)
- Build a visualization of the entity graph using D3.js or graphviz
- Add a `/graph` command that outputs DOT format for the relationship graph
- Implement entity merging when the same entity is referred to by different names (e.g., "Sarah" and "Sarah Chen")
- Add importance scoring based on mention frequency and recency

## Cost Estimate

Each user message triggers two Claude API calls: one for entity extraction (~200-400 tokens) and one for the main response (~500-1500 tokens). The assistant's response also gets an extraction call. Expect roughly ~$0.01-0.03 per conversation turn with claude-sonnet-4-20250514.

## Related Examples

- [Conversation Memory](../conversation-memory/) -- Simpler memory pattern using vector search over past messages
