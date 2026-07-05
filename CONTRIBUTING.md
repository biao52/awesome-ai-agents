# Contributing to awesome-ai-agents

Thanks for your interest in contributing! This guide will help you add new examples or improve existing ones.

## Adding a New Example

### Example Structure

Every example **must** follow this exact directory structure:

```
example-name/
├── README.md              # Follows the README template below
├── python/
│   ├── main.py            # Single entry point — run with: python main.py
│   ├── requirements.txt   # Pinned major versions (e.g., openai>=1.0,<2.0)
│   └── .env.example       # All required env vars with placeholder values
├── typescript/
│   ├── index.ts           # Single entry point — run with: npx tsx index.ts
│   ├── package.json       # Dependencies + scripts
│   ├── tsconfig.json      # Strict mode TypeScript config
│   └── .env.example       # Same env vars as Python
└── assets/                # Optional: screenshots, architecture diagrams
    └── architecture.png
```

### Requirements

- [ ] Both Python and TypeScript implementations are **required**
- [ ] Each implementation must be functionally equivalent
- [ ] Entry points are always `main.py` and `index.ts`
- [ ] No Jupyter notebooks
- [ ] No Streamlit/Gradio/Chainlit UIs — CLI or API only
- [ ] Each example is fully self-contained (no shared dependencies between examples)
- [ ] `.env.example` must list every required environment variable with comments
- [ ] Example must run in under 5 minutes (setup + execution)
- [ ] No API keys or secrets in committed files

### Code Quality Checklist

#### Python
- [ ] Type hints on all functions
- [ ] async/await where appropriate (especially for API calls)
- [ ] Error handling with try/except
- [ ] pydantic for data validation where complex input/output exists
- [ ] python-dotenv for env vars
- [ ] Clear, colored status messages as the agent runs
- [ ] Docstrings on all public functions
- [ ] Target Python 3.11+

#### TypeScript
- [ ] Strict TypeScript (no `any` types)
- [ ] async/await for all API calls
- [ ] Error handling with try/catch
- [ ] zod for runtime validation where complex input/output exists
- [ ] dotenv for env vars
- [ ] Clear, colored status messages as the agent runs
- [ ] JSDoc comments on all exported functions
- [ ] Target Node.js 20+ with ESM modules

### README Template

Your example's README must follow this structure:

```markdown
# Example Name

[One-line description]

## Architecture

[ASCII diagram showing data/control flow]

## Prerequisites

- Python 3.11+ / Node.js 20+
- API key for [provider]

## Quick Start

### Python
[3-4 line setup and run instructions]

### TypeScript
[3-4 line setup and run instructions]

## How It Works

[2-4 paragraphs explaining architecture, key decisions, and patterns.
 Explain WHY, not just WHAT. Reference specific functions/classes.]

## Configuration

[Table of environment variables]

## Key Files

[Table of files and their purposes]

## Extend This Example

[3 ideas for modifications]

## Related Examples

[Links to related examples in this repo]
```

### Approved Dependencies

Only use approved packages listed in `CLAUDE.md`. If you need a package not on the list, open an issue first.

**Banned packages:**
- No `streamlit`, `gradio`, `chainlit` — we ship CLI/API, not UIs
- No `jupyter`, `ipykernel` — no notebooks
- No `flask` — use `fastapi` if an API server is needed (Python)
- No `express` — use `hono` if an API server is needed (TypeScript)
- No `mongoose`, `typeorm` — keep storage simple (SQLite, in-memory, or vector stores)

## Improving Existing Examples

- Bug fixes are always welcome
- Keep changes focused — one fix per PR
- Test both Python and TypeScript implementations
- Update the README if behavior changes

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Add or modify the example following the structure above
3. Ensure both implementations work (`python main.py` and `npx tsx index.ts`)
4. Fill out the PR template completely
5. Submit for review

## Writing Style

- Write like a senior engineer explaining to a junior — clear, direct, no fluff
- Use "you" not "the user" or "one"
- Explain WHY a pattern is used, not just what it does
- Include gotchas and common mistakes
- Keep paragraphs to 2-3 sentences max
- Code comments should explain intent, not describe what the code literally does
- No marketing language or hype words

## Questions?

Open an issue — we're happy to help!
