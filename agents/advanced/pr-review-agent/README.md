# PR Review Agent

> An agent that fetches a GitHub pull request diff and reviews it like a senior engineer, producing a structured report with severity-rated findings.

## What You'll Learn

- How to integrate with the GitHub API to fetch PR diffs and metadata
- How to craft a detailed code review system prompt with severity classification
- How to handle parallel API requests (fetching PR info, diff, and file list concurrently)
- How to parse multiple CLI input formats (owner/repo + number, or full URL)

## Architecture

```
User provides PR reference (owner/repo #123 or GitHub URL)
    |
    v
Fetch from GitHub API (parallel):
    -> GET /pulls/:number        (PR metadata)
    -> GET /pulls/:number (diff)  (raw diff)
    -> GET /pulls/:number/files  (changed file list)
    |
    v
Build context: title, description, file summary, full diff
    |
    v
Send to Claude with senior engineer review prompt
    |
    v
Output: Structured review with score, severity-rated findings, and fix suggestions
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
- **GitHub personal access token** -- create at [github.com/settings/tokens](https://github.com/settings/tokens)
  - Public repos: no scope needed
  - Private repos: needs `repo` scope
- **Estimated cost:** ~$0.02-0.10 per review (depends on diff size)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env   # Then add your API keys
python main.py owner/repo 123
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env   # Then add your API keys
npx tsx index.ts owner/repo 123
```

## How It Works

The agent fetches three pieces of data from GitHub in parallel: the PR metadata (title, description, author, branch), the raw diff, and the list of changed files with their addition/deletion counts. This gives Claude full context without needing to clone the repo.

The diff is sent to Claude along with a detailed system prompt that instructs it to act as a senior engineer. The prompt defines specific categories to check (security, performance, bugs, error handling, design, testing, types) and a strict output format with severity levels. Each finding must reference a specific file and line number from the diff, and every criticism must include a concrete fix suggestion.

For large diffs (over 200K characters), the agent truncates to stay within context limits. The truncation note is included so Claude knows it is working with incomplete information and does not fabricate issues about code it cannot see.

The CLI accepts two formats: `owner/repo 123` or the full GitHub PR URL `https://github.com/owner/repo/pull/123`. Both are parsed automatically.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `GITHUB_TOKEN` | Yes | -- | GitHub personal access token |
| `MODEL` | No | `claude-sonnet-4-20250514` | Override the Claude model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | CLI entry point, GitHub API calls, Claude review orchestration |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Review by owner/repo and PR number
python main.py owner/repo 123

# Review by full GitHub URL
python main.py https://github.com/owner/repo/pull/123

# Show help
python main.py --help
```

**Example output:**

```
📊 Code Review: owner/repo#123
============================================================

## Overall Assessment
Well-structured PR that adds user authentication middleware. The implementation
is solid but has one critical security issue that must be addressed.

## Score: 7/10

## Critical Issues (must fix before merge)
- **[src/auth.ts:45]** SECURITY: JWT secret is read from process.env without
  fallback validation at startup. If JWT_SECRET is unset, tokens are signed
  with `undefined`, making them trivially forgeable.
  Fix: Add startup validation that exits if JWT_SECRET is missing.

## Warnings (should fix)
- **[src/middleware.ts:23]** ERROR HANDLING: Bare catch block swallows
  authentication errors silently. Failed auth returns 500 instead of 401.
  Fix: Catch specific JWT errors and return appropriate status codes.

## What's Good
- Clean separation of auth logic from route handlers
- Good use of TypeScript generics for the token payload type
- Tests cover both valid and expired token scenarios
```

## Common Issues & Troubleshooting

**"Pull request not found"**
- Check the repository name and PR number. Private repos need a token with `repo` scope.

**"GitHub authentication failed"**
- Verify your GITHUB_TOKEN is valid and not expired. Classic tokens and fine-grained tokens both work.

**Review seems incomplete for large PRs**
- Diffs over 200K characters are truncated. For very large PRs, consider reviewing individual commits instead.

**Rate limiting**
- The agent retries automatically on rate limits with exponential backoff. If you hit persistent limits, wait a few minutes.

## Extend This Example

- Add `--output review.md` to save the review to a file
- Post the review as a GitHub PR comment via the API
- Add `--focus security` to focus the review on specific categories
- Integrate with CI/CD to run automatically on new PRs
- Add diff-aware context: fetch the full file content for files with critical findings

## Related Examples

- [Code Review Agent](../../starter/code-review-agent) -- Reviews a single file or code snippet (simpler version)
- [Coding Agent](../coding-agent) -- Writes and tests code autonomously
- [Deep Research Agent](../deep-research-agent) -- Multi-step research with source evaluation
