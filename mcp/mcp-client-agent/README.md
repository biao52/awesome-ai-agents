# MCP Client Agent

An agent that connects to multiple MCP servers, discovers their tools at startup, and dynamically routes tool calls to the correct server. Demonstrates the core MCP client pattern for building agents that compose capabilities from independent services.

## What You'll Learn

- How to build an MCP client that discovers tools from multiple servers
- Dynamic tool routing based on tool name to server mapping
- Composing results from multiple data sources in a single agent response
- The MCP client/server architecture and how tools are exposed and consumed

## Architecture

```
User asks a question
    |
Agent receives unified tool list (merged from all servers)
    |
LLM decides which tools to call
    |
MCP Client routes each tool call to the correct server:
    +---> Database Server --> query_db, list_tables
    +---> GitHub Server   --> search_repos, list_issues
    |
Agent synthesizes results from all servers into one response
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- OpenAI API key -- get one at [platform.openai.com](https://platform.openai.com/api-keys)

No external MCP servers required. This example uses simulated in-process servers for portability.

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

The agent follows the MCP client pattern. At startup, the `MCPClient` class connects to each server and calls its `tools()` method to discover what operations are available. It builds a mapping from tool name to server, so when the LLM calls a tool, the client knows exactly where to route it.

Each simulated server is a self-contained class with its own data and tool implementations. The `DatabaseServer` exposes `query_db` and `list_tables` against an in-memory project management database with users, projects, and tasks. The `GitHubServer` exposes `search_repos` and `list_issues` against sample repository and issue data. In production, these would be separate processes communicating over stdio or SSE using the MCP protocol.

The agent loop sends the merged tool list to OpenAI. When the model decides to call a tool, the client routes the call to the right server, gets the result, and feeds it back. The model can call tools from different servers in sequence to answer complex questions that span multiple data sources, like "Find all database-related issues in GitHub and check if the users table has any admins who filed them."

This separation of concerns is the key insight of MCP: servers are independent, reusable tool providers. The client handles discovery and routing. You can add a new server without changing any existing code.

### Tool Discovery

When the client connects to a server, it gets back a list of tool definitions in the standard OpenAI function calling format. Each definition includes the tool name, a description, and a JSON schema for the parameters. The client merges these into a single list and passes them all to the LLM. From the model's perspective, it just sees a flat list of available tools -- it does not need to know which server provides which tool.

### Routing

The client maintains an internal `tool_to_server` map. When the model calls `query_db`, the client looks up that tool name, finds it belongs to the `DatabaseServer`, and forwards the call there. When it calls `search_repos`, the client routes to the `GitHubServer`. This lookup is O(1) and happens transparently.

### Cross-Server Composition

The most powerful aspect of this pattern is cross-server queries. When you ask "Who are the admins in our database, and what GitHub issues have they filed?", the model will first call `query_db` to find admin users, then call `list_issues` or `search_repos` on the GitHub server using information from the database results. The agent composes the final answer from both data sources.

### Simulated vs Real Servers

This example uses in-process classes to simulate MCP servers. To connect to real MCP servers, you would replace each class with a subprocess connection that speaks the MCP protocol over stdio. The `MCPServer` interface stays the same -- `tools()` for discovery, `execute()` for invocation. The `@modelcontextprotocol/sdk` (TypeScript) and `mcp` (Python) packages handle the protocol details.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `MODEL` | No | Override the model (default: `gpt-4o-mini`) |

## Key Files

| File | Purpose |
| --- | --- |
| `main.py` / `index.ts` | MCP client, simulated servers, agent loop, and CLI |
| -- | `MCPServer` base class defines the server interface |
| -- | `MCPClient` class handles discovery and routing |
| -- | `DatabaseServer` and `GitHubServer` are simulated tool providers |

## Sample Data

The simulated servers include realistic sample data you can query:

**Database tables:**
- `users` -- 5 users with roles (admin, editor, viewer)
- `projects` -- 4 projects with status and budget
- `tasks` -- 6 tasks linked to projects and users

**GitHub data:**
- 5 repositories under `acme-corp`
- Issues for `web-platform`, `ml-pipeline`, and `api-gateway`

## CLI Usage

```bash
# Start interactive chat
python main.py

# Example queries to try:
#   "What tables are in the database?"
#   "Show me all open issues in acme-corp/web-platform"
#   "Find repos related to 'api' and list their open issues"
#   "Who are the admins, and what GitHub issues have they filed?"
#   "What's the total budget across all active projects?"
```

## Expected Output

```
🚀 Starting MCP Client Agent...
🤖 Model: gpt-4o-mini

🔌 Connected to 'database' server -- tools: query_db, list_tables
🔌 Connected to 'github' server -- tools: search_repos, list_issues
📦 Total tools available: 4 from 2 servers

============================================================
  MCP Client Agent
  Type your questions. The agent can use tools from multiple
  servers to answer. Type 'quit' or 'exit' to stop.
============================================================

You: Find repos related to "api" and list their open issues

🛠️ Calling tool: search_repos({"query":"api"})
🔀 Routing 'search_repos' to 'github' server
🛠️ Calling tool: list_issues({"owner":"acme-corp","repo":"api-gateway","state":"open"})
🔀 Routing 'list_issues' to 'github' server

Assistant: I found 1 repo matching "api": **api-gateway** (Go, 201 stars).
Here are its 3 open issues:
1. #89 Rate limiter not respecting per-user quotas [critical]
2. #85 Add health check endpoint
3. #80 TLS certificate rotation automation
```

## Extend This Example

- **Connect to real MCP servers** -- replace the simulated servers with subprocess-based connections using `@modelcontextprotocol/sdk` or the `mcp` Python package. See the [MCP Postgres Server](../mcp-postgres-server) and [MCP GitHub Server](../mcp-github-server) examples in this repo.
- **Add more servers** -- add a file system server, a Slack server, or any other MCP-compatible tool provider. The client handles discovery automatically.
- **Parallel tool execution** -- when the model calls multiple tools in one turn, execute them concurrently with `asyncio.gather` / `Promise.all` instead of sequentially.
- **Server health checks** -- add connection monitoring and automatic reconnection for long-running agent sessions.

## Related Examples

- [MCP Postgres Server](../mcp-postgres-server) -- A real MCP server exposing PostgreSQL as tools
- [MCP GitHub Server](../mcp-github-server) -- A real MCP server for GitHub operations
- [Customer Support Agent](../../agents/starter/customer-support-agent) -- Uses RAG tools for knowledge base search
