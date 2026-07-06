/**
 * SQL Agent -- Takes natural language questions and queries a SQLite database
 * using OpenAI function calling.
 *
 * Demonstrates the tool-use agent loop: user asks a question, the LLM decides
 * which SQL queries to run, executes them safely, and interprets the results.
 */

import "dotenv/config";
import OpenAI from "openai";
import Database from "better-sqlite3";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_TOOL_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["OPENAI_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    console.error(
      "   Get your OpenAI key at: https://platform.openai.com/api-keys"
    );
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Database setup -- in-memory SQLite with sample data
// ---------------------------------------------------------------------------

function createSampleDatabase(): Database.Database {
  const db = new Database(":memory:");

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      city TEXT NOT NULL,
      signup_date TEXT NOT NULL
    );

    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL,
      total_price REAL NOT NULL,
      order_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed'
    );

    -- Sample users
    INSERT INTO users (name, email, city, signup_date) VALUES
      ('Alice Johnson', 'alice@example.com', 'New York', '2024-01-15'),
      ('Bob Smith', 'bob@example.com', 'San Francisco', '2024-02-20'),
      ('Carol Williams', 'carol@example.com', 'Chicago', '2024-03-10'),
      ('David Brown', 'david@example.com', 'New York', '2024-04-05'),
      ('Eve Davis', 'eve@example.com', 'San Francisco', '2024-05-12'),
      ('Frank Miller', 'frank@example.com', 'Chicago', '2024-06-01'),
      ('Grace Lee', 'grace@example.com', 'Boston', '2024-07-18'),
      ('Henry Wilson', 'henry@example.com', 'Boston', '2024-08-22');

    -- Sample products
    INSERT INTO products (name, category, price, stock) VALUES
      ('Wireless Headphones', 'Electronics', 79.99, 150),
      ('Running Shoes', 'Sports', 129.99, 80),
      ('Coffee Maker', 'Kitchen', 49.99, 200),
      ('Laptop Stand', 'Electronics', 34.99, 120),
      ('Yoga Mat', 'Sports', 24.99, 300),
      ('Water Bottle', 'Sports', 14.99, 500),
      ('Desk Lamp', 'Electronics', 44.99, 90),
      ('Cookbook', 'Kitchen', 19.99, 250);

    -- Sample orders
    INSERT INTO orders (user_id, product_id, quantity, total_price, order_date, status) VALUES
      (1, 1, 1, 79.99, '2024-06-01', 'completed'),
      (1, 3, 2, 99.98, '2024-06-15', 'completed'),
      (2, 2, 1, 129.99, '2024-06-10', 'completed'),
      (2, 5, 3, 74.97, '2024-07-01', 'completed'),
      (3, 4, 1, 34.99, '2024-06-20', 'completed'),
      (3, 6, 2, 29.98, '2024-07-05', 'completed'),
      (4, 1, 1, 79.99, '2024-07-10', 'completed'),
      (4, 7, 1, 44.99, '2024-07-15', 'completed'),
      (5, 2, 1, 129.99, '2024-07-20', 'completed'),
      (5, 8, 2, 39.98, '2024-08-01', 'completed'),
      (6, 3, 1, 49.99, '2024-08-05', 'completed'),
      (6, 1, 2, 159.98, '2024-08-10', 'completed'),
      (7, 5, 1, 24.99, '2024-08-15', 'completed'),
      (7, 4, 1, 34.99, '2024-08-20', 'completed'),
      (8, 6, 5, 74.95, '2024-09-01', 'completed'),
      (1, 7, 1, 44.99, '2024-09-05', 'shipped'),
      (2, 8, 1, 19.99, '2024-09-10', 'shipped'),
      (3, 2, 1, 129.99, '2024-09-15', 'pending');
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function runQuery(db: Database.Database, sql: string): string {
  const normalized = sql.trim().toUpperCase();
  if (!normalized.startsWith("SELECT")) {
    return "Error: Only SELECT queries are allowed for safety. INSERT, UPDATE, DELETE, and DROP are blocked.";
  }

  // Block dangerous patterns even within SELECT
  const dangerous = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "ALTER",
    "CREATE",
    "TRUNCATE",
  ];
  for (const keyword of dangerous) {
    if (
      normalized.includes(`; ${keyword}`) ||
      normalized.includes(`;${keyword}`)
    ) {
      return `Error: ${keyword} operations are not allowed. Only SELECT queries are permitted.`;
    }
  }

  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all() as Record<string, unknown>[];

    if (rows.length === 0) {
      return "Query returned 0 rows.";
    }

    const columns = Object.keys(rows[0]);
    const lines: string[] = [columns.join(" | ")];
    lines.push("-".repeat(lines[0].length));

    const display = rows.slice(0, 100);
    for (const row of display) {
      lines.push(columns.map((c) => String(row[c])).join(" | "));
    }

    if (rows.length > 100) {
      lines.push(`... (${rows.length} total rows, showing first 100)`);
    }

    return lines.join("\n");
  } catch (e) {
    return `SQL Error: ${(e as Error).message}`;
  }
}

function listTables(db: Database.Database): string {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    .all() as Array<{ name: string }>;

  if (rows.length === 0) {
    return "No tables found in the database.";
  }
  return "Tables: " + rows.map((r) => r.name).join(", ");
}

function describeTable(db: Database.Database, tableName: string): string {
  // Validate table exists
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    )
    .get(tableName) as { name: string } | undefined;

  if (!exists) {
    return `Error: Table '${tableName}' does not exist.`;
  }

  const columns = db.pragma(`table_info(${tableName})`) as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;

  const lines: string[] = [`Table: ${tableName}`, "Columns:"];
  for (const col of columns) {
    const pk = col.pk ? " (PRIMARY KEY)" : "";
    const nullable = col.notnull ? " NOT NULL" : "";
    const defaultVal =
      col.dflt_value !== null ? ` DEFAULT ${col.dflt_value}` : "";
    lines.push(`  - ${col.name} ${col.type}${pk}${nullable}${defaultVal}`);
  }

  const countRow = db
    .prepare(`SELECT COUNT(*) as count FROM ${tableName}`)
    .get() as { count: number };
  lines.push(`Row count: ${countRow.count}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// OpenAI tool definitions
// ---------------------------------------------------------------------------

const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "run_query",
      description:
        "Execute a SELECT SQL query against the database and return the results. Only SELECT queries are allowed -- INSERT, UPDATE, DELETE, and DROP are blocked for safety.",
      parameters: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "The SQL SELECT query to execute",
          },
        },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tables",
      description: "List all tables in the database.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_table",
      description:
        "Get the schema of a specific table, including column names, types, constraints, and row count.",
      parameters: {
        type: "object",
        properties: {
          table_name: {
            type: "string",
            description: "The name of the table to describe",
          },
        },
        required: ["table_name"],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a helpful SQL analyst. You have access to a SQLite database and can run queries to answer the user's questions.

Your workflow:
1. First, understand what the user is asking
2. If needed, list tables and describe their schema to understand the data
3. Write and execute SQL queries to find the answer
4. Interpret the results and explain them clearly to the user

Rules:
- Always explore the schema before writing complex queries
- Only use SELECT queries (mutations are blocked)
- When presenting numbers, format them nicely (e.g., currency with $ sign, percentages with %)
- If a query returns no results, explain why and suggest alternatives
- If the question is ambiguous, ask for clarification
- Show the SQL you used so the user can learn from it`;

// ---------------------------------------------------------------------------
// Agent loop -- process a single user question
// ---------------------------------------------------------------------------

async function processQuestion(
  client: OpenAI,
  db: Database.Database,
  messages: OpenAI.ChatCompletionMessageParam[],
  model: string
): Promise<string> {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response: OpenAI.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools,
        temperature: 0.1,
      });
    } catch (e) {
      return `❌ API error: ${e}`;
    }

    const choice = response.choices[0];
    const message = choice.message;

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content || "(No response)";
    }

    // Append the assistant message with tool calls
    messages.push(message);

    // Execute each tool call
    for (const toolCall of message.tool_calls) {
      const fnName = toolCall.function.name;
      let fnArgs: Record<string, string>;
      try {
        fnArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        fnArgs = {};
      }

      log("🔧", `Tool: ${fnName}(${JSON.stringify(fnArgs)})`);

      let result: string;
      if (fnName === "run_query") {
        result = runQuery(db, fnArgs.sql || "");
      } else if (fnName === "list_tables") {
        result = listTables(db);
      } else if (fnName === "describe_table") {
        result = describeTable(db, fnArgs.table_name || "");
      } else {
        result = `Error: Unknown tool '${fnName}'`;
      }

      const preview =
        result.length > 120 ? result.slice(0, 120) + "..." : result;
      log("  📊", preview);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  return "❌ Reached maximum tool rounds without a final answer.";
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;

  log("🚀", "Starting SQL agent...");
  log("🤖", `Model: ${model}`);
  console.log();

  log("🗄️", "Creating sample database with users, products, and orders...");
  const db = createSampleDatabase();

  const tablesInfo = listTables(db);
  log("📋", tablesInfo);
  console.log();

  const client = new OpenAI();
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  const args = process.argv.slice(2);
  let directQuestion: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [QUESTION]");
      console.log();
      console.log("  QUESTION    Ask a question directly (optional)");
      console.log("  (no args)   Start interactive chat mode");
      console.log();
      console.log("Examples:");
      console.log('  npx tsx index.ts "How many orders were placed?"');
      console.log(
        '  npx tsx index.ts "What is the total revenue by product category?"'
      );
      console.log("  npx tsx index.ts");
      process.exit(0);
    } else {
      directQuestion = args[i];
      break;
    }
  }

  if (directQuestion) {
    log("❓", `Question: ${directQuestion}`);
    console.log();
    messages.push({ role: "user", content: directQuestion });
    const answer = await processQuestion(client, db, messages, model);
    console.log();
    console.log(answer);
  } else {
    log(
      "💬",
      'Interactive mode -- type your questions below.'
    );
    log(
      "💡",
      'Try: "How many users signed up each month?" or "What\'s the most popular product?"'
    );
    console.log();

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const askQuestion = (): void => {
      rl.question("You: ", async (question) => {
        question = question.trim();

        if (!question) {
          askQuestion();
          return;
        }
        if (["exit", "quit", "q"].includes(question.toLowerCase())) {
          log("👋", "Goodbye!");
          rl.close();
          db.close();
          return;
        }

        messages.push({ role: "user", content: question });

        console.log();
        const answer = await processQuestion(client, db, messages, model);
        messages.push({ role: "assistant", content: answer });

        console.log();
        console.log(`Agent: ${answer}`);
        console.log();

        askQuestion();
      });
    };

    rl.on("close", () => {
      console.log();
      log("👋", "Goodbye!");
      db.close();
      log("✅", "Done!");
    });

    askQuestion();
    return; // Don't close db here -- the rl close handler does it
  }

  db.close();
  log("✅", "Done!");
}

main().catch(console.error);
