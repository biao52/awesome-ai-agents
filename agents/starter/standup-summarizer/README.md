# Standup Summarizer Agent

> An agent that reads your git log and generates a structured daily standup update with what was done, what's planned, and any blockers.

## What You'll Learn

- How to use subprocess/execSync to gather data from local tools (git) for LLM context
- How to transform raw structured data (git log) into natural language summaries
- How to build a zero-config CLI tool that auto-detects its environment
- How to use low temperature for consistent, professional output

## Architecture

```
User runs agent in a git repository
    |
    v
Gather context:
    -> git log (last N days, no merges)
    -> git diff --shortstat (change summary)
    -> Current branch name + repo name
    -> TODO/TASKS file (if present)
    |
    v
Format context into structured prompt
    |
    v
GPT generates standup with three sections:
    -> Yesterday: what was accomplished
    -> Today: planned work (inferred)
    -> Blockers: any issues detected
    |
    v
Output: Formatted standup update
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Git** installed and in your PATH
- **OpenAI API key** -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
  - Free tier available with limited usage
- **Estimated cost:** ~$0.001 per standup (very small prompts)

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

4. Open `.env` and add your OpenAI API key.

5. Run the agent:
   ```bash
   # Generate standup from current repo
   python main.py

   # Look back more days
   python main.py --days 3
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
   npx tsx index.ts
   ```

## How It Works

The agent gathers context from three sources before calling the LLM. First, it runs `git log` with a custom format string that separates fields (hash, author, date, subject, body) with known delimiters for reliable parsing. It filters out merge commits (which are noise for standups) and caps at 100 commits. Second, it runs `git log --shortstat` to get aggregate change statistics (files changed, insertions, deletions). Third, it checks for TODO.md, TODO.txt, or TASKS.md in the repo root, since these often contain planned work.

All of this context is formatted into a single prompt sent to GPT-4o-mini. The system prompt instructs the model to write in first person and be specific about what was done. Temperature is set to 0.3 for consistent, professional output -- you do not want creative liberties in a standup. The model generates three sections: Yesterday (past tense, grouping related commits into logical work items), Today (inferred from patterns or TODO file), and Blockers (detected from WIP commits or incomplete work).

The agent uses `subprocess.run` (Python) or `execSync` (TypeScript) for git commands. All git operations have timeouts to prevent hanging on large repos. The agent detects the repo name from the git remote URL and falls back to the directory name.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `MODEL` | No | `gpt-4o-mini` | Override the OpenAI model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: git data gathering, LLM summarization |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Generate standup from current repo (last 24 hours)
python main.py

# Look back 2 days (useful on Mondays)
python main.py --days 2

# Scan a different repository
python main.py --repo /path/to/other/project

# Combine flags
python main.py --repo ~/projects/api --days 3

# Show help
python main.py --help
```

**Example output:**

```
🚀 Starting standup summarizer agent...
🤖 Model: gpt-4o-mini
📁 Repository: /Users/dev/projects/api
📅 Looking back: 1 day(s)

📋 Repo: api (branch: feature/auth)
🔍 Reading git log...
📊 Found 6 commit(s) in the last 1 day(s)

🤖 Generating standup update...

==================================================
  Standup Update -- api
  Wednesday, July 02, 2025
==================================================

Yesterday:
- Implemented JWT token refresh flow in the auth middleware,
  including automatic retry on expired tokens
- Fixed a race condition in the session store that caused
  intermittent 401 errors under concurrent requests
- Added unit tests for the token refresh logic (3 test files)

Today:
- Continue work on the auth feature branch -- the refresh
  flow is working but needs integration tests
- Review and address any feedback from the JWT implementation

Blockers:
- None

✅ Done!
```

## Common Issues & Troubleshooting

**"Not a git repository"**
- Make sure you are running the command inside a git repo
- Use `--repo /path/to/repo` to point to a different location

**"No commits in this period"**
- Try increasing the lookback window: `--days 3` or `--days 7`
- The agent filters out merge commits, which may reduce the count

**"git not found"**
- Make sure git is installed: `git --version`
- On macOS, you may need to install Xcode command line tools: `xcode-select --install`

**Standup is too vague**
- Write more descriptive commit messages -- the agent can only work with what git provides
- The model works best when commit subjects are clear and specific

## Extend This Example

- **Add Slack/Discord posting** -- automatically post the standup to a channel via webhook
- **Add multi-repo support** -- scan several repos and generate a combined standup
- **Add standup history** -- save past standups to a file and reference them for the "Today" section
- **Add team mode** -- generate standups for all contributors by filtering git log by author
- **Add Jira/Linear integration** -- pull assigned tickets to populate the "Today" section

## Related Examples

- [Code Review Agent](../code-review-agent) -- Another developer-focused tool that analyzes code with structured output
- [Content Repurposer](../content-repurposer) -- Shows how to transform raw text into structured formats
- [Data Analyst Agent](../data-analyst-agent) -- Another example of gathering local data and sending it to an LLM for analysis
