import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error(
    "GITHUB_TOKEN environment variable is required.\n" +
      "Create a token at https://github.com/settings/tokens with repo and read:org scopes."
  );
  process.exit(1);
}

const GITHUB_API = "https://api.github.com";

const headers: Record<string, string> = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "mcp-github-server/1.0",
};

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

interface GitHubErrorResponse {
  message?: string;
  documentation_url?: string;
}

class GitHubApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: GitHubErrorResponse
  ) {
    super(`GitHub API ${status} ${statusText}: ${body.message ?? "unknown error"}`);
    this.name = "GitHubApiError";
  }
}

async function githubFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
  });

  if (!res.ok) {
    let body: GitHubErrorResponse = {};
    try {
      body = (await res.json()) as GitHubErrorResponse;
    } catch {
      // non-JSON error body, ignore
    }

    if (res.status === 401) {
      throw new GitHubApiError(401, "Unauthorized", {
        message: "Invalid or expired GITHUB_TOKEN. Check your token and scopes.",
      });
    }
    if (res.status === 403) {
      const rateLimitRemaining = res.headers.get("x-ratelimit-remaining");
      if (rateLimitRemaining === "0") {
        const resetAt = res.headers.get("x-ratelimit-reset");
        const resetDate = resetAt ? new Date(Number(resetAt) * 1000).toISOString() : "unknown";
        throw new GitHubApiError(403, "Rate Limited", {
          message: `GitHub API rate limit exceeded. Resets at ${resetDate}.`,
        });
      }
      throw new GitHubApiError(403, "Forbidden", body);
    }
    if (res.status === 404) {
      throw new GitHubApiError(404, "Not Found", {
        message: body.message ?? "Resource not found. Check the owner, repo, and path.",
      });
    }

    throw new GitHubApiError(res.status, res.statusText, body);
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Type definitions for GitHub API responses
// ---------------------------------------------------------------------------

interface SearchReposResponse {
  total_count: number;
  items: Array<{
    full_name: string;
    description: string | null;
    html_url: string;
    stargazers_count: number;
    language: string | null;
    updated_at: string;
    topics: string[];
  }>;
}

interface Issue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  labels: Array<{ name: string }>;
  body: string | null;
}

interface PullRequest {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  head: { ref: string };
  base: { ref: string };
  draft: boolean;
  body: string | null;
}

interface FileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string;
  encoding: string;
}

interface CreatedIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "mcp-github-server",
  version: "1.0.0",
});

// -- search_repos -----------------------------------------------------------

server.tool(
  "search_repos",
  "Search GitHub repositories by query string. Returns repo name, description, stars, language, and URL.",
  {
    query: z.string().describe("Search query (same syntax as GitHub search bar)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe("Max results to return (1-100, default 10)"),
  },
  async ({ query, limit }) => {
    try {
      const data = await githubFetch<SearchReposResponse>(
        `/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}&sort=stars&order=desc`
      );

      const results = data.items.map((repo) => ({
        name: repo.full_name,
        description: repo.description ?? "(no description)",
        url: repo.html_url,
        stars: repo.stargazers_count,
        language: repo.language ?? "unknown",
        updated: repo.updated_at,
        topics: repo.topics,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ total_count: data.total_count, results }, null, 2),
          },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// -- list_issues ------------------------------------------------------------

server.tool(
  "list_issues",
  "List issues for a GitHub repository. Supports filtering by state (open, closed, all).",
  {
    owner: z.string().describe("Repository owner (user or organization)"),
    repo: z.string().describe("Repository name"),
    state: z
      .enum(["open", "closed", "all"])
      .default("open")
      .describe("Issue state filter (default: open)"),
  },
  async ({ owner, repo, state }) => {
    try {
      const issues = await githubFetch<Issue[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=30`
      );

      const result = issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.html_url,
        author: issue.user?.login ?? "unknown",
        created: issue.created_at,
        labels: issue.labels.map((l) => l.name),
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// -- create_issue -----------------------------------------------------------

server.tool(
  "create_issue",
  "Create a new issue in a GitHub repository. Requires repo write access.",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    title: z.string().describe("Issue title"),
    body: z.string().optional().describe("Issue body (Markdown supported)"),
  },
  async ({ owner, repo, title, body }) => {
    try {
      const created = await githubFetch<CreatedIssue>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, body: body ?? "" }),
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                number: created.number,
                title: created.title,
                url: created.html_url,
                state: created.state,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// -- read_file --------------------------------------------------------------

server.tool(
  "read_file",
  "Read a file from a GitHub repository. Returns decoded file content. Works for text files up to 1 MB.",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    path: z.string().describe("File path relative to repo root (e.g. src/index.ts)"),
    branch: z.string().optional().describe("Branch or ref name (defaults to the repo default branch)"),
  },
  async ({ owner, repo, path, branch }) => {
    try {
      const params = branch ? `?ref=${encodeURIComponent(branch)}` : "";
      const file = await githubFetch<FileContent>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}${params}`
      );

      const decoded = Buffer.from(file.content, "base64").toString("utf-8");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                path: file.path,
                size: file.size,
                sha: file.sha,
                content: decoded,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// -- list_pull_requests -----------------------------------------------------

server.tool(
  "list_pull_requests",
  "List pull requests for a GitHub repository. Supports filtering by state.",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    state: z
      .enum(["open", "closed", "all"])
      .default("open")
      .describe("PR state filter (default: open)"),
  },
  async ({ owner, repo, state }) => {
    try {
      const prs = await githubFetch<PullRequest[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=30`
      );

      const result = prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.html_url,
        author: pr.user?.login ?? "unknown",
        created: pr.created_at,
        head: pr.head.ref,
        base: pr.base.ref,
        draft: pr.draft,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// -- get_pr_diff ------------------------------------------------------------

server.tool(
  "get_pr_diff",
  "Get the diff for a specific pull request. Returns the unified diff text.",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    pr_number: z.number().int().describe("Pull request number"),
  },
  async ({ owner, repo, pr_number }) => {
    try {
      const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr_number}`;

      const res = await fetch(url, {
        headers: {
          ...headers,
          Accept: "application/vnd.github.diff",
        },
      });

      if (!res.ok) {
        let body: GitHubErrorResponse = {};
        try {
          body = (await res.json()) as GitHubErrorResponse;
        } catch {
          // ignore
        }
        throw new GitHubApiError(res.status, res.statusText, body);
      }

      const diff = await res.text();

      return {
        content: [{ type: "text" as const, text: diff }],
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function errorResult(err: unknown) {
  const message =
    err instanceof GitHubApiError
      ? `GitHub API Error (${err.status}): ${err.body.message ?? err.statusText}`
      : err instanceof Error
        ? err.message
        : String(err);

  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP GitHub Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
