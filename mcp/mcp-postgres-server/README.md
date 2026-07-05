# MCP Postgres Server

An MCP (Model Context Protocol) server that exposes PostgreSQL databases as tools for AI agents. Available in both TypeScript and Python implementations.

## Overview

This server lets AI agents interact with PostgreSQL databases through a standardized MCP interface. Agents can list tables, inspect schemas, run read-only queries, and insert rows, all through safe, parameterized operations.

## Architecture

```
+------------+       stdio        +------------------+       TCP        +------------+
| MCP Client | <----------------> | MCP Postgres     | <--------------> | PostgreSQL |
| (Claude,   |   JSON-RPC over   | Server           |   Parameterized  | Database   |
|  agent)    |   stdin/stdout     | (TS or Python)   |   queries        |            |
+------------+                    +------------------+                  +------------+
```

The server acts as a bridge between MCP-compatible AI clients and a PostgreSQL database. All communication with the client uses the MCP protocol over stdio transport. All database access uses parameterized queries.

## Features

- **Read-only queries**: Execute SELECT statements safely with automatic blocking of mutation keywords
- **Table listing**: Discover all tables in the public schema
- **Schema introspection**: Get detailed column, constraint, and index information for any table
- **Safe row insertion**: Insert rows using parameterized queries that prevent SQL injection
- **MCP resources**: Access table schemas as MCP resources
- **Connection pooling**: Efficient database connection management

## Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `query` | Execute read-only SQL (SELECT only) | `sql` (string) |
| `list_tables` | List all tables in the public schema | none |
| `describe_table` | Show columns, types, constraints, indexes | `table_name` (string) |
| `insert_row` | Insert a row with parameterized query | `table` (string), `data` (object) |

## Prerequisites

- Docker and Docker Compose (for the sample database)
- Node.js 18+ (for the TypeScript implementation)
- Python 3.11+ (for the Python implementation)

## Quick Start

### 1. Start the sample database

```bash
docker compose up -d
```

This starts a PostgreSQL 16 instance with sample `products` and `orders` tables pre-loaded from `seed.sql`.

### 2a. Run the TypeScript server

```bash
cd typescript
cp .env.example .env
npm install
npx tsx index.ts
```

### 2b. Run the Python server

```bash
cd python
cp .env.example .env
pip install -r requirements.txt
python main.py
```

## Configuration

Both implementations use a single environment variable:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | (required) |

Example: `postgresql://user:password@localhost:5432/mydb`

## Claude Desktop Integration

Add this to your Claude Desktop MCP configuration (`claude_desktop_config.json`):

### TypeScript

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/typescript/index.ts"],
      "env": {
        "DATABASE_URL": "postgresql://user:password@localhost:5432/mydb"
      }
    }
  }
}
```

### Python

```json
{
  "mcpServers": {
    "postgres": {
      "command": "python",
      "args": ["/absolute/path/to/python/main.py"],
      "env": {
        "DATABASE_URL": "postgresql://user:password@localhost:5432/mydb"
      }
    }
  }
}
```

## SQL Injection Prevention

This server uses multiple layers of protection against SQL injection:

1. **Read-only query validation**: The `query` tool strips string literals and checks for mutation keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE`, `COPY`, `EXECUTE`) as whole-word matches. Only `SELECT` queries pass through.

2. **Parameterized queries**: The `insert_row` tool uses `$1`, `$2`, ... placeholders with values passed separately to the database driver. Values never appear in the SQL string itself.

3. **Identifier validation**: Table names and column names are validated against a strict regex (`^[a-zA-Z_][a-zA-Z0-9_]*$`) before being used in SQL. This prevents injection through identifier positions that cannot use parameterized placeholders.

## Sample Data

The `seed.sql` file creates two tables:

**products** (15 rows)
- `id` (SERIAL PRIMARY KEY)
- `name` (VARCHAR)
- `price` (DECIMAL)
- `category` (VARCHAR)
- `in_stock` (BOOLEAN)

**orders** (12 rows)
- `id` (SERIAL PRIMARY KEY)
- `product_id` (INTEGER, FK to products)
- `quantity` (INTEGER, CHECK > 0)
- `customer_email` (VARCHAR)
- `created_at` (TIMESTAMP)

## Project Structure

```
mcp-postgres-server/
  docker-compose.yml      # Sample PostgreSQL database
  seed.sql                # Sample schema and data
  README.md
  typescript/
    index.ts              # TypeScript MCP server
    package.json
    tsconfig.json
    .env.example
  python/
    main.py               # Python MCP server
    requirements.txt
    .env.example
```

## Development

### Building the TypeScript version

```bash
cd typescript
npm install
npm run build        # Compile to dist/
npm start            # Run compiled version
```

### Testing a tool manually

You can test the server by sending JSON-RPC messages over stdin. For example, to call `list_tables`:

```json
{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_tables", "arguments": {}}}
```

## License

MIT
