/**
 * Conversation Memory Agent
 *
 * An AI agent with persistent conversation memory using SQLite.
 * Remembers conversations across sessions and can recall past discussions.
 *
 * Usage:
 *   npx tsx index.ts          # Start interactive chat
 *   npx tsx index.ts --reset  # Clear all stored memory
 */

import * as path from "path";
import * as readline from "readline";
import { randomUUID } from "crypto";

import Database from "better-sqlite3";
import { config } from "dotenv";
import OpenAI from "openai";

config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = path.join(__dirname, "memory.db");
const MODEL = process.env.MODEL ?? "gpt-4o-mini";
const MAX_CONTEXT_CHARS = 2000;
const PAST_SESSIONS_TO_LOAD = 3;

const SYSTEM_PROMPT = `You are a helpful AI assistant with persistent memory across conversations.

You have access to memories from past conversation sessions. When the user asks about
previous conversations, references something discussed before, or says things like
"What did we talk about last time?", use your memory context to answer accurately.

If memory context is provided below, reference it naturally. Do not fabricate memories
that are not present in the provided context.

Be conversational, helpful, and acknowledge when you remember past interactions.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MessageRow {
  id: number;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

interface SessionRow {
  session_id: string;
  last_ts: string;
}

interface CountRow {
  cnt: number;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string, level: "info" | "warn" | "error" | "ok" = "info"): void {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  const prefix: Record<string, string> = {
    info: "[*]",
    warn: "[!]",
    error: "[x]",
    ok: "[+]",
  };
  process.stderr.write(`${prefix[level]} ${timestamp} ${message}\n`);
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log("OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.", "error");
    process.exit(1);
  }
  if (!apiKey.startsWith("sk-")) {
    log("OPENAI_API_KEY does not look valid (should start with 'sk-').", "warn");
  }
  return apiKey;
}

// ---------------------------------------------------------------------------
// Database layer
// ---------------------------------------------------------------------------

class MemoryDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)
    `);
  }

  saveMessage(sessionId: string, role: string, content: string): void {
    const stmt = this.db.prepare(
      "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)"
    );
    stmt.run(sessionId, role, content, new Date().toISOString());
  }

  getPastSessions(currentSessionId: string, limit: number = 3): string[] {
    const stmt = this.db.prepare(`
      SELECT session_id, MAX(timestamp) as last_ts
      FROM messages
      WHERE session_id != ?
      GROUP BY session_id
      ORDER BY last_ts DESC
      LIMIT ?
    `);
    const rows = stmt.all(currentSessionId, limit) as SessionRow[];
    return rows.map((row) => row.session_id);
  }

  getSessionMessages(sessionId: string): MessageRow[] {
    const stmt = this.db.prepare(`
      SELECT role, content, timestamp
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(sessionId) as MessageRow[];
  }

  getTotalMessageCount(): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as cnt FROM messages");
    const row = stmt.get() as CountRow;
    return row.cnt;
  }

  getSessionCount(): number {
    const stmt = this.db.prepare("SELECT COUNT(DISTINCT session_id) as cnt FROM messages");
    const row = stmt.get() as CountRow;
    return row.cnt;
  }

  reset(): void {
    this.db.exec("DELETE FROM messages");
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Memory summarization
// ---------------------------------------------------------------------------

function formatMessagesAsTranscript(messages: MessageRow[]): string {
  return messages
    .map((msg) => {
      const label = msg.role === "user" ? "User" : "Assistant";
      return `${label}: ${msg.content}`;
    })
    .join("\n");
}

async function summarizeMemory(client: OpenAI, messages: MessageRow[]): Promise<string> {
  const transcript = formatMessagesAsTranscript(messages);
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "Summarize the following conversation concisely. " +
          "Preserve key facts, preferences, names, and decisions. " +
          "Keep it under 500 characters.",
      },
      { role: "user", content: transcript },
    ],
    max_tokens: 300,
    temperature: 0.3,
  });
  return response.choices[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Memory context builder
// ---------------------------------------------------------------------------

async function buildMemoryContext(
  client: OpenAI,
  db: MemoryDB,
  sessionId: string
): Promise<{ context: string; messageCount: number; sessionCount: number }> {
  const pastSessionIds = db.getPastSessions(sessionId, PAST_SESSIONS_TO_LOAD);

  if (pastSessionIds.length === 0) {
    return { context: "", messageCount: 0, sessionCount: 0 };
  }

  let totalMessages = 0;
  const sessionBlocks: string[] = [];

  for (const sid of pastSessionIds) {
    const messages = db.getSessionMessages(sid);
    const userAssistantMsgs = messages.filter(
      (m) => m.role === "user" || m.role === "assistant"
    );
    if (userAssistantMsgs.length === 0) continue;

    totalMessages += userAssistantMsgs.length;
    let transcript = formatMessagesAsTranscript(userAssistantMsgs);

    if (transcript.length > MAX_CONTEXT_CHARS) {
      log(`Summarizing session ${sid.slice(0, 8)}... (${transcript.length} chars)`, "info");
      transcript = await summarizeMemory(client, userAssistantMsgs);
    }

    const timestamp = userAssistantMsgs[0]?.timestamp ?? "unknown";
    sessionBlocks.push(`[Session from ${timestamp}]\n${transcript}`);
  }

  if (sessionBlocks.length === 0) {
    return { context: "", messageCount: 0, sessionCount: 0 };
  }

  const context =
    "MEMORY FROM PAST CONVERSATIONS:\n\n" + sessionBlocks.join("\n\n---\n\n");
  return { context, messageCount: totalMessages, sessionCount: sessionBlocks.length };
}

// ---------------------------------------------------------------------------
// Chat agent
// ---------------------------------------------------------------------------

class ConversationAgent {
  private client: OpenAI;
  private db: MemoryDB;
  private sessionId: string;
  private conversation: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  constructor(client: OpenAI, db: MemoryDB, sessionId: string) {
    this.client = client;
    this.db = db;
    this.sessionId = sessionId;
  }

  async initialize(): Promise<void> {
    const { context, messageCount, sessionCount } = await buildMemoryContext(
      this.client,
      this.db,
      this.sessionId
    );

    if (context) {
      log(`Loaded ${messageCount} messages from ${sessionCount} past sessions`, "ok");
    } else {
      log("No past conversation memory found. Starting fresh.", "info");
    }

    let systemContent = SYSTEM_PROMPT;
    if (context) {
      systemContent += `\n\n${context}`;
    }

    this.conversation = [{ role: "system", content: systemContent }];
  }

  async chat(userMessage: string): Promise<string> {
    this.db.saveMessage(this.sessionId, "user", userMessage);
    this.conversation.push({ role: "user", content: userMessage });

    let assistantMessage: string;
    try {
      const response = await this.client.chat.completions.create({
        model: MODEL,
        messages: this.conversation,
        max_tokens: 1024,
        temperature: 0.7,
      });
      assistantMessage = response.choices[0]?.message?.content ?? "";
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`API error: ${errMsg}`, "error");
      assistantMessage = "I encountered an error processing your request. Please try again.";
    }

    this.db.saveMessage(this.sessionId, "assistant", assistantMessage);
    this.conversation.push({ role: "assistant", content: assistantMessage });

    return assistantMessage;
  }
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Handle --reset flag
  if (process.argv.includes("--reset")) {
    const db = new MemoryDB(DB_PATH);
    const count = db.getTotalMessageCount();
    db.reset();
    db.close();
    log(`Cleared all memory (${count} messages deleted).`, "ok");
    return;
  }

  const apiKey = validateEnv();
  const client = new OpenAI({ apiKey });
  const db = new MemoryDB(DB_PATH);
  const sessionId = randomUUID().replace(/-/g, "");

  log(`Session: ${sessionId.slice(0, 8)}...`, "info");
  log(`Model: ${MODEL}`, "info");
  log(`Database: ${DB_PATH}`, "info");

  const agent = new ConversationAgent(client, db, sessionId);

  try {
    await agent.initialize();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to initialize memory: ${errMsg}`, "error");
    log("Starting without memory context.", "warn");
  }

  console.log("\nConversation Memory Agent");
  console.log('Type your message, or "quit" to exit.\n');

  const rl = createInterface();

  try {
    while (true) {
      const userInput = (await question(rl, "You: ")).trim();

      if (!userInput) continue;
      if (["quit", "exit", "q"].includes(userInput.toLowerCase())) break;

      const response = await agent.chat(userInput);
      console.log(`\nAssistant: ${response}\n`);
    }
  } catch {
    // Handle Ctrl+C or closed input
  }

  rl.close();
  const total = db.getTotalMessageCount();
  const sessions = db.getSessionCount();
  db.close();
  log(`Session ended. Total memory: ${total} messages across ${sessions} sessions.`, "ok");
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`, "error");
  process.exit(1);
});
