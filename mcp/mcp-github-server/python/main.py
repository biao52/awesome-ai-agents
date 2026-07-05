"""MCP server that exposes GitHub operations as tools.

Uses the MCP Python SDK to serve GitHub REST API operations over stdio transport.
Designed for use with Claude Desktop, Cursor, VS Code, and other MCP clients.
"""

import os
import sys
import base64
from typing import Any

import httpx
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

load_dotenv()

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
if not GITHUB_TOKEN:
    print(
        "GITHUB_TOKEN environment variable is required.\n"
        "Create a token at https://github.com/settings/tokens with repo and read:org scopes.",
        file=sys.stderr,
    )
    sys.exit(1)

GITHUB_API = "https://api.github.com"

HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mcp-github-server/1.0",
}


# ---------------------------------------------------------------------------
# GitHub API helpers
# ---------------------------------------------------------------------------


class GitHubApiError(Exception):
    """Structured error from the GitHub API."""

    def __init__(self, status: int, message: str) -> None:
        self.status = status
        super().__init__(f"GitHub API {status}: {message}")


async def github_fetch(
    path: str,
    *,
    method: str = "GET",
    json_body: dict[str, Any] | None = None,
    extra_headers: dict[str, str] | None = None,
) -> Any:
    """Make a request to the GitHub REST API and return parsed JSON."""
    url = path if path.startswith("http") else f"{GITHUB_API}{path}"
    request_headers = {**HEADERS, **(extra_headers or {})}

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.request(
            method,
            url,
            headers=request_headers,
            json=json_body,
        )

    if not response.is_success:
        body: dict[str, Any] = {}
        try:
            body = response.json()
        except Exception:
            pass

        if response.status_code == 401:
            raise GitHubApiError(
                401,
                "Invalid or expired GITHUB_TOKEN. Check your token and scopes.",
            )

        if response.status_code == 403:
            remaining = response.headers.get("x-ratelimit-remaining")
            if remaining == "0":
                reset_at = response.headers.get("x-ratelimit-reset", "unknown")
                raise GitHubApiError(
                    403,
                    f"GitHub API rate limit exceeded. Resets at epoch {reset_at}.",
                )
            raise GitHubApiError(403, body.get("message", "Forbidden"))

        if response.status_code == 404:
            raise GitHubApiError(
                404,
                body.get("message", "Resource not found. Check the owner, repo, and path."),
            )

        raise GitHubApiError(
            response.status_code,
            body.get("message", response.reason_phrase or "Unknown error"),
        )

    return response.json()


async def github_fetch_text(
    path: str,
    *,
    extra_headers: dict[str, str] | None = None,
) -> str:
    """Make a request to the GitHub REST API and return raw text."""
    url = path if path.startswith("http") else f"{GITHUB_API}{path}"
    request_headers = {**HEADERS, **(extra_headers or {})}

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(url, headers=request_headers)

    if not response.is_success:
        body: dict[str, Any] = {}
        try:
            body = response.json()
        except Exception:
            pass
        raise GitHubApiError(
            response.status_code,
            body.get("message", response.reason_phrase or "Unknown error"),
        )

    return response.text


def format_error(err: Exception) -> str:
    """Format an exception into a user-friendly message."""
    if isinstance(err, GitHubApiError):
        return f"GitHub API Error ({err.status}): {err}"
    return str(err)


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "mcp-github-server",
    version="1.0.0",
)


# -- search_repos -----------------------------------------------------------


@mcp.tool()
async def search_repos(query: str, limit: int = 10) -> str:
    """Search GitHub repositories by query string.

    Returns repo name, description, stars, language, and URL.

    Args:
        query: Search query (same syntax as GitHub search bar).
        limit: Max results to return (1-100, default 10).
    """
    import json
    from urllib.parse import quote

    limit = max(1, min(100, limit))

    try:
        data = await github_fetch(
            f"/search/repositories?q={quote(query)}&per_page={limit}&sort=stars&order=desc"
        )

        results = [
            {
                "name": repo["full_name"],
                "description": repo.get("description") or "(no description)",
                "url": repo["html_url"],
                "stars": repo["stargazers_count"],
                "language": repo.get("language") or "unknown",
                "updated": repo["updated_at"],
                "topics": repo.get("topics", []),
            }
            for repo in data.get("items", [])
        ]

        return json.dumps(
            {"total_count": data["total_count"], "results": results},
            indent=2,
        )
    except Exception as err:
        return format_error(err)


# -- list_issues -------------------------------------------------------------


@mcp.tool()
async def list_issues(owner: str, repo: str, state: str = "open") -> str:
    """List issues for a GitHub repository.

    Supports filtering by state (open, closed, all).

    Args:
        owner: Repository owner (user or organization).
        repo: Repository name.
        state: Issue state filter -- open, closed, or all (default: open).
    """
    import json

    if state not in ("open", "closed", "all"):
        state = "open"

    try:
        from urllib.parse import quote

        issues = await github_fetch(
            f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/issues?state={state}&per_page=30"
        )

        result = [
            {
                "number": issue["number"],
                "title": issue["title"],
                "state": issue["state"],
                "url": issue["html_url"],
                "author": (issue.get("user") or {}).get("login", "unknown"),
                "created": issue["created_at"],
                "labels": [label["name"] for label in issue.get("labels", [])],
            }
            for issue in issues
        ]

        return json.dumps(result, indent=2)
    except Exception as err:
        return format_error(err)


# -- create_issue ------------------------------------------------------------


@mcp.tool()
async def create_issue(owner: str, repo: str, title: str, body: str = "") -> str:
    """Create a new issue in a GitHub repository.

    Requires repo write access on the token.

    Args:
        owner: Repository owner.
        repo: Repository name.
        title: Issue title.
        body: Issue body (Markdown supported).
    """
    import json
    from urllib.parse import quote

    try:
        created = await github_fetch(
            f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/issues",
            method="POST",
            json_body={"title": title, "body": body},
            extra_headers={"Content-Type": "application/json"},
        )

        return json.dumps(
            {
                "number": created["number"],
                "title": created["title"],
                "url": created["html_url"],
                "state": created["state"],
            },
            indent=2,
        )
    except Exception as err:
        return format_error(err)


# -- read_file ---------------------------------------------------------------


@mcp.tool()
async def read_file(owner: str, repo: str, path: str, branch: str = "") -> str:
    """Read a file from a GitHub repository.

    Returns decoded file content. Works for text files up to 1 MB.

    Args:
        owner: Repository owner.
        repo: Repository name.
        path: File path relative to repo root (e.g. src/index.ts).
        branch: Branch or ref name (defaults to the repo default branch).
    """
    import json
    from urllib.parse import quote

    try:
        params = f"?ref={quote(branch, safe='')}" if branch else ""
        file_data = await github_fetch(
            f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/contents/{path}{params}"
        )

        content_b64 = file_data.get("content", "")
        decoded = base64.b64decode(content_b64).decode("utf-8")

        return json.dumps(
            {
                "path": file_data["path"],
                "size": file_data["size"],
                "sha": file_data["sha"],
                "content": decoded,
            },
            indent=2,
        )
    except Exception as err:
        return format_error(err)


# -- list_pull_requests ------------------------------------------------------


@mcp.tool()
async def list_pull_requests(owner: str, repo: str, state: str = "open") -> str:
    """List pull requests for a GitHub repository.

    Supports filtering by state.

    Args:
        owner: Repository owner.
        repo: Repository name.
        state: PR state filter -- open, closed, or all (default: open).
    """
    import json
    from urllib.parse import quote

    if state not in ("open", "closed", "all"):
        state = "open"

    try:
        prs = await github_fetch(
            f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/pulls?state={state}&per_page=30"
        )

        result = [
            {
                "number": pr["number"],
                "title": pr["title"],
                "state": pr["state"],
                "url": pr["html_url"],
                "author": (pr.get("user") or {}).get("login", "unknown"),
                "created": pr["created_at"],
                "head": pr["head"]["ref"],
                "base": pr["base"]["ref"],
                "draft": pr.get("draft", False),
            }
            for pr in prs
        ]

        return json.dumps(result, indent=2)
    except Exception as err:
        return format_error(err)


# -- get_pr_diff -------------------------------------------------------------


@mcp.tool()
async def get_pr_diff(owner: str, repo: str, pr_number: int) -> str:
    """Get the diff for a specific pull request.

    Returns the unified diff text.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: Pull request number.
    """
    from urllib.parse import quote

    try:
        diff = await github_fetch_text(
            f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/pulls/{pr_number}",
            extra_headers={"Accept": "application/vnd.github.diff"},
        )
        return diff
    except Exception as err:
        return format_error(err)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run(transport="stdio")
