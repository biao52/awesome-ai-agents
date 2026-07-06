# Git Commit Agent

> An agent that reads your git diff and generates a conventional commit message -- like having a senior engineer name your commits for you.

## What You'll Build

A CLI tool that reads your staged (or unstaged) git changes, sends the diff to Claude for analysis, and outputs a conventional commit message. With the `--apply` flag, it commits for you automatically. When you're done, you'll have a reusable commit message generator you can alias in your shell.

## What You'll Learn

- How to use the Anthropic Claude SDK for single-prompt analysis
- How to interact with git via subprocess/execSync from an agent
- How to craft a system prompt that produces consistent, formatted output
- How to implement retry logic with exponential backoff for API resilience
- How to build a CLI agent with optional side-effects (the `--apply` flag pattern)

## Architecture

```
User runs the agent in a git repo
    ┌──────────────────────────────────────────┐
    │  python main.py                          │
    │  python main.py --apply                  │
    └─────────────────┬────────────────────────┘
                      ↓
              Read git diff
              (staged first, then unstaged)
                      ↓
              Gather repo context
              (remote name, recent commits)
                      ↓
              Send diff + context to Claude
              with conventional commit prompt
                      ↓
              Claude generates commit message:
              → type(scope): subject line
              → optional body
                      ↓
              Output message to terminal
              (or apply with git commit if --apply)
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **git** installed and in PATH
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
  - Free tier includes $5 of credits
- **Estimated cost:** ~$0.001-0.005 per commit message (depends on diff size)

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

4. Open `.env` and add your Anthropic API key (get one from the link above).

5. Run the agent from any git repo with changes:
   ```bash
   python main.py
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

4. Open `.env` and add your Anthropic API key.

5. Run the agent:
   ```bash
   npx tsx index.ts
   ```

## How It Works

The agent starts by checking for staged changes (`git diff --cached`). If nothing is staged, it falls back to unstaged changes (`git diff`). This means you can either stage specific files with `git add` for a focused commit, or just let the agent look at everything you've changed. If there are no changes at all, it exits with a helpful message.

Before calling Claude, the agent gathers context: the repository name from the git remote and the last 5 commit messages. This context helps Claude match your project's commit style. If your recent commits use scopes like `feat(api):`, Claude will follow that pattern. The diff stats (files changed, insertions, deletions) are also included so Claude can gauge the scope of the change.

The system prompt enforces the Conventional Commits specification with strict rules: imperative mood, lowercase subject, no trailing period, 50-72 character limit. It instructs Claude to output ONLY the commit message with no surrounding text or markdown. This means the output can be passed directly to `git commit -m` without any parsing.

The `--apply` flag adds the side-effect of actually running `git commit`. It double-checks that there are staged changes before committing (unstaged changes can't be committed without staging first). This is a safety gate -- if you used the agent on unstaged changes, you'll need to `git add` before applying.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `MODEL` | No | `claude-sonnet-4-20250514` | Override the Claude model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: CLI parsing, git interaction, and commit message generation |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Generate a commit message (reads staged or unstaged changes)
python main.py

# Generate and apply the commit automatically
python main.py --apply

# Show help
python main.py --help
```

**Example output:**

```
🚀 Starting git commit agent...
🤖 Model: claude-sonnet-4-20250514

📋 Using staged changes (git diff --cached)
📊 Diff size: 47 lines

🔍 Analyzing changes...

💬 Suggested commit message:

────────────────────────────────────────────────────────────
feat(auth): add JWT token refresh endpoint

Add a new /auth/refresh endpoint that accepts a valid refresh
token and returns a new access token. This prevents users from
being logged out when their short-lived access token expires.
────────────────────────────────────────────────────────────

💡 To apply this commit, run again with --apply
💡 Or copy the message and run: git commit -m "<message>"
```

## Common Issues & Troubleshooting

**"Missing environment variables: ANTHROPIC_API_KEY"**
- Make sure you copied `.env.example` to `.env`: `cp .env.example .env`
- Open `.env` and replace `your-anthropic-api-key-here` with your actual key
- Your key should start with `sk-ant-`

**"Not a git repository or git error"**
- Run the agent from inside a git repository
- Make sure git is installed: `git --version`

**"No changes detected"**
- Make some changes to tracked files, or stage new files with `git add`
- Untracked files don't show up in `git diff` -- you need to `git add` them first

**"No staged changes to commit" when using --apply**
- The `--apply` flag requires staged changes. Run `git add <files>` first
- The agent may have shown unstaged changes, but `git commit` needs staged ones

## Extend This Example

- **Add interactive confirmation** -- prompt the user to accept, edit, or regenerate before committing
- **Add `--type` flag** -- force a specific commit type (e.g., `--type fix`) to override Claude's classification
- **Shell alias** -- add `alias gc="python /path/to/main.py --apply"` to your shell profile for one-command commits
- **Pre-commit hook** -- integrate as a git hook that suggests a message whenever you commit
- **Multi-model comparison** -- generate messages with two models and let the user pick

## Related Examples

- [Code Review Agent](../code-review-agent) -- Also uses Anthropic Claude for code analysis, but produces a full quality report
- [Deep Research Agent](../../advanced/deep-research-agent) -- Shows the multi-step tool-calling pattern when you need more than a single prompt
