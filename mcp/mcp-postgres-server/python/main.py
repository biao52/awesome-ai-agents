"""
MCP Postgres Server - Python Implementation

An MCP server that exposes PostgreSQL databases as tools for AI agents.
Provides read-only queries, table introspection, and safe row insertion
with parameterized queries to prevent SQL injection.
"""

import json
import os
import re
import sys
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DATABASE_URL = os.environ.get("DATABASE_URL")

if not DATABASE_URL:
    print(
        "ERROR: DATABASE_URL environment variable is required.\n"
        "Example: DATABASE_URL=postgresql://user:password@localhost:5432/mydb",
        file=sys.stderr,
    )
    sys.exit(1)

# ---------------------------------------------------------------------------
# Database connection pool
# ---------------------------------------------------------------------------

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    """Return the shared connection pool, creating it on first access."""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=1,
            max_size=5,
            command_timeout=30,
        )
    return _pool


async def execute_query(
    sql: str, params: list[Any] | None = None
) -> list[dict[str, Any]]:
    """Execute a query and return results as a list of dicts."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        if params:
            rows = await conn.fetch(sql, *params)
        else:
            rows = await conn.fetch(sql)
        return [dict(row) for row in rows]


async def execute_one(
    sql: str, params: list[Any] | None = None
) -> dict[str, Any] | None:
    """Execute a query and return a single row as a dict."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        if params:
            row = await conn.fetchrow(sql, *params)
        else:
            row = await conn.fetchrow(sql)
        return dict(row) if row else None


# ---------------------------------------------------------------------------
# SQL safety helpers
# ---------------------------------------------------------------------------

BLOCKED_KEYWORDS = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "CREATE",
    "GRANT",
    "REVOKE",
    "COPY",
    "EXECUTE",
]

_TABLE_NAME_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def is_read_only_query(sql: str) -> bool:
    """
    Check if a SQL string is a read-only SELECT statement.
    Strips string literals before checking so that keywords inside
    quoted values are not flagged.
    """
    stripped = re.sub(r"'[^']*'", "", sql)
    upper = stripped.upper()

    for keyword in BLOCKED_KEYWORDS:
        if re.search(rf"\b{keyword}\b", upper):
            return False

    return True


def is_valid_identifier(name: str) -> bool:
    """Validate a SQL identifier (table or column name)."""
    return bool(_TABLE_NAME_RE.match(name))


# ---------------------------------------------------------------------------
# Custom JSON encoder for PostgreSQL types
# ---------------------------------------------------------------------------


class PgJsonEncoder(json.JSONEncoder):
    """JSON encoder that handles asyncpg and PostgreSQL-specific types."""

    def default(self, o: Any) -> Any:
        from datetime import date, datetime, time, timedelta
        from decimal import Decimal
        from uuid import UUID

        if isinstance(o, Decimal):
            return float(o)
        if isinstance(o, (datetime, date, time)):
            return o.isoformat()
        if isinstance(o, timedelta):
            return str(o)
        if isinstance(o, UUID):
            return str(o)
        if isinstance(o, bytes):
            return o.hex()
        return super().default(o)


def to_json(obj: Any) -> str:
    """Serialize an object to a pretty-printed JSON string."""
    return json.dumps(obj, indent=2, cls=PgJsonEncoder)


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(server: FastMCP):
    """Verify database connectivity on startup, clean up pool on shutdown."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    print("Connected to PostgreSQL successfully.", file=sys.stderr)
    yield
    if _pool is not None:
        await _pool.close()


mcp = FastMCP(
    "postgres-server",
    description="MCP server exposing PostgreSQL as tools for AI agents",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Tool: query
# ---------------------------------------------------------------------------


@mcp.tool()
async def query(sql: str) -> str:
    """
    Execute a read-only SQL query against the database.

    Only SELECT statements are allowed. INSERT, UPDATE, DELETE, DROP,
    and other mutation statements are blocked for safety.

    Args:
        sql: The SQL SELECT query to execute.
    """
    if not is_read_only_query(sql):
        return (
            "Error: Only read-only SELECT queries are allowed. "
            "Use the insert_row tool for inserts, or connect directly "
            "for other mutation operations."
        )

    try:
        rows = await execute_query(sql)
        return to_json({"rows": rows, "row_count": len(rows)})
    except Exception as e:
        return f"Query error: {e}"


# ---------------------------------------------------------------------------
# Tool: list_tables
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_tables() -> str:
    """
    List all user-created tables in the public schema of the database.
    Returns table names and their types (BASE TABLE or VIEW).
    """
    try:
        rows = await execute_query(
            """
            SELECT table_name, table_type
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
            """
        )

        if not rows:
            return "No tables found in the public schema."

        lines = [f"{r['table_name']} ({r['table_type']})" for r in rows]
        return "Tables in public schema:\n\n" + "\n".join(lines)
    except Exception as e:
        return f"Error listing tables: {e}"


# ---------------------------------------------------------------------------
# Tool: describe_table
# ---------------------------------------------------------------------------


@mcp.tool()
async def describe_table(table_name: str) -> str:
    """
    Describe the columns, data types, and constraints of a specific table.

    Args:
        table_name: Name of the table to describe.
    """
    if not is_valid_identifier(table_name):
        return (
            "Error: Invalid table name. "
            "Only alphanumeric characters and underscores are allowed."
        )

    try:
        # Column information
        columns = await execute_query(
            """
            SELECT
                c.column_name,
                c.data_type,
                c.character_maximum_length,
                c.numeric_precision,
                c.numeric_scale,
                c.is_nullable,
                c.column_default
            FROM information_schema.columns c
            WHERE c.table_schema = 'public'
              AND c.table_name = $1
            ORDER BY c.ordinal_position
            """,
            [table_name],
        )

        if not columns:
            return f'Table "{table_name}" not found in the public schema.'

        # Constraint information
        constraints = await execute_query(
            """
            SELECT
                tc.constraint_name,
                tc.constraint_type,
                kcu.column_name,
                ccu.table_name AS foreign_table,
                ccu.column_name AS foreign_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            LEFT JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name
              AND tc.table_schema = ccu.table_schema
            WHERE tc.table_schema = 'public'
              AND tc.table_name = $1
            ORDER BY tc.constraint_type, tc.constraint_name
            """,
            [table_name],
        )

        # Index information
        indexes = await execute_query(
            """
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = $1
            ORDER BY indexname
            """,
            [table_name],
        )

        return to_json(
            {
                "table": table_name,
                "columns": columns,
                "constraints": constraints,
                "indexes": indexes,
            }
        )
    except Exception as e:
        return f"Error describing table: {e}"


# ---------------------------------------------------------------------------
# Tool: insert_row
# ---------------------------------------------------------------------------


@mcp.tool()
async def insert_row(table: str, data: dict[str, Any]) -> str:
    """
    Insert a single row into a table using parameterized queries
    to prevent SQL injection.

    Args:
        table: Name of the table to insert into.
        data: Object mapping column names to values.
              Keys must be valid column names (alphanumeric and underscores).
    """
    if not is_valid_identifier(table):
        return (
            "Error: Invalid table name. "
            "Only alphanumeric characters and underscores are allowed."
        )

    if not data:
        return "Error: data object must contain at least one column."

    columns = list(data.keys())
    values = list(data.values())

    # Validate all column names to prevent injection through keys.
    for col in columns:
        if not is_valid_identifier(col):
            return (
                f'Error: Invalid column name "{col}". '
                "Only alphanumeric characters and underscores are allowed."
            )

    placeholders = [f"${i + 1}" for i in range(len(columns))]
    col_list = ", ".join(columns)
    val_list = ", ".join(placeholders)

    sql = f"INSERT INTO {table} ({col_list}) VALUES ({val_list}) RETURNING *"

    try:
        row = await execute_one(sql, values)
        return to_json({"inserted": row, "row_count": 1})
    except Exception as e:
        return f"Insert error: {e}"


# ---------------------------------------------------------------------------
# Resources: expose table schemas
# ---------------------------------------------------------------------------


@mcp.resource("postgres://tables/{table_name}/schema")
async def table_schema_resource(table_name: str) -> str:
    """Schema information for a specific table in the database."""
    if not is_valid_identifier(table_name):
        return to_json({"error": "Invalid table name"})

    try:
        columns = await execute_query(
            """
            SELECT
                column_name,
                data_type,
                is_nullable,
                column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = $1
            ORDER BY ordinal_position
            """,
            [table_name],
        )

        return to_json({"table": table_name, "columns": columns})
    except Exception as e:
        return to_json({"error": str(e)})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run(transport="stdio")
