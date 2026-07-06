"""
SQL Agent -- Takes natural language questions and queries a SQLite database
using OpenAI function calling.

Demonstrates the tool-use agent loop: user asks a question, the LLM decides
which SQL queries to run, executes them safely, and interprets the results.
"""

import os
import sys
import json
import sqlite3
import asyncio
from typing import Any

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o-mini"
MAX_TOOL_ROUNDS = 10  # Max tool-call rounds per user question

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        print("   Get your OpenAI key at: https://platform.openai.com/api-keys")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Database setup -- in-memory SQLite with sample data
# ---------------------------------------------------------------------------


def create_sample_database() -> sqlite3.Connection:
    """Create an in-memory SQLite database with sample tables and data."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Create tables
    cursor.executescript("""
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
    """)

    conn.commit()
    return conn


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def run_query(conn: sqlite3.Connection, sql: str) -> str:
    """Execute a SELECT query and return results as a formatted string."""
    # Safety: only allow SELECT statements
    normalized = sql.strip().upper()
    if not normalized.startswith("SELECT"):
        return "Error: Only SELECT queries are allowed for safety. INSERT, UPDATE, DELETE, and DROP are blocked."

    # Block dangerous patterns even within SELECT
    dangerous = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE"]
    # Check for dangerous keywords that appear as statements (not as column/table names)
    for keyword in dangerous:
        # Look for the keyword preceded by a semicolon or at the start
        if f"; {keyword}" in normalized or f";{keyword}" in normalized:
            return f"Error: {keyword} operations are not allowed. Only SELECT queries are permitted."

    try:
        cursor = conn.execute(sql)
        columns = [desc[0] for desc in cursor.description] if cursor.description else []
        rows = cursor.fetchall()

        if not rows:
            return "Query returned 0 rows."

        # Format as a readable table
        result_lines = [" | ".join(columns)]
        result_lines.append("-" * len(result_lines[0]))
        for row in rows[:100]:  # Cap at 100 rows
            result_lines.append(" | ".join(str(val) for val in row))

        if len(rows) > 100:
            result_lines.append(f"... ({len(rows)} total rows, showing first 100)")

        return "\n".join(result_lines)

    except sqlite3.Error as e:
        return f"SQL Error: {e}"


def list_tables(conn: sqlite3.Connection) -> str:
    """List all tables in the database."""
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    tables = [row[0] for row in cursor.fetchall()]
    if not tables:
        return "No tables found in the database."
    return "Tables: " + ", ".join(tables)


def describe_table(conn: sqlite3.Connection, table_name: str) -> str:
    """Describe a table's schema (columns, types, constraints)."""
    # Validate table exists
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    )
    if not cursor.fetchone():
        return f"Error: Table '{table_name}' does not exist."

    cursor = conn.execute(f"PRAGMA table_info({table_name})")
    columns = cursor.fetchall()

    lines = [f"Table: {table_name}", "Columns:"]
    for col in columns:
        pk = " (PRIMARY KEY)" if col[5] else ""
        nullable = "" if col[3] else " NOT NULL"
        default = f" DEFAULT {col[4]}" if col[4] is not None else ""
        lines.append(f"  - {col[1]} {col[2]}{pk}{nullable}{default}")

    # Show row count
    count_cursor = conn.execute(f"SELECT COUNT(*) FROM {table_name}")
    count = count_cursor.fetchone()[0]
    lines.append(f"Row count: {count}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# OpenAI tool definitions
# ---------------------------------------------------------------------------

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "run_query",
            "description": "Execute a SELECT SQL query against the database and return the results. Only SELECT queries are allowed -- INSERT, UPDATE, DELETE, and DROP are blocked for safety.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "The SQL SELECT query to execute",
                    }
                },
                "required": ["sql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_tables",
            "description": "List all tables in the database.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "describe_table",
            "description": "Get the schema of a specific table, including column names, types, constraints, and row count.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {
                        "type": "string",
                        "description": "The name of the table to describe",
                    }
                },
                "required": ["table_name"],
            },
        },
    },
]

SYSTEM_PROMPT = """You are a helpful SQL analyst. You have access to a SQLite database and can run queries to answer the user's questions.

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
- Show the SQL you used so the user can learn from it"""


# ---------------------------------------------------------------------------
# Agent loop -- process a single user question
# ---------------------------------------------------------------------------


async def process_question(
    client: AsyncOpenAI,
    conn: sqlite3.Connection,
    messages: list[dict[str, Any]],
    model: str,
) -> str:
    """Run the agent loop for a single user question, returning the final answer."""
    for _round in range(MAX_TOOL_ROUNDS):
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=messages,
                tools=TOOLS,
                temperature=0.1,
            )
        except Exception as e:
            return f"❌ API error: {e}"

        choice = response.choices[0]
        message = choice.message

        # If no tool calls, this is the final answer
        if not message.tool_calls:
            return message.content or "(No response)"

        # Append the assistant message with tool calls
        messages.append(message.model_dump())

        # Execute each tool call
        for tool_call in message.tool_calls:
            fn_name = tool_call.function.name
            try:
                fn_args = json.loads(tool_call.function.arguments)
            except json.JSONDecodeError:
                fn_args = {}

            log("🔧", f"Tool: {fn_name}({json.dumps(fn_args, ensure_ascii=False)})")

            if fn_name == "run_query":
                result = run_query(conn, fn_args.get("sql", ""))
            elif fn_name == "list_tables":
                result = list_tables(conn)
            elif fn_name == "describe_table":
                result = describe_table(conn, fn_args.get("table_name", ""))
            else:
                result = f"Error: Unknown tool '{fn_name}'"

            # Show abbreviated result
            preview = result[:120] + "..." if len(result) > 120 else result
            log("  📊", preview)

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result,
            })

    return "❌ Reached maximum tool rounds without a final answer."


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the SQL agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)

    log("🚀", "Starting SQL agent...")
    log("🤖", f"Model: {model}")
    print()

    # Create the sample database
    log("🗄️", "Creating sample database with users, products, and orders...")
    conn = create_sample_database()

    # Show what's available
    tables_info = list_tables(conn)
    log("📋", tables_info)
    print()

    client = AsyncOpenAI()
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Check for direct question via CLI args
    args = sys.argv[1:]
    direct_question: str | None = None

    i = 0
    while i < len(args):
        if args[i] in ("--help", "-h"):
            print("Usage: python main.py [QUESTION]")
            print()
            print("  QUESTION    Ask a question directly (optional)")
            print("  (no args)   Start interactive chat mode")
            print()
            print("Examples:")
            print('  python main.py "How many orders were placed?"')
            print('  python main.py "What is the total revenue by product category?"')
            print("  python main.py")
            sys.exit(0)
        else:
            direct_question = args[i]
            i += 1
            break

    if direct_question:
        # Single question mode
        log("❓", f"Question: {direct_question}")
        print()
        messages.append({"role": "user", "content": direct_question})
        answer = await process_question(client, conn, messages, model)
        print()
        print(answer)
    else:
        # Interactive mode
        log("💬", "Interactive mode -- type your questions below.")
        log("💡", "Try: \"How many users signed up each month?\" or \"What's the most popular product?\"")
        print()

        while True:
            try:
                question = input("You: ").strip()
            except (KeyboardInterrupt, EOFError):
                print("\n")
                log("👋", "Goodbye!")
                break

            if not question:
                continue
            if question.lower() in ("exit", "quit", "q"):
                log("👋", "Goodbye!")
                break

            messages.append({"role": "user", "content": question})

            print()
            answer = await process_question(client, conn, messages, model)
            messages.append({"role": "assistant", "content": answer})

            print()
            print(f"Agent: {answer}")
            print()

    conn.close()
    log("✅", "Done!")


if __name__ == "__main__":
    asyncio.run(main())
