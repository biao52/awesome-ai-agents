# OpenAI Agents SDK Quickstart

Five progressive examples demonstrating the core patterns behind the OpenAI Agents SDK, implemented with the raw OpenAI SDK. Each example builds on the previous one, culminating in a complete multi-agent customer service system.

These examples use the standard `openai` SDK to show what the Agents SDK does under the hood -- function calling, agent routing, guardrails, and structured output. Understanding these primitives makes it easier to adopt the Agents SDK or build custom agent frameworks.

## Table of Contents

1. [Examples Overview](#examples-overview)
2. [01 - Basic Agent](#01---basic-agent)
3. [02 - Agent with Tools](#02---agent-with-tools)
4. [03 - Multi-Agent Handoffs](#03---multi-agent-handoffs)
5. [04 - Input/Output Guardrails](#04---inputoutput-guardrails)
6. [05 - Full Customer Service Agent](#05---full-customer-service-agent)
7. [Architecture](#architecture)
8. [Prerequisites](#prerequisites)
9. [Quick Start (Python)](#quick-start-python)
10. [Quick Start (TypeScript)](#quick-start-typescript)
11. [Configuration](#configuration)
12. [Project Structure](#project-structure)
13. [How It Works](#how-it-works)

## Examples Overview

| # | Example | Pattern | Lines (Py/TS) |
|---|---------|---------|---------------|
| 01 | Basic Agent | System prompt + user input | ~65 / ~65 |
| 02 | Tools | Function calling with tool loop | ~105 / ~115 |
| 03 | Handoffs | Multi-agent routing via triage | ~135 / ~140 |
| 04 | Guardrails | Input/output safety checks | ~125 / ~130 |
| 05 | Full Example | All patterns combined | ~185 / ~200 |

## 01 - Basic Agent

**Pattern:** System prompt + user message -> model response

The simplest possible agent. Combines a system prompt (the agent's "personality" and instructions) with user input and returns the model's response. In the Agents SDK, this maps to creating an `Agent()` with `instructions` and calling `Runner.run()`.

**What you learn:**
- How agents are fundamentally just model calls with structured prompts
- The system prompt defines agent behavior
- Async patterns for OpenAI API calls

## 02 - Agent with Tools

**Pattern:** User message -> model decides to call tools -> execute tools -> feed results back -> final response

Adds function calling to the agent. The model can invoke `get_weather()` and `calculate()` tools, receive results, and produce a final answer. This demonstrates the tool execution loop that the Agents SDK handles automatically with the `@tool` decorator.

**What you learn:**
- OpenAI function calling schema definition
- The tool execution loop (call -> execute -> feed back -> repeat)
- How the model decides when and which tools to use
- Parallel and sequential tool calls

## 03 - Multi-Agent Handoffs

**Pattern:** Triage agent -> detect intent -> hand off to specialist -> specialist responds

Three agents work together: a triage agent analyzes user intent and routes to either a sales agent or support agent. Each specialist has its own system prompt and tools. In the Agents SDK, handoffs are declared with `Agent.handoff()` -- under the hood, they are tool calls that switch the active agent.

**What you learn:**
- Multi-agent orchestration through a triage pattern
- Handoffs as tool calls (the key insight behind the Agents SDK)
- Specialized agents with domain-specific tools
- Agent-to-agent context passing

## 04 - Input/Output Guardrails

**Pattern:** Input guardrail -> agent -> output guardrail -> safe response

Wraps an agent with safety checks. Input guardrails detect prompt injection attempts using a classifier model call. Output guardrails scan for PII (SSNs, credit cards, emails, phone numbers) and forbidden topics. In the Agents SDK, these map to `InputGuardrail` and `OutputGuardrail` classes.

**What you learn:**
- Pre-processing user input for safety
- Using a model as a classifier (injection detection)
- Rule-based output filtering (regex PII detection)
- The guardrail pipeline pattern

## 05 - Full Customer Service Agent

**Pattern:** Guardrail -> triage -> handoff -> specialist (with tools) -> structured output

Everything combined into a production-style customer service system. A triage agent routes to billing, technical, or general agents. Each specialist has tools for data retrieval (account info, billing history, system status, ticket creation). Input guardrails block unsafe messages. Results are returned as structured JSON.

**What you learn:**
- Composing all agent patterns into a real application
- Structured output for programmatic consumption
- Multi-tool specialists with iteration limits
- End-to-end agent pipeline design

## Architecture

The examples build progressively:

```
01 Basic Agent
    |
    v
02 Tools          (adds function calling)
    |
    v
03 Handoffs       (adds multi-agent routing)
    |
    v
04 Guardrails     (adds safety layer)
    |
    v
05 Full Example   (combines everything)
```

The full example's pipeline:

```
User Message
    |
    v
[Input Guardrail] -- blocks unsafe input
    |
    v
[Triage Agent] -- analyzes intent
    |
    +---> [Billing Agent] -- tools: get_account_info, get_billing_history
    |
    +---> [Technical Agent] -- tools: check_system_status, create_support_ticket
    |
    +---> [General Agent] -- no tools, general Q&A
    |
    v
[Structured JSON Output]
```

## Prerequisites

- Python 3.10+ or Node.js 18+
- An OpenAI API key with access to gpt-4o-mini (or another chat model)

## Quick Start (Python)

```bash
cd python

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY

# List all examples
python main.py

# Run a specific example
python main.py 1    # Basic agent
python main.py 2    # Tools
python main.py 3    # Handoffs
python main.py 4    # Guardrails
python main.py 5    # Full example
```

## Quick Start (TypeScript)

```bash
cd typescript

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY

# List all examples
npx tsx index.ts

# Run a specific example
npx tsx index.ts 1    # Basic agent
npx tsx index.ts 2    # Tools
npx tsx index.ts 3    # Handoffs
npx tsx index.ts 4    # Guardrails
npx tsx index.ts 5    # Full example

# Or use npm scripts
npm run example:1
npm run example:3
```

## Configuration

Both Python and TypeScript versions use the same environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `MODEL` | No | `gpt-4o-mini` | Model to use for all agents |

## Project Structure

```
openai-agents-sdk-quickstart/
├── README.md
├── python/
│   ├── .env.example
│   ├── requirements.txt
│   ├── main.py                 # Example runner/picker
│   ├── 01_basic_agent.py       # System prompt + response
│   ├── 02_tools.py             # Function calling
│   ├── 03_handoffs.py          # Multi-agent routing
│   ├── 04_guardrails.py        # Safety checks
│   └── 05_full_example.py      # All patterns combined
└── typescript/
    ├── .env.example
    ├── package.json
    ├── tsconfig.json
    ├── index.ts                # Example runner/picker
    ├── 01-basic-agent.ts       # System prompt + response
    ├── 02-tools.ts             # Function calling
    ├── 03-handoffs.ts          # Multi-agent routing
    ├── 04-guardrails.ts        # Safety checks
    └── 05-full-example.ts      # All patterns combined
```

## How It Works

These examples use the raw OpenAI SDK to demonstrate patterns that the Agents SDK abstracts away. Here is how each pattern maps:

**Agent = Model + Instructions.** An agent is a model call with a system prompt. The Agents SDK's `Agent(instructions=...)` is equivalent to setting the system message in a chat completion call.

**Tools = Function Calling.** The Agents SDK's `@tool` decorator generates the JSON schema and handles execution. These examples define the schema manually and implement the tool execution loop explicitly.

**Handoffs = Tool Calls That Switch Agents.** When a triage agent "hands off" to a specialist, it is really making a tool call. The runner detects this and switches to the target agent's system prompt and tools. The Agents SDK's `Agent.handoff()` abstracts this into a declarative API.

**Guardrails = Pre/Post Processing.** Input and output guardrails are functions that run before and after the agent. The Agents SDK runs them in parallel with the main agent for efficiency. These examples run them sequentially for clarity.

**Structured Output = JSON Response Format.** The full example returns structured JSON instead of plain text, making it easy to integrate agents into larger applications.
