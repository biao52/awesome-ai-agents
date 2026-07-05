"""
Entity Memory Agent -- Tracks entities (people, projects, companies) and
their relationships across conversations using SQLite.

Uses Anthropic Claude for conversation and entity extraction.
"""

import os
import sys
import json
import sqlite3
import asyncio
from datetime import datetime, timezone
from typing import Any

from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL = os.getenv("MODEL", "claude-sonnet-4-20250514")
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "entities.db")


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["ANTHROPIC_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Database Layer
# ---------------------------------------------------------------------------


def init_db(db_path: str) -> sqlite3.Connection:
    """Initialize the SQLite database with entity and relationship tables."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS entities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'other',
            attributes TEXT NOT NULL DEFAULT '{}',
            first_mentioned TEXT NOT NULL,
            last_mentioned TEXT NOT NULL,
            mention_count INTEGER NOT NULL DEFAULT 1,
            UNIQUE(name COLLATE NOCASE)
        );

        CREATE TABLE IF NOT EXISTS relationships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity1_id INTEGER NOT NULL,
            entity2_id INTEGER NOT NULL,
            relationship_type TEXT NOT NULL,
            context TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY (entity1_id) REFERENCES entities(id) ON DELETE CASCADE,
            FOREIGN KEY (entity2_id) REFERENCES entities(id) ON DELETE CASCADE,
            UNIQUE(entity1_id, entity2_id, relationship_type)
        );

        CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
        CREATE INDEX IF NOT EXISTS idx_relationships_entity1 ON relationships(entity1_id);
        CREATE INDEX IF NOT EXISTS idx_relationships_entity2 ON relationships(entity2_id);
    """)
    conn.commit()
    return conn


def get_entity_count(conn: sqlite3.Connection) -> int:
    """Return total number of tracked entities."""
    row = conn.execute("SELECT COUNT(*) as cnt FROM entities").fetchone()
    return row["cnt"]


def get_relationship_count(conn: sqlite3.Connection) -> int:
    """Return total number of tracked relationships."""
    row = conn.execute("SELECT COUNT(*) as cnt FROM relationships").fetchone()
    return row["cnt"]


def upsert_entity(
    conn: sqlite3.Connection,
    name: str,
    entity_type: str,
    attributes: dict[str, Any],
) -> int:
    """Insert or update an entity. Returns the entity ID."""
    now = datetime.now(timezone.utc).isoformat()
    existing = conn.execute(
        "SELECT id, attributes, mention_count FROM entities WHERE name = ? COLLATE NOCASE",
        (name,),
    ).fetchone()

    if existing:
        # Merge attributes: new values override old ones
        old_attrs = json.loads(existing["attributes"])
        old_attrs.update(attributes)
        conn.execute(
            """UPDATE entities
               SET attributes = ?, last_mentioned = ?, mention_count = ?, type = ?
               WHERE id = ?""",
            (json.dumps(old_attrs), now, existing["mention_count"] + 1, entity_type, existing["id"]),
        )
        conn.commit()
        return existing["id"]
    else:
        cursor = conn.execute(
            """INSERT INTO entities (name, type, attributes, first_mentioned, last_mentioned)
               VALUES (?, ?, ?, ?, ?)""",
            (name, entity_type, json.dumps(attributes), now, now),
        )
        conn.commit()
        return cursor.lastrowid  # type: ignore[return-value]


def upsert_relationship(
    conn: sqlite3.Connection,
    entity1_id: int,
    entity2_id: int,
    relationship_type: str,
    context: str,
) -> None:
    """Insert or update a relationship between two entities."""
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """INSERT INTO relationships (entity1_id, entity2_id, relationship_type, context, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(entity1_id, entity2_id, relationship_type) DO UPDATE
           SET context = excluded.context, created_at = excluded.created_at""",
        (entity1_id, entity2_id, relationship_type, context, now),
    )
    conn.commit()


def find_entities_by_name(conn: sqlite3.Connection, query: str) -> list[dict[str, Any]]:
    """Search for entities whose name contains the query string."""
    rows = conn.execute(
        """SELECT id, name, type, attributes, first_mentioned, last_mentioned, mention_count
           FROM entities WHERE name LIKE ? COLLATE NOCASE ORDER BY mention_count DESC""",
        (f"%{query}%",),
    ).fetchall()
    return [dict(r) for r in rows]


def get_entity_relationships(conn: sqlite3.Connection, entity_id: int) -> list[dict[str, Any]]:
    """Get all relationships involving a given entity."""
    rows = conn.execute(
        """SELECT r.relationship_type, r.context,
                  e1.name as entity1_name, e2.name as entity2_name
           FROM relationships r
           JOIN entities e1 ON r.entity1_id = e1.id
           JOIN entities e2 ON r.entity2_id = e2.id
           WHERE r.entity1_id = ? OR r.entity2_id = ?
           ORDER BY r.created_at DESC""",
        (entity_id, entity_id),
    ).fetchall()
    return [dict(r) for r in rows]


def get_all_entities(conn: sqlite3.Connection, limit: int = 50) -> list[dict[str, Any]]:
    """Return all entities, ordered by most recently mentioned."""
    rows = conn.execute(
        """SELECT id, name, type, attributes, first_mentioned, last_mentioned, mention_count
           FROM entities ORDER BY last_mentioned DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def build_entity_context(conn: sqlite3.Connection, names: list[str]) -> str:
    """Build a context string with entity information for the given names."""
    if not names:
        return ""

    sections: list[str] = []
    for name in names:
        entities = find_entities_by_name(conn, name)
        for entity in entities:
            attrs = json.loads(entity["attributes"]) if isinstance(entity["attributes"], str) else entity["attributes"]
            attrs_str = ", ".join(f"{k}: {v}" for k, v in attrs.items()) if attrs else "none"
            section = (
                f"- {entity['name']} ({entity['type']}): {attrs_str} "
                f"[mentioned {entity['mention_count']}x, last: {entity['last_mentioned'][:10]}]"
            )

            rels = get_entity_relationships(conn, entity["id"])
            if rels:
                rel_lines = []
                for rel in rels:
                    if rel["entity1_name"].lower() == entity["name"].lower():
                        rel_lines.append(f"  -> {rel['relationship_type']} {rel['entity2_name']}: {rel['context']}")
                    else:
                        rel_lines.append(f"  <- {rel['entity1_name']} {rel['relationship_type']}: {rel['context']}")
                section += "\n" + "\n".join(rel_lines)

            sections.append(section)

    if not sections:
        return ""

    return "Known entities relevant to this conversation:\n" + "\n".join(sections)


def reset_db(db_path: str) -> None:
    """Delete the database file to start fresh."""
    if os.path.exists(db_path):
        os.remove(db_path)
        log("🗑️", "Entity store cleared.")
    else:
        log("📭", "No entity store found. Nothing to clear.")


# ---------------------------------------------------------------------------
# Entity Extraction
# ---------------------------------------------------------------------------

EXTRACTION_PROMPT = """Analyze the following conversation message and extract any entities and relationships mentioned.

For each entity, provide:
- name: The entity's proper name (capitalize properly)
- type: One of "person", "company", "project", "technology", "other"
- attributes: A JSON object with any notable attributes mentioned (role, location, description, etc.)

For each relationship, provide:
- entity1: Name of the first entity
- entity2: Name of the second entity
- relationship_type: A short label (e.g., "works_at", "founded", "uses", "manages", "part_of", "collaborates_with")
- context: A brief description of the relationship

Respond with a JSON object in this exact format:
{
  "entities": [
    {"name": "...", "type": "...", "attributes": {...}}
  ],
  "relationships": [
    {"entity1": "...", "entity2": "...", "relationship_type": "...", "context": "..."}
  ]
}

If no entities or relationships are found, return empty arrays.
Only return the JSON, no other text."""


async def extract_entities(
    client: AsyncAnthropic,
    message: str,
    conversation_context: str,
) -> dict[str, list[dict[str, Any]]]:
    """Use Claude to extract entities and relationships from a message."""
    try:
        response = await client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=EXTRACTION_PROMPT,
            messages=[
                {
                    "role": "user",
                    "content": f"Conversation context:\n{conversation_context}\n\nNew message to analyze:\n{message}",
                }
            ],
        )

        text = response.content[0].text.strip()
        # Handle possible markdown code blocks in the response
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()

        result = json.loads(text)
        return {
            "entities": result.get("entities", []),
            "relationships": result.get("relationships", []),
        }
    except (json.JSONDecodeError, IndexError, KeyError) as e:
        log("⚠️", f"Entity extraction parse error: {e}")
        return {"entities": [], "relationships": []}
    except Exception as e:
        log("⚠️", f"Entity extraction failed: {e}")
        return {"entities": [], "relationships": []}


def store_extracted_data(
    conn: sqlite3.Connection,
    data: dict[str, list[dict[str, Any]]],
) -> tuple[int, int]:
    """Store extracted entities and relationships. Returns (entity_count, relationship_count)."""
    entity_ids: dict[str, int] = {}
    entity_count = 0
    rel_count = 0

    for entity in data.get("entities", []):
        name = entity.get("name", "").strip()
        if not name:
            continue
        entity_type = entity.get("type", "other")
        attributes = entity.get("attributes", {})
        if not isinstance(attributes, dict):
            attributes = {}

        eid = upsert_entity(conn, name, entity_type, attributes)
        entity_ids[name.lower()] = eid
        entity_count += 1

    for rel in data.get("relationships", []):
        e1_name = rel.get("entity1", "").strip()
        e2_name = rel.get("entity2", "").strip()
        if not e1_name or not e2_name:
            continue

        # Ensure both entities exist
        e1_id = entity_ids.get(e1_name.lower())
        if e1_id is None:
            e1_id = upsert_entity(conn, e1_name, "other", {})
            entity_ids[e1_name.lower()] = e1_id

        e2_id = entity_ids.get(e2_name.lower())
        if e2_id is None:
            e2_id = upsert_entity(conn, e2_name, "other", {})
            entity_ids[e2_name.lower()] = e2_id

        rel_type = rel.get("relationship_type", "related_to")
        context = rel.get("context", "")
        upsert_relationship(conn, e1_id, e2_id, rel_type, context)
        rel_count += 1

    return entity_count, rel_count


# ---------------------------------------------------------------------------
# Chat Agent
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a helpful assistant with entity memory. You track people, projects, companies, and technologies that come up in conversation, and you remember their relationships.

When the user asks about a specific person, project, or company, check your entity memory for relevant information and include it in your response.

When the user asks "What do you know about [X]?" or similar questions, provide a comprehensive summary of the entity and its relationships from your memory.

If entity context is provided below, use it to inform your responses. Be natural about it -- mention what you remember when it's relevant, but don't list raw database entries.

{entity_context}"""


async def chat(
    client: AsyncAnthropic,
    conn: sqlite3.Connection,
    conversation_history: list[dict[str, str]],
    user_message: str,
) -> str:
    """Process a user message: extract entities, retrieve context, and respond."""
    # Step 1: Build conversation context for extraction
    recent_context = ""
    if len(conversation_history) > 0:
        last_turns = conversation_history[-6:]  # Last 3 exchanges
        recent_context = "\n".join(f"{m['role']}: {m['content']}" for m in last_turns)

    # Step 2: Extract entities from the new message
    extracted = await extract_entities(client, user_message, recent_context)
    entity_count, rel_count = store_extracted_data(conn, extracted)
    if entity_count > 0 or rel_count > 0:
        log("🧠", f"Extracted {entity_count} entities, {rel_count} relationships")

    # Step 3: Find relevant entities for context
    # Use extracted entity names plus any names in the user message
    relevant_names: list[str] = []
    for entity in extracted.get("entities", []):
        name = entity.get("name", "")
        if name:
            relevant_names.append(name)

    # Also check if the user is asking about a known entity
    all_entities = get_all_entities(conn, limit=100)
    for entity in all_entities:
        if entity["name"].lower() in user_message.lower():
            relevant_names.append(entity["name"])

    relevant_names = list(set(relevant_names))
    entity_context = build_entity_context(conn, relevant_names)

    # Step 4: Build system prompt with entity context
    system = SYSTEM_PROMPT.format(
        entity_context=entity_context if entity_context else "No relevant entities in memory yet."
    )

    # Step 5: Add user message to history
    conversation_history.append({"role": "user", "content": user_message})

    # Step 6: Generate response
    try:
        response = await client.messages.create(
            model=MODEL,
            max_tokens=2048,
            system=system,
            messages=conversation_history,
        )
        assistant_message = response.content[0].text

        # Step 7: Add assistant response to history
        conversation_history.append({"role": "assistant", "content": assistant_message})

        # Step 8: Extract entities from the assistant's response too
        assistant_extracted = await extract_entities(client, assistant_message, recent_context)
        a_ent, a_rel = store_extracted_data(conn, assistant_extracted)
        if a_ent > 0 or a_rel > 0:
            log("🧠", f"Extracted {a_ent} entities, {a_rel} relationships from response")

        return assistant_message

    except Exception as e:
        conversation_history.pop()  # Remove the user message we just added
        raise RuntimeError(f"Failed to generate response: {e}") from e


def handle_query_command(conn: sqlite3.Connection, query: str) -> str:
    """Handle direct entity queries like 'What do you know about X?'."""
    entities = find_entities_by_name(conn, query)
    if not entities:
        return f"No entities found matching '{query}'."

    lines: list[str] = []
    for entity in entities:
        attrs = json.loads(entity["attributes"]) if isinstance(entity["attributes"], str) else entity["attributes"]
        attrs_str = ", ".join(f"{k}: {v}" for k, v in attrs.items()) if attrs else "no attributes"
        lines.append(
            f"\n  {entity['name']} ({entity['type']})\n"
            f"  Attributes: {attrs_str}\n"
            f"  First mentioned: {entity['first_mentioned'][:10]}\n"
            f"  Last mentioned: {entity['last_mentioned'][:10]}\n"
            f"  Mention count: {entity['mention_count']}"
        )

        rels = get_entity_relationships(conn, entity["id"])
        if rels:
            lines.append("  Relationships:")
            for rel in rels:
                lines.append(f"    {rel['entity1_name']} --[{rel['relationship_type']}]--> {rel['entity2_name']}: {rel['context']}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main() -> None:
    """Run the entity memory chat agent."""
    # Handle --reset flag
    if "--reset" in sys.argv:
        reset_db(DB_PATH)
        sys.exit(0)

    validate_env()

    log("🚀", "Starting entity memory agent...")
    log("🧠", f"Using model: {MODEL}")

    # Initialize database
    conn = init_db(DB_PATH)
    entity_count = get_entity_count(conn)
    rel_count = get_relationship_count(conn)
    log("📊", f"Entity store: {entity_count} entities, {rel_count} relationships")

    # Initialize Anthropic client
    client = AsyncAnthropic()

    conversation_history: list[dict[str, str]] = []

    print("\nChat with me! I'll remember the people, projects, and companies you mention.")
    print("Commands:")
    print("  /entities          -- List all tracked entities")
    print("  /find <name>       -- Look up a specific entity")
    print("  /reset             -- Clear all entity memory")
    print("  /quit or /exit     -- Exit the agent")
    print()

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not user_input:
            continue

        # Handle commands
        if user_input.lower() in ("/quit", "/exit"):
            break

        if user_input.lower() == "/entities":
            entities = get_all_entities(conn)
            if not entities:
                print("\n📭 No entities tracked yet.\n")
            else:
                print(f"\n📋 Tracked entities ({len(entities)}):")
                for e in entities:
                    attrs = json.loads(e["attributes"]) if isinstance(e["attributes"], str) else e["attributes"]
                    attrs_preview = ", ".join(f"{k}: {v}" for k, v in list(attrs.items())[:3]) if attrs else ""
                    print(f"  [{e['type']}] {e['name']} (mentioned {e['mention_count']}x) {attrs_preview}")
                print()
            continue

        if user_input.lower().startswith("/find "):
            query = user_input[6:].strip()
            if query:
                result = handle_query_command(conn, query)
                print(f"\n🔍 {result}\n")
            else:
                print("\n⚠️ Usage: /find <name>\n")
            continue

        if user_input.lower() == "/reset":
            conn.close()
            reset_db(DB_PATH)
            conn = init_db(DB_PATH)
            conversation_history.clear()
            print("🗑️ Entity memory cleared. Starting fresh.\n")
            continue

        # Regular chat message
        try:
            response = await chat(client, conn, conversation_history, user_input)
            print(f"\nAssistant: {response}\n")
        except RuntimeError as e:
            log("❌", str(e))
            print()

    conn.close()
    log("👋", "Goodbye!")


if __name__ == "__main__":
    asyncio.run(main())
