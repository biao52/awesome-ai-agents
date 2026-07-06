<p align="center">
  <h1 align="center">awesome-ai-agents</h1>
  <p align="center">
    Production-ready AI agent examples you can clone and run in 5 minutes.
    <br />
    Every example in both Python and TypeScript. No fluff, just code that works.
  </p>
</p>

<p align="center">
  <a href="#-getting-started">Getting Started</a> &bull;
  <a href="#-examples">Examples</a> &bull;
  <a href="#-contributing">Contributing</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="#-examples"><img src="https://img.shields.io/badge/examples-48-orange.svg" alt="Examples: 48"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
</p>

---

## Getting Started

```bash
git clone https://github.com/vakra-dev/awesome-ai-agents.git
cd awesome-ai-agents
```

Pick an example, follow its README. That's it. No monorepo setup, no shared dependencies, no build step.

## How This Repo Is Organized

```
awesome-ai-agents/
  agents/
    starter/       -- Your first agents. Simple, focused, one concept each.
    advanced/      -- Production patterns. Multi-step, parallel, complex.
  multi-agent/     -- Teams of agents working together.
  rag/             -- Retrieval-Augmented Generation patterns.
  mcp/             -- Model Context Protocol servers and clients.
  memory/          -- Persistent agent memory patterns.
  voice/           -- Voice and realtime agents.
  frameworks/      -- Framework-specific quickstarts.
  patterns/        -- Reusable agent patterns (streaming, retry, HITL).
```

Every example has the same structure:

```
example-name/
  README.md           -- What it does, how to set up, how it works
  python/
    main.py           -- Run with: python main.py
    requirements.txt  -- pip install -r requirements.txt
    .env.example      -- Copy to .env and add your API keys
  typescript/
    index.ts          -- Run with: npx tsx index.ts
    package.json      -- npm install
    .env.example      -- Copy to .env and add your API keys
```

## Examples

### AI Agents -- Starter

Simple, focused agents. One concept each. Great for learning the basics.

| # | Example | What It Does | Models |
|---|---------|-------------|--------|
| 1 | [Research Agent](agents/starter/research-agent) | Web research with structured markdown reports | OpenAI |
| 2 | [Code Review Agent](agents/starter/code-review-agent) | Multi-input code review with severity ratings | Anthropic |
| 3 | [Data Analyst Agent](agents/starter/data-analyst-agent) | CSV analysis with code generation and execution | OpenAI |
| 4 | [Web Scraping Agent](agents/starter/web-scraping-agent) | Structured data extraction from any URL | Anthropic |
| 5 | [Customer Support Agent](agents/starter/customer-support-agent) | RAG-based support with escalation logic | OpenAI |
| 6 | [Paper Summarizer](agents/starter/paper-summarizer) | Research paper summarization via [Reader](https://reader.dev) | OpenAI + Reader |
| 7 | [Content Repurposer](agents/starter/content-repurposer) | Turn blog posts into tweets, LinkedIn posts, emails | Anthropic + Reader |
| 8 | [Newsletter Curator](agents/starter/newsletter-curator) | Read multiple blogs, curate a newsletter digest | OpenAI + Reader |
| 9 | [Fact-Checker Agent](agents/starter/fact-checker) | Verify claims against web sources with verdicts | Anthropic + Reader |
| 10 | [Git Commit Agent](agents/starter/git-commit-agent) | Generate conventional commit messages from diffs | Anthropic |
| 11 | [Regex Generator](agents/starter/regex-generator) | Natural language to tested regex patterns | OpenAI |
| 12 | [Cron Translator](agents/starter/cron-translator) | Bidirectional cron expression translation | OpenAI |
| 13 | [Dockerfile Generator](agents/starter/dockerfile-generator) | Read a project, generate optimized Dockerfile | Anthropic |
| 14 | [SQL Agent](agents/starter/sql-agent) | Natural language queries against SQLite | OpenAI |
| 15 | [JSON Transformer](agents/starter/json-transformer) | Transform JSON with natural language instructions | OpenAI |
| 16 | [Email Drafter](agents/starter/email-drafter) | Draft professional emails with tone control | Anthropic |
| 17 | [Dependency Audit](agents/starter/dependency-audit) | Check dependencies for known vulnerabilities | OpenAI |
| 18 | [Secret Scanner](agents/starter/secret-scanner) | Scan a codebase for leaked credentials | Anthropic |
| 19 | [Standup Summarizer](agents/starter/standup-summarizer) | Generate standup updates from git log | OpenAI |

### AI Agents -- Advanced

Production-grade agents. Multi-step, parallel execution, complex orchestration.

| # | Example | What It Does | Models |
|---|---------|-------------|--------|
| 20 | [Deep Research Agent](agents/advanced/deep-research-agent) | Multi-step research with parallel search and cost tracking | Anthropic |
| 21 | [Coding Agent](agents/advanced/coding-agent) | Plan-code-test-fix loop with filesystem tools | Anthropic |
| 22 | [Computer Use Agent](agents/advanced/computer-use-agent) | Browser control via screenshots and Playwright | Anthropic |
| 23 | [Competitor Monitor](agents/advanced/competitor-monitor) | Track competitor site changes over time via [Reader](https://reader.dev) | Anthropic + Reader |
| 24 | [Lead Enrichment](agents/advanced/lead-enrichment) | Extract structured company intel from websites via [Reader](https://reader.dev) | Anthropic + Reader |
| 25 | [SEO Audit Agent](agents/advanced/seo-audit) | Crawl and analyze a site for SEO issues via [Reader](https://reader.dev) | OpenAI + Reader |
| 26 | [PR Review Agent](agents/advanced/pr-review-agent) | Fetch PR diffs from GitHub, review like a senior engineer | Anthropic |
| 27 | [Log Analyzer](agents/advanced/log-analyzer) | Find anomalies and root causes in log files | Anthropic |
| 28 | [Incident Responder](agents/advanced/incident-responder) | Triage alerts, produce incident response plans | OpenAI |
| 29 | [API Test Generator](agents/advanced/api-test-generator) | Generate test suites from OpenAPI specs | Anthropic |
| 30 | [Prompt Optimizer](agents/advanced/prompt-optimizer) | Iteratively improve prompts with test cases | OpenAI |
| 31 | [Eval Runner](agents/advanced/eval-runner) | Compare multiple models on the same task | Multi-model |
| 32 | [Fine-tune Data Generator](agents/advanced/finetune-data-gen) | Generate synthetic training data for fine-tuning | Anthropic |

### Multi-Agent Teams

Multiple agents collaborating in pipelines with handoffs and feedback loops.

| # | Example | What It Does | Models |
|---|---------|-------------|--------|
| 33 | [Software Dev Team](multi-agent/software-dev-team) | PM, Architect, Developer, Reviewer pipeline | OpenAI |
| 34 | [Content Pipeline](multi-agent/content-pipeline) | Researcher, Writer, Editor with revision loops | Anthropic |

### RAG (Retrieval-Augmented Generation)

Ground LLM responses in real data using vector search and retrieval.

| # | Example | What It Does | Models |
|---|---------|-------------|--------|
| 35 | [PDF Chatbot](rag/pdf-chatbot) | Upload a PDF, ask questions conversationally | OpenAI |
| 36 | [Codebase RAG](rag/codebase-rag) | Index and query a codebase with code-aware chunking | Anthropic |
| 37 | [Agentic RAG](rag/agentic-rag) | Smart routing: retrieve vs answer vs clarify | OpenAI |
| 38 | [Documentation Q&A](rag/docs-qa) | Crawl any docs site via [Reader](https://reader.dev), build RAG index, answer questions | OpenAI + Reader |

### MCP (Model Context Protocol)

MCP servers and clients for tool-based integrations.

| # | Example | What It Does | Models |
|---|---------|-------------|--------|
| 39 | [MCP Postgres Server](mcp/mcp-postgres-server) | Expose PostgreSQL as MCP tools | -- |
| 40 | [MCP GitHub Server](mcp/mcp-github-server) | GitHub operations as MCP tools | -- |
| 41 | [MCP Client Agent](mcp/mcp-client-agent) | Multi-server MCP client with tool routing | OpenAI |

### Memory

Persistent agent memory across sessions and conversations.

| # | Example | What It Does | Models |
|---|---------|-------------|--------|
| 42 | [Conversation Memory](memory/conversation-memory) | Remember conversations across sessions with SQLite | OpenAI |
| 43 | [Entity Memory](memory/entity-memory) | Track entities and relationships over time | Anthropic |

### Voice

Real-time voice and audio agents.

| # | Example | What It Does | Models |
|---|---------|-------------|--------|
| 44 | [Realtime Voice Agent](voice/realtime-voice-agent) | Real-time conversation via OpenAI Realtime API | OpenAI Realtime |

### Frameworks

Framework-specific quickstarts and examples.

| # | Example | What It Does | Models |
|---|---------|-------------|--------|
| 45 | [OpenAI Agents SDK](frameworks/openai-agents-sdk-quickstart) | 5 sub-examples: basic, tools, handoffs, guardrails, full | OpenAI |

### Patterns

Reusable agent patterns you can drop into any project.

| # | Example | What It Does | Models |
|---|---------|-------------|--------|
| 46 | [Human-in-the-Loop](patterns/human-in-the-loop) | Pause for approval before risky actions | OpenAI |
| 47 | [Streaming](patterns/streaming) | Stream text and tool calls in real-time | Anthropic |
| 48 | [Retry and Fallback](patterns/retry-fallback) | Exponential backoff with model fallback | Multi-model |

## API Keys You'll Need

Most examples need one or more API keys. Here's the full list:

| Provider | Key | Used By | Get One |
|----------|-----|---------|---------|
| OpenAI | `OPENAI_API_KEY` | 25+ examples | [platform.openai.com](https://platform.openai.com/api-keys) |
| Anthropic | `ANTHROPIC_API_KEY` | 20+ examples | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Reader | `READER_API_KEY` | 8 examples (web reading) | [reader.dev](https://reader.dev) |
| Tavily | `TAVILY_API_KEY` | 5 examples (web search) | [tavily.com](https://tavily.com) |
| GitHub | `GITHUB_TOKEN` | 3 examples (GitHub API) | [github.com/settings/tokens](https://github.com/settings/tokens) |

## Contributing

We welcome contributions! Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a PR.

Every new example must:
- Include both Python and TypeScript implementations
- Follow the [example template](CONTRIBUTING.md#example-structure)
- Run in under 5 minutes
- Include a README following our template

## License

MIT -- see [LICENSE](LICENSE) for details.

---

> Star this repo to stay updated with new examples!
