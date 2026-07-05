# MCP GitHub Server

An MCP (Model Context Protocol) server that exposes GitHub operations as tools. Connect it to Claude Desktop, Cursor, VS Code, or any MCP-compatible client to let your AI assistant interact with GitHub repositories directly.

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io/) is an open standard for connecting AI assistants to external tools and data sources. An MCP server exposes a set of **tools** (functions with typed inputs and outputs) over a transport layer (typically stdio). When you configure an MCP client like Claude Desktop to use this server, the AI assistant can call these tools during a conversation to fetch data or take actions on your behalf.

## Available Tools

| Tool | Description |
|------|-------------|
| `search_repos` | Search GitHub repositories by query. Returns name, description, stars, language, and URL. |
| `list_issues` | List issues for a repository with state filtering (open/closed/all). |
| `create_issue` | Create a new issue in a repository. Requires write access. |
| `read_file` | Read and decode a file from a repository. Supports branch selection. |
| `list_pull_requests` | List pull requests for a repository with state filtering. |
| `get_pr_diff` | Get the unified diff for a specific pull request. |

## Prerequisites

- A GitHub Personal Access Token with `repo` and `read:org` scopes
  - Create one at: https://github.com/settings/tokens
- For TypeScript: Node.js 18+
- For Python: Python 3.10+

## Quick Start (TypeScript)

```bash
cd typescript
cp .env.example .env
# Edit .env and add your GITHUB_TOKEN

npm install
npm run dev
```

## Quick Start (Python)

```bash
cd python
cp .env.example .env
# Edit .env and add your GITHUB_TOKEN

pip install -r requirements.txt
python main.py
```

## Client Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

**TypeScript:**
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/typescript/index.ts"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

**Python:**
```json
{
  "mcpServers": {
    "github": {
      "command": "python3",
      "args": ["/absolute/path/to/python/main.py"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

Config file locations:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### Cursor

Add to your `.cursor/mcp.json` in the project root:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/typescript/index.ts"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

### VS Code

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/typescript/index.ts"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

## Architecture

```
MCP Client (Claude Desktop / Cursor / VS Code)
    |
    | stdio transport (JSON-RPC)
    |
MCP GitHub Server
    |
    | HTTPS (REST API)
    |
GitHub API (api.github.com)
```

The server acts as a bridge between MCP clients and the GitHub REST API. Each tool maps to one or more GitHub API endpoints. Authentication is handled via a personal access token passed through the `GITHUB_TOKEN` environment variable.

## Tool Details

### search_repos

Search repositories using the same query syntax as the GitHub search bar. Results are sorted by star count.

**Parameters:**
- `query` (string, required) - Search query
- `limit` (number, optional) - Max results, 1-100, default 10

### list_issues

List issues for a specific repository. The GitHub API returns pull requests in issue listings; this is standard GitHub behavior.

**Parameters:**
- `owner` (string, required) - Repository owner
- `repo` (string, required) - Repository name
- `state` (string, optional) - "open", "closed", or "all" (default: "open")

### create_issue

Create a new issue. Your token must have write access to the target repository.

**Parameters:**
- `owner` (string, required) - Repository owner
- `repo` (string, required) - Repository name
- `title` (string, required) - Issue title
- `body` (string, optional) - Issue body in Markdown

### read_file

Read and decode a single file from a repository. Works with text files up to 1 MB (GitHub API limit).

**Parameters:**
- `owner` (string, required) - Repository owner
- `repo` (string, required) - Repository name
- `path` (string, required) - File path relative to repo root
- `branch` (string, optional) - Branch or ref (defaults to repo default branch)

### list_pull_requests

List pull requests with state filtering.

**Parameters:**
- `owner` (string, required) - Repository owner
- `repo` (string, required) - Repository name
- `state` (string, optional) - "open", "closed", or "all" (default: "open")

### get_pr_diff

Get the unified diff output for a pull request.

**Parameters:**
- `owner` (string, required) - Repository owner
- `repo` (string, required) - Repository name
- `pr_number` (number, required) - Pull request number

## Error Handling

The server handles common GitHub API errors gracefully:

- **401 Unauthorized** - Invalid or expired token
- **403 Forbidden** - Insufficient permissions or rate limit exceeded (includes reset time)
- **404 Not Found** - Repository, file, or PR does not exist
- **Other errors** - Returned with status code and GitHub's error message

## Security Notes

- Never commit your `.env` file or token to version control
- Use fine-grained tokens with minimal required scopes when possible
- The `create_issue` tool requires write access; consider using a read-only token if you only need read operations

## License

MIT
