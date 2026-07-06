# Secret Scanner Agent

> An agent that scans a codebase for leaked credentials and secrets using regex pattern matching, then verifies findings with Claude to filter false positives and rate severity.

## What You'll Learn

- How to build a two-phase detection system (fast regex scan + LLM verification)
- How to write regex patterns for common secret formats (AWS keys, API tokens, database URLs)
- How to use Claude for security analysis with structured JSON output
- How to walk a directory tree efficiently, skipping binaries and irrelevant files

## Architecture

```
User provides a directory to scan
    |
    v
Phase 1: File Collection
    -> Walk directory tree
    -> Skip: .git, node_modules, binaries, images, lock files
    -> Collect scannable source files
    |
    v
Phase 2: Regex Scanning
    -> 14 patterns: AWS keys, API tokens, private keys,
       passwords, database URLs, JWTs, etc.
    -> Extract matches with file, line number, context
    |
    v
Phase 3: LLM Verification (Claude)
    -> Send candidates with surrounding code context
    -> Claude classifies: real secret vs false positive
    -> Rates severity: CRITICAL / HIGH / MEDIUM / LOW
    -> Provides specific remediation advice
    |
    v
Output: Verified findings grouped by severity
        (exits with code 1 if secrets found)
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
  - Free tier includes $5 of credits
- **Estimated cost:** ~$0.005-0.02 per scan (depends on number of candidates found)

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

4. Open `.env` and add your Anthropic API key.

5. Run the agent:
   ```bash
   # Scan current directory
   python main.py

   # Scan a specific project
   python main.py --dir /path/to/project
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
   npx tsx index.ts --dir /path/to/project
   ```

## How It Works

The scanner operates in two phases to balance speed and accuracy. Phase 1 is a fast regex scan that runs entirely locally with no API calls. It walks the directory tree, skipping known irrelevant paths (node_modules, .git, binary files, images, lock files) and applies 14 regex patterns covering common secret formats: AWS access keys (AKIA prefix), OpenAI/Anthropic API keys (sk- prefix), GitHub tokens (ghp_/gho_ prefixes), Stripe keys, Slack tokens, private key headers, hardcoded passwords in config files, database connection strings with credentials, JWTs, and more.

Phase 2 sends the candidates (with 2 lines of surrounding context) to Claude for verification. This is where the real intelligence lives. Claude can distinguish between a real AWS key and a placeholder like `AKIAEXAMPLEKEYHERE`, between a hardcoded password and a password validation regex, between a live JWT and a test fixture. Each candidate gets classified as real or false positive, rated by severity (CRITICAL for production credentials, LOW for likely false positives), and tagged with a specific remediation recommendation.

Secret values are masked in the output -- only the first and last 4 characters are shown. The agent skips `.env.example` files (which contain placeholders, not real secrets) and files larger than 512KB (likely generated or binary). The `--no-llm` flag lets you run regex-only scanning when you want fast results without API costs.

The exit code is 1 when real secrets are found, making it easy to integrate into CI pipelines.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `MODEL` | No | `claude-sonnet-4-20250514` | Override the Claude model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: file walking, regex scanning, LLM verification |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Scan current directory
python main.py

# Scan a specific project
python main.py --dir /path/to/project

# Regex-only scan (no LLM, no API costs)
python main.py --dir ./src --no-llm

# Show help
python main.py --help
```

**Example output:**

```
🚀 Starting secret scanner agent...
🤖 Model: claude-sonnet-4-20250514
📁 Scanning: /path/to/project

🔍 Phase 1: Collecting files...
📄 Found 142 files to scan
🔍 Phase 1: Scanning with regex patterns...
🔎 Found 5 candidate(s) from regex scan

🤖 Phase 2: Verifying 5 candidate(s) with Claude...

============================================================
📊 Scan Results
============================================================
  Files scanned:      142
  Regex candidates:   5
  Confirmed secrets:  2

🔴 CRITICAL (1)
────────────────────────────────────────────────────────────────
  config/production.yml:12
    Type: AWS Access Key
    Value: AKIA****...****X7Q2
    Analysis: This is a valid AWS access key format in a production config
    Action: Rotate the key immediately in AWS IAM, then use environment variables

🟠 HIGH (1)
────────────────────────────────────────────────────────────────
  src/api/client.ts:34
    Type: Generic API Key
    Value: api_****...****mN9k
    Analysis: Hardcoded API key assigned to a constant
    Action: Move to environment variable, add to .gitignore

  (3 false positive(s) filtered out)

✅ Scan complete!
⚠️ 1 CRITICAL finding(s) require immediate attention!
```

## Common Issues & Troubleshooting

**Too many false positives**
- Use the default LLM verification (do not pass `--no-llm`) to filter them out
- The regex patterns are intentionally broad to avoid missing real secrets

**Scan takes too long on large repos**
- The agent skips node_modules, .git, and binary files by default
- For very large codebases, scan specific subdirectories: `--dir ./src`

**"Missing environment variables: ANTHROPIC_API_KEY"**
- Copy `.env.example` to `.env` and add your key
- For regex-only scanning without an API key, use `--no-llm`

**Permission denied errors**
- The agent silently skips files it cannot read
- On Unix, check file permissions with `ls -la`

## Extend This Example

- **Add `.secretscannerignore`** -- let users define paths and patterns to skip, similar to .gitignore
- **Add `--format json`** -- output findings as JSON for CI/CD pipeline integration
- **Add git history scanning** -- scan `git log -p` to find secrets in past commits, not just the current tree
- **Add auto-remediation** -- automatically replace detected secrets with environment variable references
- **Add custom patterns** -- let users define additional regex patterns via a config file

## Related Examples

- [Dependency Audit](../dependency-audit) -- Similar security scanning pattern, but for vulnerable packages instead of leaked secrets
- [Code Review Agent](../code-review-agent) -- Uses Claude for code analysis with structured severity output
- [Coding Agent](../../advanced/coding-agent) -- Shows filesystem tool use for reading and modifying code
