"""
MCP Client Agent -- Connects to multiple MCP servers and routes tool calls.

Demonstrates the MCP client pattern: discovering tools from multiple servers,
presenting a unified tool list to the LLM, and routing calls to the correct
server based on tool name.

This example uses simulated MCP servers (in-process tool providers) for
portability. The pattern is identical to connecting to real MCP servers
over stdio or SSE -- swap the simulated servers for real subprocess-based
connections to make it production-ready.
"""

import os
import sys
import json
import asyncio
from typing import Any
from abc import ABC, abstractmethod

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Simulated MCP Server base class
# ---------------------------------------------------------------------------

class MCPServer(ABC):
    """
    Base class for simulated MCP servers.

    In a real MCP setup, this would be a subprocess communicating over stdio
    or an SSE connection. The interface is the same: discover tools and
    execute them by name.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable server name."""
        ...

    @abstractmethod
    def tools(self) -> list[dict[str, Any]]:
        """Return tool definitions in OpenAI function calling format."""
        ...

    @abstractmethod
    async def execute(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Execute a tool by name and return the result as a string."""
        ...


# ---------------------------------------------------------------------------
# Simulated MCP Server: Database
# ---------------------------------------------------------------------------

# In-memory sample data for the database server
_TABLES = {
    "users": {
        "columns": ["id", "name", "email", "role", "created_at"],
        "rows": [
            {"id": 1, "name": "Alice Chen", "email": "alice@example.com", "role": "admin", "created_at": "2024-01-15"},
            {"id": 2, "name": "Bob Martinez", "email": "bob@example.com", "role": "editor", "created_at": "2024-02-20"},
            {"id": 3, "name": "Carol Johnson", "email": "carol@example.com", "role": "viewer", "created_at": "2024-03-10"},
            {"id": 4, "name": "David Kim", "email": "david@example.com", "role": "editor", "created_at": "2024-04-05"},
            {"id": 5, "name": "Eve Wilson", "email": "eve@example.com", "role": "admin", "created_at": "2024-05-01"},
        ],
    },
    "projects": {
        "columns": ["id", "name", "owner_id", "status", "budget"],
        "rows": [
            {"id": 1, "name": "Website Redesign", "owner_id": 1, "status": "active", "budget": 50000},
            {"id": 2, "name": "Mobile App", "owner_id": 2, "status": "active", "budget": 120000},
            {"id": 3, "name": "Data Pipeline", "owner_id": 1, "status": "completed", "budget": 35000},
            {"id": 4, "name": "API Gateway", "owner_id": 4, "status": "planning", "budget": 25000},
        ],
    },
    "tasks": {
        "columns": ["id", "project_id", "title", "assignee_id", "status", "priority"],
        "rows": [
            {"id": 1, "project_id": 1, "title": "Design homepage mockup", "assignee_id": 2, "status": "done", "priority": "high"},
            {"id": 2, "project_id": 1, "title": "Implement responsive layout", "assignee_id": 3, "status": "in_progress", "priority": "high"},
            {"id": 3, "project_id": 2, "title": "Set up React Native project", "assignee_id": 4, "status": "done", "priority": "medium"},
            {"id": 4, "project_id": 2, "title": "Build authentication flow", "assignee_id": 2, "status": "in_progress", "priority": "high"},
            {"id": 5, "project_id": 3, "title": "Write ETL scripts", "assignee_id": 1, "status": "done", "priority": "medium"},
            {"id": 6, "project_id": 4, "title": "Draft API specification", "assignee_id": 4, "status": "todo", "priority": "low"},
        ],
    },
}


class DatabaseServer(MCPServer):
    """Simulated MCP server that exposes database operations as tools."""

    @property
    def name(self) -> str:
        return "database"

    def tools(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": "query_db",
                    "description": (
                        "Run a SQL-like query against the database. "
                        "Supports SELECT with WHERE, ORDER BY, and LIMIT clauses. "
                        "Tables: users, projects, tasks. "
                        "Example: SELECT * FROM users WHERE role = 'admin'"
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "sql": {
                                "type": "string",
                                "description": "The SQL query to execute (read-only).",
                            },
                        },
                        "required": ["sql"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "list_tables",
                    "description": "List all available database tables with their column names.",
                    "parameters": {
                        "type": "object",
                        "properties": {},
                    },
                },
            },
        ]

    async def execute(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Execute a database tool."""
        if tool_name == "list_tables":
            return await self._list_tables()
        elif tool_name == "query_db":
            return await self._query_db(arguments.get("sql", ""))
        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    async def _list_tables(self) -> str:
        """List all tables and their schemas."""
        result = {}
        for table_name, table_data in _TABLES.items():
            result[table_name] = {
                "columns": table_data["columns"],
                "row_count": len(table_data["rows"]),
            }
        return json.dumps(result, indent=2)

    async def _query_db(self, sql: str) -> str:
        """
        Execute a simplified SQL query against in-memory data.

        This is intentionally simple -- it parses basic SELECT statements
        and filters rows. A real MCP server would use an actual database driver.
        """
        sql_lower = sql.strip().lower()

        if not sql_lower.startswith("select"):
            return json.dumps({"error": "Only SELECT queries are supported (read-only)."})

        # Parse table name from "FROM <table>"
        table_name = self._extract_table_name(sql_lower)
        if table_name not in _TABLES:
            available = ", ".join(_TABLES.keys())
            return json.dumps({"error": f"Table '{table_name}' not found. Available: {available}"})

        table = _TABLES[table_name]
        rows = list(table["rows"])

        # Apply basic WHERE filtering
        rows = self._apply_where(sql_lower, rows)

        # Apply LIMIT
        limit = self._extract_limit(sql_lower)
        if limit is not None:
            rows = rows[:limit]

        return json.dumps({"table": table_name, "rows": rows, "count": len(rows)}, indent=2)

    def _extract_table_name(self, sql: str) -> str:
        """Extract table name from a SQL query."""
        parts = sql.split("from")
        if len(parts) < 2:
            return ""
        after_from = parts[1].strip().split()[0]
        # Remove trailing semicolons or other punctuation
        return after_from.rstrip(";").strip()

    def _apply_where(self, sql: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Apply basic WHERE clause filtering."""
        if "where" not in sql:
            return rows

        where_clause = sql.split("where")[1].strip()
        # Remove ORDER BY, LIMIT, etc. from where clause
        for keyword in ["order by", "limit", "group by"]:
            if keyword in where_clause:
                where_clause = where_clause.split(keyword)[0].strip()

        # Handle simple "column = value" conditions
        filtered = rows
        conditions = [c.strip() for c in where_clause.split(" and ")]
        for condition in conditions:
            if "=" in condition:
                parts = condition.split("=")
                col = parts[0].strip()
                val = parts[1].strip().strip("'\"")
                try:
                    val_num = int(val)
                    filtered = [r for r in filtered if r.get(col) == val_num]
                except ValueError:
                    filtered = [r for r in filtered if str(r.get(col, "")) == val]

        return filtered

    def _extract_limit(self, sql: str) -> int | None:
        """Extract LIMIT value from a SQL query."""
        if "limit" not in sql:
            return None
        parts = sql.split("limit")
        if len(parts) < 2:
            return None
        try:
            return int(parts[1].strip().split()[0].rstrip(";"))
        except (ValueError, IndexError):
            return None


# ---------------------------------------------------------------------------
# Simulated MCP Server: GitHub
# ---------------------------------------------------------------------------

# In-memory sample data for the GitHub server
_REPOS = [
    {"name": "web-platform", "owner": "acme-corp", "description": "Main web platform monorepo", "stars": 342, "language": "TypeScript", "open_issues": 23},
    {"name": "ml-pipeline", "owner": "acme-corp", "description": "Machine learning data pipeline", "stars": 156, "language": "Python", "open_issues": 8},
    {"name": "design-system", "owner": "acme-corp", "description": "Shared UI component library", "stars": 89, "language": "TypeScript", "open_issues": 12},
    {"name": "infra-terraform", "owner": "acme-corp", "description": "Infrastructure as code configs", "stars": 45, "language": "HCL", "open_issues": 3},
    {"name": "api-gateway", "owner": "acme-corp", "description": "API gateway and routing service", "stars": 201, "language": "Go", "open_issues": 15},
]

_ISSUES = {
    "acme-corp/web-platform": [
        {"number": 142, "title": "Database connection pool exhaustion under load", "state": "open", "labels": ["bug", "database", "critical"], "author": "alice-chen"},
        {"number": 138, "title": "Migration 047 fails on PostgreSQL 16", "state": "open", "labels": ["bug", "database"], "author": "bob-martinez"},
        {"number": 135, "title": "Add dark mode support", "state": "open", "labels": ["enhancement", "ui"], "author": "carol-j"},
        {"number": 130, "title": "Fix memory leak in WebSocket handler", "state": "closed", "labels": ["bug", "performance"], "author": "david-kim"},
        {"number": 127, "title": "Upgrade to React 19", "state": "open", "labels": ["enhancement", "dependencies"], "author": "eve-w"},
    ],
    "acme-corp/ml-pipeline": [
        {"number": 56, "title": "Model training OOM on large datasets", "state": "open", "labels": ["bug", "performance"], "author": "alice-chen"},
        {"number": 52, "title": "Add support for Parquet input format", "state": "open", "labels": ["enhancement"], "author": "bob-martinez"},
        {"number": 48, "title": "Fix data validation for null values", "state": "closed", "labels": ["bug"], "author": "carol-j"},
    ],
    "acme-corp/api-gateway": [
        {"number": 89, "title": "Rate limiter not respecting per-user quotas", "state": "open", "labels": ["bug", "critical"], "author": "david-kim"},
        {"number": 85, "title": "Add health check endpoint", "state": "open", "labels": ["enhancement"], "author": "eve-w"},
        {"number": 80, "title": "TLS certificate rotation automation", "state": "open", "labels": ["enhancement", "security"], "author": "alice-chen"},
    ],
}


class GitHubServer(MCPServer):
    """Simulated MCP server that exposes GitHub operations as tools."""

    @property
    def name(self) -> str:
        return "github"

    def tools(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": "search_repos",
                    "description": (
                        "Search for repositories by keyword. "
                        "Returns matching repos with name, description, stars, and language."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "Search query to match against repo names and descriptions.",
                            },
                        },
                        "required": ["query"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "list_issues",
                    "description": (
                        "List issues for a repository. "
                        "Returns issue number, title, state, labels, and author."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "owner": {
                                "type": "string",
                                "description": "Repository owner (e.g., 'acme-corp').",
                            },
                            "repo": {
                                "type": "string",
                                "description": "Repository name (e.g., 'web-platform').",
                            },
                            "state": {
                                "type": "string",
                                "enum": ["open", "closed", "all"],
                                "description": "Filter by issue state (default: 'all').",
                            },
                        },
                        "required": ["owner", "repo"],
                    },
                },
            },
        ]

    async def execute(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Execute a GitHub tool."""
        if tool_name == "search_repos":
            return await self._search_repos(arguments.get("query", ""))
        elif tool_name == "list_issues":
            return await self._list_issues(
                arguments.get("owner", ""),
                arguments.get("repo", ""),
                arguments.get("state", "all"),
            )
        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    async def _search_repos(self, query: str) -> str:
        """Search repos by keyword match on name and description."""
        query_lower = query.lower()
        matches = [
            repo
            for repo in _REPOS
            if query_lower in repo["name"].lower()
            or query_lower in repo["description"].lower()
        ]

        if not matches:
            # Fall back to partial matching
            matches = [
                repo
                for repo in _REPOS
                if any(word in repo["name"].lower() or word in repo["description"].lower() for word in query_lower.split())
            ]

        return json.dumps({"results": matches, "total_count": len(matches)}, indent=2)

    async def _list_issues(self, owner: str, repo: str, state: str) -> str:
        """List issues for a repository, optionally filtered by state."""
        repo_key = f"{owner}/{repo}"
        issues = _ISSUES.get(repo_key, [])

        if not issues:
            available = ", ".join(_ISSUES.keys())
            return json.dumps({
                "error": f"No issues found for '{repo_key}'.",
                "available_repos": available,
            })

        if state != "all":
            issues = [i for i in issues if i["state"] == state]

        return json.dumps({"repo": repo_key, "issues": issues, "count": len(issues)}, indent=2)


# ---------------------------------------------------------------------------
# MCP Client -- discovers tools and routes calls to the correct server
# ---------------------------------------------------------------------------

class MCPClient:
    """
    Client that manages multiple MCP servers.

    Discovers tools from each server at startup, builds a unified tool list,
    and routes tool calls to the correct server at runtime.
    """

    def __init__(self) -> None:
        self._servers: list[MCPServer] = []
        self._tool_to_server: dict[str, MCPServer] = {}
        self._all_tools: list[dict[str, Any]] = []

    async def connect(self, servers: list[MCPServer]) -> None:
        """Connect to multiple MCP servers and discover their tools."""
        self._servers = servers
        self._tool_to_server = {}
        self._all_tools = []

        for server in servers:
            server_tools = server.tools()
            tool_names = []
            for tool in server_tools:
                fn_name = tool["function"]["name"]
                self._tool_to_server[fn_name] = server
                self._all_tools.append(tool)
                tool_names.append(fn_name)

            log("🔌", f"Connected to '{server.name}' server -- tools: {', '.join(tool_names)}")

        log("📦", f"Total tools available: {len(self._all_tools)} from {len(servers)} servers")

    def get_tools(self) -> list[dict[str, Any]]:
        """Return the unified tool list for the LLM."""
        return self._all_tools

    async def execute_tool(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Route a tool call to the correct server and return the result."""
        server = self._tool_to_server.get(tool_name)
        if not server:
            return json.dumps({"error": f"No server found for tool '{tool_name}'"})

        log("🔀", f"Routing '{tool_name}' to '{server.name}' server")
        result = await server.execute(tool_name, arguments)
        return result


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a helpful assistant with access to tools from multiple backend services.

You have access to tools from these servers:
1. **Database server** -- query a project management database (users, projects, tasks tables)
2. **GitHub server** -- search repositories and browse issues

When the user asks a question that spans multiple data sources, use tools from
both servers to gather the information you need, then synthesize a clear answer.

Important:
- Always explain which data sources you consulted
- When showing data, format it clearly with tables or lists
- If a query returns no results, say so explicitly
- You can call multiple tools in sequence to build a complete picture"""


async def run_agent(
    client: MCPClient,
    messages: list[dict[str, Any]],
    model: str,
) -> str:
    """Run one turn of the agent loop. Returns the assistant's final text response."""
    openai_client = AsyncOpenAI()
    tools = client.get_tools()

    while True:
        response = await openai_client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,
            temperature=0.3,
        )

        choice = response.choices[0]
        message = choice.message

        # Add assistant message to history
        messages.append(message.model_dump())

        # If no tool calls, the agent is done
        if not message.tool_calls:
            return message.content or ""

        # Process each tool call
        for tool_call in message.tool_calls:
            fn_name = tool_call.function.name
            fn_args = json.loads(tool_call.function.arguments)

            log("🛠️", f"Calling tool: {fn_name}({json.dumps(fn_args, separators=(',', ':'))})")

            try:
                result = await client.execute_tool(fn_name, fn_args)
            except Exception as e:
                result = json.dumps({"error": str(e)})
                log("❌", f"Tool error: {e}")

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result,
                }
            )


# ---------------------------------------------------------------------------
# Interactive chat loop
# ---------------------------------------------------------------------------

async def chat_loop(client: MCPClient, model: str) -> None:
    """Run an interactive chat session where the agent can use tools from all servers."""
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
    ]

    print()
    print("=" * 60)
    print("  MCP Client Agent")
    print("  Type your questions. The agent can use tools from multiple")
    print("  servers to answer. Type 'quit' or 'exit' to stop.")
    print("=" * 60)
    print()

    # Show some example queries to get the user started
    print("Try asking:")
    print("  - What tables are in the database?")
    print("  - Show me all open issues in acme-corp/web-platform")
    print("  - Find repos related to 'api' and list their open issues")
    print("  - Who are the admins in the database, and what issues have they filed?")
    print()

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n👋 Goodbye!")
            break

        if not user_input:
            continue

        if user_input.lower() in ("quit", "exit"):
            print("👋 Goodbye!")
            break

        messages.append({"role": "user", "content": user_input})

        print()
        try:
            response = await run_agent(client, messages, model)
        except Exception as e:
            print(f"❌ Error: {e}")
            # Remove the failed user message so conversation stays clean
            messages.pop()
            continue

        print(f"\nAssistant: {response}\n")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

async def main() -> None:
    """Main entry point for the MCP client agent."""
    validate_env()

    model = os.getenv("MODEL", "gpt-4o-mini")

    log("🚀", "Starting MCP Client Agent...")
    log("🤖", f"Model: {model}")
    print()

    # Create simulated MCP servers
    servers: list[MCPServer] = [
        DatabaseServer(),
        GitHubServer(),
    ]

    # Initialize the MCP client and discover tools from all servers
    client = MCPClient()
    await client.connect(servers)

    # Start interactive chat
    await chat_loop(client, model)


if __name__ == "__main__":
    asyncio.run(main())
