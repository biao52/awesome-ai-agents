# Dependency Audit Agent

> An agent that reads your dependency files, checks every package against the OSV vulnerability database, and uses an LLM to summarize findings with actionable fix recommendations.

## What You'll Learn

- How to parse multiple dependency file formats (package.json, requirements.txt, Cargo.toml, go.mod)
- How to query the OSV (Open Source Vulnerabilities) API for real vulnerability data
- How to combine external API lookups with LLM-powered summarization
- How to build a CLI tool that auto-detects project type

## Architecture

```
User runs agent in a project directory
    |
    v
Auto-detect dependency files
(package.json, requirements.txt, Cargo.toml, go.mod)
    |
    v
Parse dependencies (name + version)
    |
    v
For each dependency:
    -> Query OSV API (https://api.osv.dev/v1/query)
    -> Extract severity, fixed versions, references
    |
    v
Compile findings grouped by severity
    |
    v
Send findings to GPT for summary + recommendations
    |
    v
Output: Structured report with fix commands
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **OpenAI API key** -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
  - Free tier available with limited usage
- **Estimated cost:** ~$0.001-0.005 per audit (LLM is only used for the summary)
- No OSV API key needed -- it is free and public

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
   # Auto-detect dependencies in current directory
   python main.py

   # Or audit a specific file
   python main.py --file /path/to/package.json
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

The agent has two phases. First, it parses dependency files to extract package names and versions. Each file format has its own parser -- `package.json` is straightforward JSON, `requirements.txt` uses regex for version specifiers like `>=1.0,<2.0`, `Cargo.toml` handles both `name = "1.0"` and `name = { version = "1.0" }` syntax, and `go.mod` parses the `require` block. Version prefixes (`^`, `~`, `>=`) are stripped to get the concrete version.

Second, each dependency is checked against the OSV API in batches of 5 concurrent requests. The OSV database is Google's open-source vulnerability database covering npm, PyPI, crates.io, Go, and many other ecosystems. The agent extracts severity levels, fixed versions, and reference URLs from the response. No API key is needed -- OSV is free and public.

The LLM (GPT-4o-mini) is only used at the end to generate a human-readable summary. This keeps costs minimal -- the vulnerability lookups are direct API calls with no LLM involvement. The summary includes priority actions and specific upgrade commands for the relevant ecosystem (e.g., `npm install package@version` or `pip install package==version`).

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `MODEL` | No | `gpt-4o-mini` | Override the OpenAI model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: file parsing, OSV queries, LLM summary |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Auto-detect in current directory
python main.py

# Audit a specific file
python main.py --file package.json

# Scan a different directory
python main.py --dir /path/to/project

# Show help
python main.py --help
```

**Example output:**

```
🚀 Starting dependency audit agent...
🤖 Model: gpt-4o-mini

📁 Found 1 dependency file(s)
📦 Parsing package.json (npm)...
🔍 Checking 24 dependencies against OSV database...
⚠️ Found 3 vulnerability/ies in package.json

============================================================
📊 Audit Results
============================================================
  Dependencies scanned: 24
  Vulnerabilities found: 3
  Vulnerable packages:  2

🟠 HIGH (1)
──────────────────────────────────────────────────
  lodash@4.17.15
    ID: GHSA-jf85-cpcp-j695
    Prototype Pollution in lodash
    Fix: upgrade to 4.17.21
    Ref: https://github.com/advisories/GHSA-jf85-cpcp-j695

🟡 MODERATE (2)
──────────────────────────────────────────────────
  axios@0.21.0
    ID: GHSA-42xw-2xvc-qx8m
    Server-Side Request Forgery in axios
    Fix: upgrade to 0.21.1

🤖 Generating recommendations...

💡 Recommendations
──────────────────────────────────────────────────
Your project has 2 vulnerable packages out of 24 total dependencies...

✅ Audit complete!
```

## Common Issues & Troubleshooting

**"No dependency files found"**
- Make sure you are running the agent in a directory that contains one of: package.json, requirements.txt, Cargo.toml, go.mod
- Use `--file` to point to a specific file or `--dir` to point to a different directory

**OSV API timeouts**
- The agent retries up to 3 times with exponential backoff
- If your network is slow, some large dependency lists may take a minute

**"Missing environment variables: OPENAI_API_KEY"**
- The OpenAI key is only used for the summary. All vulnerability lookups work without it.
- Copy `.env.example` to `.env` and add your key

**False positives or missing vulnerabilities**
- OSV covers most major ecosystems but may not have every CVE
- Version parsing is best-effort -- complex version ranges may not resolve perfectly

## Extend This Example

- **Add SBOM output** -- generate a Software Bill of Materials in SPDX or CycloneDX format
- **Add `--fix` flag** -- automatically update dependency versions in the file
- **Add GitHub Actions integration** -- run as a CI step and fail the build on critical vulnerabilities
- **Support monorepos** -- recursively scan subdirectories for multiple dependency files
- **Add license checking** -- flag dependencies with restrictive licenses (GPL, AGPL) alongside vulnerabilities

## Related Examples

- [Secret Scanner](../secret-scanner) -- Similar security-focused scanning, but for leaked credentials instead of vulnerable packages
- [Code Review Agent](../code-review-agent) -- Uses LLM for code quality analysis with structured severity output
- [Web Scraping Agent](../web-scraping-agent) -- Another example of combining external API calls with LLM analysis
