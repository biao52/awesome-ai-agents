# SQL Agent

> An agent that takes natural language questions and queries a SQLite database using function calling -- turning plain English into SQL, executing it, and explaining the results.

## What You'll Build

A CLI tool with a built-in sample database (users, products, orders) that lets you ask questions in plain English. The agent uses OpenAI function calling to decide what SQL to run, executes the queries safely (read-only), and interprets the results for you. It supports both interactive chat and single-question modes.

## What You'll Learn

- How to implement the **tool-use agent loop** with OpenAI function calling
- How to define tools (functions) that the LLM can call and how to dispatch results back
- How to enforce safety constraints (read-only SQL, blocking destructive operations)
- How to build an interactive multi-turn chat agent with conversation history
- How to work with SQLite in both Python (built-in) and TypeScript (better-sqlite3)

## Architecture

```
User asks a question in natural language
    ┌─────────────────────────────────────────────┐
    │  "What's the most popular product?"         │
    │  "Show me revenue by city"                  │
    └─────────────────┬───────────────────────────┘
                      ↓
              Agent decides which tools to call:
              → list_tables() -- discover schema
              → describe_table(name) -- see columns
              → run_query(sql) -- execute SELECT
                      ↓
              Tool results fed back to the agent
                      ↓
              Agent may call more tools or
              provide the final answer
                      ↓
              Natural language answer with
              formatted numbers and context
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **OpenAI API key** -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- **Estimated cost:** ~$0.001-0.005 per question (gpt-4o-mini is very cheap)
- No external database needed -- uses an in-memory SQLite database with sample data

## Quick Start

### Python

1. Navigate to the Python directory:
   ```bash
   cd python
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Set up your environment:
   ```bash
   cp .env.example .env
   ```

4. Open `.env` and add your OpenAI API key (get one from the link above).

5. Run the agent:
   ```bash
   # Interactive mode
   python main.py

   # Or ask a question directly
   python main.py "What is the total revenue by product category?"
   ```

### TypeScript

1. Navigate to the TypeScript directory:
   ```bash
   cd typescript
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your environment:
   ```bash
   cp .env.example .env
   ```

4. Open `.env` and add your OpenAI API key.

5. Run the agent:
   ```bash
   # Interactive mode
   npx tsx index.ts

   # Or ask a question directly
   npx tsx index.ts "What is the total revenue by product category?"
   ```

## How It Works

This agent demonstrates the **tool-use loop** -- the core pattern behind most useful AI agents. Instead of trying to answer questions from memory, the agent can call tools to interact with real data. The loop works like this: send the user's question to the LLM along with available tool definitions, the LLM responds with tool calls instead of a direct answer, you execute those tool calls and send the results back, and the LLM either calls more tools or gives a final answer.

The agent has three tools available. `list_tables()` returns all table names in the database. `describe_table(name)` returns the schema of a specific table including column names, types, and row counts. `run_query(sql)` executes a SELECT query and returns the results. The agent typically starts by exploring the schema (calling `list_tables` and `describe_table`), then writes and executes the appropriate SQL, and finally interprets the numbers for the user.

Safety is enforced at the tool level, not the prompt level. The `run_query` function checks that the SQL starts with SELECT and scans for dangerous keywords like DROP, DELETE, and INSERT. This means even if the LLM tries to generate a destructive query (through prompt injection or hallucination), the tool will reject it and return an error message. The LLM then sees this error and adjusts its approach. This is a key principle: never rely on the LLM to be safe -- enforce safety in your tool implementations.

The conversation history is maintained across turns in interactive mode. This means you can ask follow-up questions like "Now break that down by month" and the agent understands the context from your previous question. Each tool call and result is part of the message history, so the LLM can reference previous query results when formulating new queries.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `MODEL` | No | `gpt-4o-mini` | Override the OpenAI model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: database setup, tool definitions, agent loop, and CLI |
| `.env.example` | Template for required environment variables |

## Sample Database

The agent creates an in-memory SQLite database with three tables:

| Table | Rows | Description |
|-------|------|-------------|
| `users` | 8 | Names, emails, cities, signup dates |
| `products` | 8 | Names, categories, prices, stock levels |
| `orders` | 18 | Links users to products with quantities, totals, dates, status |

## CLI Usage

```bash
# Interactive chat mode
python main.py

# Ask a single question
python main.py "How many users signed up each month?"

# More example questions
python main.py "What is the average order value?"
python main.py "Which city has the most customers?"
python main.py "Show me the top 3 products by revenue"

# Show help
python main.py --help
```

**Example output:**

```
🚀 Starting SQL agent...
🤖 Model: gpt-4o-mini

🗄️ Creating sample database with users, products, and orders...
📋 Tables: orders, products, users

💬 Interactive mode -- type your questions below.
💡 Try: "How many users signed up each month?" or "What's the most popular product?"

You: What's the total revenue by product category?

🔧 Tool: describe_table({"table_name":"products"})
  📊 Table: products
Columns:
  - id INTEGER (PRIMARY KEY) NOT NULL...
🔧 Tool: run_query({"sql":"SELECT p.category, SUM(o.total_price) as revenue FROM orders o JOIN products p ON o.product_id = p.id GROUP BY p.category ORDER BY revenue DESC"})
  📊 category | revenue
-----------------
Electronics | 409.94
Sports | 389.93
Kitchen | 189.95...

Agent: Here's the total revenue by product category:

| Category    | Revenue   |
|-------------|-----------|
| Electronics | $409.94   |
| Sports      | $389.93   |
| Kitchen     | $189.95   |

Electronics leads with $409.94 in total revenue, followed by Sports at $389.93
and Kitchen at $189.95.
```

## Common Issues & Troubleshooting

**"Missing environment variables: OPENAI_API_KEY"**
- Make sure you copied `.env.example` to `.env`: `cp .env.example .env`
- Open `.env` and replace `your-openai-api-key-here` with your actual key
- Your key should start with `sk-`

**The agent gives wrong SQL or errors**
- The agent automatically sees SQL errors and retries with corrected queries
- If it consistently fails, try rephrasing your question to be more specific
- The sample database is small -- check the schema section above for available tables

**"Reached maximum tool rounds"**
- This happens if the agent loops too many times (default: 10 rounds)
- Usually means the question is too complex -- try breaking it into simpler parts

**TypeScript: "Cannot find module 'better-sqlite3'"**
- Run `npm install` in the typescript directory
- On some systems, better-sqlite3 needs a C++ compiler for native bindings

## Extend This Example

- **Connect to a real database** -- replace the in-memory SQLite with a connection to your PostgreSQL, MySQL, or production SQLite database
- **Add a `run_mutation` tool** -- create a separate tool for INSERT/UPDATE with confirmation prompts, so the agent can write data too
- **Add visualization** -- have the agent generate simple ASCII charts or save matplotlib/chart.js visualizations for query results
- **Add query history** -- save all generated SQL to a file so you can reuse effective queries without calling the LLM again
- **Add schema caching** -- cache the `describe_table` results so the agent doesn't re-explore the schema every time

## Related Examples

- [Research Agent](../research-agent) -- Also uses the tool-use loop, but with web search tools instead of database tools
- [Customer Support Agent](../customer-support-agent) -- Combines tool calling with RAG for knowledge base search
- [Data Analyst Agent](../data-analyst-agent) -- Generates and executes Python code for data analysis instead of SQL
