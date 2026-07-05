<p align="center">
  <h1 align="center">awesome-ai-agents</h1>
  <p align="center">
    Production-ready AI agent examples you can clone and run in 5 minutes.
    <br />
    Every example in both Python and TypeScript. No fluff, just code that works.
  </p>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> &bull;
  <a href="#-examples">Examples</a> &bull;
  <a href="#-contributing">Contributing</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="#-examples"><img src="https://img.shields.io/badge/examples-20-orange.svg" alt="Examples: 20"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
</p>

---

## Quick Start

```bash
git clone https://github.com/vakra-dev/awesome-ai-agents.git
cd awesome-ai-agents/agents/starter/research-agent/python
pip install -r requirements.txt && cp .env.example .env
# Add your API keys to .env, then:
python main.py
```

## Why This Repo?

- **Dual language** — Every example ships in both Python and TypeScript. Pick your stack.
- **Production patterns** — Not toy demos. Real error handling, structured output, async, type safety.
- **MCP & A2A** — Model Context Protocol servers and Agent-to-Agent protocol examples included.
- **Framework-agnostic** — Raw SDK examples alongside LangChain, CrewAI, and OpenAI Agents SDK.
- **Local-first options** — Ollama-based examples that run 100% locally, no API keys needed.

## Examples

### AI Agents

#### Starter

| # | Example | Description | Models |
|---|---------|-------------|--------|
| 1 | [Research Agent](agents/starter/research-agent) | Web research with structured markdown reports | OpenAI |
| 2 | [Code Review Agent](agents/starter/code-review-agent) | Multi-input code review with severity ratings | Anthropic |
| 3 | [Data Analyst Agent](agents/starter/data-analyst-agent) | CSV analysis with code generation & execution | OpenAI |
| 4 | [Web Scraping Agent](agents/starter/web-scraping-agent) | Structured data extraction from any URL | Anthropic |
| 5 | [Customer Support Agent](agents/starter/customer-support-agent) | RAG-based support with escalation logic | OpenAI |

#### Advanced

| # | Example | Description | Models |
|---|---------|-------------|--------|
| 6 | [Deep Research Agent](agents/advanced/deep-research-agent) | Multi-step Perplexity-style deep research | Anthropic |
| 7 | [Coding Agent](agents/advanced/coding-agent) | Plan-code-test loop with filesystem tools | Anthropic |
| 8 | [Computer Use Agent](agents/advanced/computer-use-agent) | Browser control via screenshots + Playwright | Anthropic |

#### Local (Ollama)

| # | Example | Description | Models |
|---|---------|-------------|--------|
| — | *Coming soon* | Local-only agents using Ollama | Ollama |

### Multi-Agent Teams

| # | Example | Description | Models |
|---|---------|-------------|--------|
| 9 | [Software Dev Team](multi-agent/software-dev-team) | PM → Architect → Developer → Reviewer pipeline | OpenAI |
| 10 | [Content Pipeline](multi-agent/content-pipeline) | Researcher → Writer → Editor content creation | Anthropic |

### RAG

| # | Example | Description | Models |
|---|---------|-------------|--------|
| 11 | [PDF Chatbot](rag/pdf-chatbot) | Upload a PDF, ask questions conversationally | OpenAI |
| 12 | [Codebase RAG](rag/codebase-rag) | Index and query a codebase with code-aware chunking | Anthropic |
| 13 | [Agentic RAG](rag/agentic-rag) | Smart routing — retrieve vs answer vs clarify | OpenAI |

### MCP (Model Context Protocol)

| # | Example | Description | Models |
|---|---------|-------------|--------|
| 14 | [MCP Postgres Server](mcp/mcp-postgres-server) | MCP server exposing PostgreSQL as tools | — |
| 15 | [MCP GitHub Server](mcp/mcp-github-server) | MCP server for GitHub operations | — |
| 16 | [MCP Client Agent](mcp/mcp-client-agent) | Multi-server MCP client with tool routing | OpenAI |

### A2A (Agent-to-Agent Protocol)

| # | Example | Description | Models |
|---|---------|-------------|--------|
| — | *Coming soon* | Agent-to-Agent protocol examples | — |

### Memory

| # | Example | Description | Models |
|---|---------|-------------|--------|
| 17 | [Conversation Memory](memory/conversation-memory) | Persistent memory across sessions with SQLite | OpenAI |
| 18 | [Entity Memory](memory/entity-memory) | Entity & relationship tracking over time | Anthropic |

### Voice

| # | Example | Description | Models |
|---|---------|-------------|--------|
| 19 | [Realtime Voice Agent](voice/realtime-voice-agent) | Real-time voice conversation agent | OpenAI Realtime |

### Frameworks

| # | Example | Description | Models |
|---|---------|-------------|--------|
| 20 | [OpenAI Agents SDK Quickstart](frameworks/openai-agents-sdk-quickstart) | 5 sub-examples covering the Agents SDK | OpenAI |

## Contributing

We welcome contributions! Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a PR.

Every new example must:
- Include both Python and TypeScript implementations
- Follow the [example template](CONTRIBUTING.md#example-structure)
- Run in under 5 minutes
- Include a README following our template

## License

MIT — see [LICENSE](LICENSE) for details.

---

> Star this repo to stay updated with new examples!
