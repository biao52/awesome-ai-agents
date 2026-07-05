/**
 * Entity Memory Agent -- Tracks entities (people, projects, companies) and
 * their relationships across conversations using SQLite.
 *
 * Uses Anthropic Claude for conversation and entity extraction.
 */

import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as path from "node:path";
import * as fs from "node:fs";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL = process.env.MODEL ?? "claude-sonnet-4-20250514";
const DB_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "entities.db");

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntityRow {
  id: number;
  name: string;
  type: string;
  attributes: string;
  first_mentioned: string;
  last_mentioned: string;
  mention_count: number;
}

interface RelationshipRow {
  relationship_type: string;
  context: string;
  entity1_name: string;
  entity2_name: string;
}

interface ExtractedEntity {
  name: string;
  type: string;
  attributes: Record<string, unknown>;
}

interface ExtractedRelationship {
  entity1: string;
  entity2: string;
  relationship_type: string;
  context: string;
}

interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Database Layer
// ---------------------------------------------------------------------------

function initDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
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
  `);

  return db;
}

function getEntityCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM entities").get() as { cnt: number };
  return row.cnt;
}

function getRelationshipCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM relationships").get() as { cnt: number };
  return row.cnt;
}

function upsertEntity(
  db: Database.Database,
  name: string,
  entityType: string,
  attributes: Record<string, unknown>,
): number {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id, attributes, mention_count FROM entities WHERE name = ? COLLATE NOCASE")
    .get(name) as { id: number; attributes: string; mention_count: number } | undefined;

  if (existing) {
    const oldAttrs: Record<string, unknown> = JSON.parse(existing.attributes);
    const merged = { ...oldAttrs, ...attributes };
    db.prepare(
      `UPDATE entities
       SET attributes = ?, last_mentioned = ?, mention_count = ?, type = ?
       WHERE id = ?`,
    ).run(JSON.stringify(merged), now, existing.mention_count + 1, entityType, existing.id);
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO entities (name, type, attributes, first_mentioned, last_mentioned)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(name, entityType, JSON.stringify(attributes), now, now);
  return Number(result.lastInsertRowid);
}

function upsertRelationship(
  db: Database.Database,
  entity1Id: number,
  entity2Id: number,
  relationshipType: string,
  context: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO relationships (entity1_id, entity2_id, relationship_type, context, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity1_id, entity2_id, relationship_type) DO UPDATE
     SET context = excluded.context, created_at = excluded.created_at`,
  ).run(entity1Id, entity2Id, relationshipType, context, now);
}

function findEntitiesByName(db: Database.Database, query: string): EntityRow[] {
  return db
    .prepare(
      `SELECT id, name, type, attributes, first_mentioned, last_mentioned, mention_count
       FROM entities WHERE name LIKE ? COLLATE NOCASE ORDER BY mention_count DESC`,
    )
    .all(`%${query}%`) as EntityRow[];
}

function getEntityRelationships(db: Database.Database, entityId: number): RelationshipRow[] {
  return db
    .prepare(
      `SELECT r.relationship_type, r.context,
              e1.name as entity1_name, e2.name as entity2_name
       FROM relationships r
       JOIN entities e1 ON r.entity1_id = e1.id
       JOIN entities e2 ON r.entity2_id = e2.id
       WHERE r.entity1_id = ? OR r.entity2_id = ?
       ORDER BY r.created_at DESC`,
    )
    .all(entityId, entityId) as RelationshipRow[];
}

function getAllEntities(db: Database.Database, limit: number = 50): EntityRow[] {
  return db
    .prepare(
      `SELECT id, name, type, attributes, first_mentioned, last_mentioned, mention_count
       FROM entities ORDER BY last_mentioned DESC LIMIT ?`,
    )
    .all(limit) as EntityRow[];
}

function buildEntityContext(db: Database.Database, names: string[]): string {
  if (names.length === 0) return "";

  const sections: string[] = [];

  for (const name of names) {
    const entities = findEntitiesByName(db, name);
    for (const entity of entities) {
      const attrs: Record<string, unknown> = JSON.parse(entity.attributes);
      const attrsStr =
        Object.keys(attrs).length > 0
          ? Object.entries(attrs)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ")
          : "none";

      let section =
        `- ${entity.name} (${entity.type}): ${attrsStr} ` +
        `[mentioned ${entity.mention_count}x, last: ${entity.last_mentioned.slice(0, 10)}]`;

      const rels = getEntityRelationships(db, entity.id);
      if (rels.length > 0) {
        const relLines = rels.map((rel) => {
          if (rel.entity1_name.toLowerCase() === entity.name.toLowerCase()) {
            return `  -> ${rel.relationship_type} ${rel.entity2_name}: ${rel.context}`;
          }
          return `  <- ${rel.entity1_name} ${rel.relationship_type}: ${rel.context}`;
        });
        section += "\n" + relLines.join("\n");
      }

      sections.push(section);
    }
  }

  if (sections.length === 0) return "";
  return "Known entities relevant to this conversation:\n" + sections.join("\n");
}

function resetDb(dbPath: string): void {
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    log("🗑️", "Entity store cleared.");
  } else {
    log("📭", "No entity store found. Nothing to clear.");
  }
}

// ---------------------------------------------------------------------------
// Entity Extraction
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `Analyze the following conversation message and extract any entities and relationships mentioned.

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
Only return the JSON, no other text.`;

async function extractEntities(
  client: Anthropic,
  message: string,
  conversationContext: string,
): Promise<ExtractionResult> {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: EXTRACTION_PROMPT,
      messages: [
        {
          role: "user",
          content: `Conversation context:\n${conversationContext}\n\nNew message to analyze:\n${message}`,
        },
      ],
    });

    let text = (response.content[0] as { type: "text"; text: string }).text.trim();

    // Handle possible markdown code blocks in the response
    if (text.startsWith("```")) {
      const newlineIdx = text.indexOf("\n");
      text = newlineIdx >= 0 ? text.slice(newlineIdx + 1) : text.slice(3);
      if (text.endsWith("```")) {
        text = text.slice(0, -3);
      }
      text = text.trim();
    }

    const result = JSON.parse(text) as ExtractionResult;
    return {
      entities: result.entities ?? [],
      relationships: result.relationships ?? [],
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    log("⚠️", `Entity extraction failed: ${errMsg}`);
    return { entities: [], relationships: [] };
  }
}

function storeExtractedData(
  db: Database.Database,
  data: ExtractionResult,
): { entityCount: number; relCount: number } {
  const entityIds = new Map<string, number>();
  let entityCount = 0;
  let relCount = 0;

  for (const entity of data.entities) {
    const name = entity.name?.trim();
    if (!name) continue;

    const entityType = entity.type ?? "other";
    const attributes = typeof entity.attributes === "object" && entity.attributes !== null ? entity.attributes : {};

    const eid = upsertEntity(db, name, entityType, attributes);
    entityIds.set(name.toLowerCase(), eid);
    entityCount++;
  }

  for (const rel of data.relationships) {
    const e1Name = rel.entity1?.trim();
    const e2Name = rel.entity2?.trim();
    if (!e1Name || !e2Name) continue;

    let e1Id = entityIds.get(e1Name.toLowerCase());
    if (e1Id === undefined) {
      e1Id = upsertEntity(db, e1Name, "other", {});
      entityIds.set(e1Name.toLowerCase(), e1Id);
    }

    let e2Id = entityIds.get(e2Name.toLowerCase());
    if (e2Id === undefined) {
      e2Id = upsertEntity(db, e2Name, "other", {});
      entityIds.set(e2Name.toLowerCase(), e2Id);
    }

    const relType = rel.relationship_type ?? "related_to";
    const context = rel.context ?? "";
    upsertRelationship(db, e1Id, e2Id, relType, context);
    relCount++;
  }

  return { entityCount, relCount };
}

// ---------------------------------------------------------------------------
// Chat Agent
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a helpful assistant with entity memory. You track people, projects, companies, and technologies that come up in conversation, and you remember their relationships.

When the user asks about a specific person, project, or company, check your entity memory for relevant information and include it in your response.

When the user asks "What do you know about [X]?" or similar questions, provide a comprehensive summary of the entity and its relationships from your memory.

If entity context is provided below, use it to inform your responses. Be natural about it -- mention what you remember when it's relevant, but don't list raw database entries.

{entity_context}`;

async function chat(
  client: Anthropic,
  db: Database.Database,
  conversationHistory: ConversationMessage[],
  userMessage: string,
): Promise<string> {
  // Step 1: Build conversation context for extraction
  const lastTurns = conversationHistory.slice(-6);
  const recentContext = lastTurns.map((m) => `${m.role}: ${m.content}`).join("\n");

  // Step 2: Extract entities from the new message
  const extracted = await extractEntities(client, userMessage, recentContext);
  const { entityCount, relCount } = storeExtractedData(db, extracted);
  if (entityCount > 0 || relCount > 0) {
    log("🧠", `Extracted ${entityCount} entities, ${relCount} relationships`);
  }

  // Step 3: Find relevant entities for context
  const relevantNames: Set<string> = new Set();
  for (const entity of extracted.entities) {
    if (entity.name) relevantNames.add(entity.name);
  }

  const allEntities = getAllEntities(db, 100);
  for (const entity of allEntities) {
    if (userMessage.toLowerCase().includes(entity.name.toLowerCase())) {
      relevantNames.add(entity.name);
    }
  }

  const entityContext = buildEntityContext(db, Array.from(relevantNames));

  // Step 4: Build system prompt with entity context
  const system = SYSTEM_PROMPT.replace(
    "{entity_context}",
    entityContext || "No relevant entities in memory yet.",
  );

  // Step 5: Add user message to history
  conversationHistory.push({ role: "user", content: userMessage });

  // Step 6: Generate response
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system,
      messages: conversationHistory,
    });

    const assistantMessage = (response.content[0] as { type: "text"; text: string }).text;

    // Step 7: Add assistant response to history
    conversationHistory.push({ role: "assistant", content: assistantMessage });

    // Step 8: Extract entities from the assistant's response too
    const assistantExtracted = await extractEntities(client, assistantMessage, recentContext);
    const { entityCount: aEnt, relCount: aRel } = storeExtractedData(db, assistantExtracted);
    if (aEnt > 0 || aRel > 0) {
      log("🧠", `Extracted ${aEnt} entities, ${aRel} relationships from response`);
    }

    return assistantMessage;
  } catch (e) {
    conversationHistory.pop(); // Remove the user message we just added
    const errMsg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to generate response: ${errMsg}`);
  }
}

function handleQueryCommand(db: Database.Database, query: string): string {
  const entities = findEntitiesByName(db, query);
  if (entities.length === 0) {
    return `No entities found matching '${query}'.`;
  }

  const lines: string[] = [];
  for (const entity of entities) {
    const attrs: Record<string, unknown> = JSON.parse(entity.attributes);
    const attrsStr =
      Object.keys(attrs).length > 0
        ? Object.entries(attrs)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")
        : "no attributes";

    lines.push(
      `\n  ${entity.name} (${entity.type})\n` +
        `  Attributes: ${attrsStr}\n` +
        `  First mentioned: ${entity.first_mentioned.slice(0, 10)}\n` +
        `  Last mentioned: ${entity.last_mentioned.slice(0, 10)}\n` +
        `  Mention count: ${entity.mention_count}`,
    );

    const rels = getEntityRelationships(db, entity.id);
    if (rels.length > 0) {
      lines.push("  Relationships:");
      for (const rel of rels) {
        lines.push(
          `    ${rel.entity1_name} --[${rel.relationship_type}]--> ${rel.entity2_name}: ${rel.context}`,
        );
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Handle --reset flag
  if (process.argv.includes("--reset")) {
    resetDb(DB_PATH);
    process.exit(0);
  }

  validateEnv();

  log("🚀", "Starting entity memory agent...");
  log("🧠", `Using model: ${MODEL}`);

  // Initialize database
  let db = initDb(DB_PATH);
  const entityCount = getEntityCount(db);
  const relCount = getRelationshipCount(db);
  log("📊", `Entity store: ${entityCount} entities, ${relCount} relationships`);

  // Initialize Anthropic client
  const client = new Anthropic();

  const conversationHistory: ConversationMessage[] = [];

  console.log("\nChat with me! I'll remember the people, projects, and companies you mention.");
  console.log("Commands:");
  console.log("  /entities          -- List all tracked entities");
  console.log("  /find <name>       -- Look up a specific entity");
  console.log("  /reset             -- Clear all entity memory");
  console.log("  /quit or /exit     -- Exit the agent");
  console.log();

  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      let userInput: string;
      try {
        userInput = (await rl.question("You: ")).trim();
      } catch {
        break;
      }

      if (!userInput) continue;

      // Handle commands
      if (userInput.toLowerCase() === "/quit" || userInput.toLowerCase() === "/exit") {
        break;
      }

      if (userInput.toLowerCase() === "/entities") {
        const entities = getAllEntities(db);
        if (entities.length === 0) {
          console.log("\n📭 No entities tracked yet.\n");
        } else {
          console.log(`\n📋 Tracked entities (${entities.length}):`);
          for (const e of entities) {
            const attrs: Record<string, unknown> = JSON.parse(e.attributes);
            const attrsPreview =
              Object.keys(attrs).length > 0
                ? Object.entries(attrs)
                    .slice(0, 3)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(", ")
                : "";
            console.log(
              `  [${e.type}] ${e.name} (mentioned ${e.mention_count}x) ${attrsPreview}`,
            );
          }
          console.log();
        }
        continue;
      }

      if (userInput.toLowerCase().startsWith("/find ")) {
        const query = userInput.slice(6).trim();
        if (query) {
          const result = handleQueryCommand(db, query);
          console.log(`\n🔍 ${result}\n`);
        } else {
          console.log("\n⚠️ Usage: /find <name>\n");
        }
        continue;
      }

      if (userInput.toLowerCase() === "/reset") {
        db.close();
        resetDb(DB_PATH);
        db = initDb(DB_PATH);
        conversationHistory.length = 0;
        console.log("🗑️ Entity memory cleared. Starting fresh.\n");
        continue;
      }

      // Regular chat message
      try {
        const response = await chat(client, db, conversationHistory, userInput);
        console.log(`\nAssistant: ${response}\n`);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log("❌", errMsg);
        console.log();
      }
    }
  } finally {
    rl.close();
    db.close();
  }

  log("👋", "Goodbye!");
}

main().catch(console.error);
