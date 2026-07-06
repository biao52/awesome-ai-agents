# Human-in-the-Loop Agent

> An agent that pauses for human approval before executing risky actions, while running safe actions automatically.

## What You'll Learn

- How to classify agent actions by risk level (safe vs dangerous)
- Implementing approval gates that pause execution for user confirmation
- Building an interactive tool-calling agent with OpenAI function calling
- Handling denied actions gracefully without breaking the conversation

## Architecture

```
User Message
    |
    v
LLM decides which tool to call
    |
    v
Is the tool in REQUIRES_APPROVAL?
   / \
  No   Yes
  |     |
  v     v
Execute    Prompt user: "Approve? [y/n]"
automatically      / \
  |              No   Yes
  v              |     |
Return         Cancel  Execute
result       + tell    + return
             LLM      result
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- API key for OpenAI -- get one at [platform.openai.com](https://platform.openai.com)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env  # Then add your API key
python main.py
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your API key
npx tsx index.ts
```

## How It Works

The agent has three tools: `search_web`, `draft_email`, and `send_email`. The first two are safe -- they don't cause side effects. The third is dangerous -- sending an email is irreversible. The pattern uses a simple set (`REQUIRES_APPROVAL`) to classify which tools need human sign-off.

When the model calls a tool, the dispatcher checks if that tool name is in the approval set. If it is, execution pauses and the user sees the full action details (recipient, subject, body) and must type `y` or `n`. If they deny, the agent receives a "cancelled" result and adapts its response accordingly.

This is the simplest form of the pattern. In production, you would extend it with: risk scoring based on parameters (sending to an external domain vs internal), audit logging of all approvals, time-based auto-approval for repeated safe patterns, or multi-person approval chains for high-stakes actions.

The key design choice is where the gate lives. It sits between the LLM's tool call decision and the actual execution -- the LLM never knows the gate exists. It just sees either a successful result or a cancellation. This keeps the pattern composable: you can add or remove gates without changing the model's system prompt or tool definitions.

## Configuration

| Variable       | Required | Description                                  |
| -------------- | -------- | -------------------------------------------- |
| `OPENAI_API_KEY` | Yes    | Your OpenAI API key                          |
| `MODEL`        | No       | Override the default model (default: gpt-4o-mini) |

## Key Files

| File                    | Purpose                                      |
| ----------------------- | -------------------------------------------- |
| `main.py` / `index.ts`  | Entry point, tool definitions, approval gate |

## When to Use This Pattern

**Use it when:**
- Your agent can take irreversible actions (send messages, delete data, make purchases)
- You need an audit trail of approved vs denied actions
- Compliance requires human oversight for certain operations
- You're building trust with users before enabling full automation

**Skip it when:**
- All actions are read-only (search, fetch, analyze)
- The agent operates in a sandbox with no real side effects
- Speed matters more than safety (batch processing pipelines)

## Classifying Risky vs Safe Actions

A simple heuristic for classifying actions:

| Safe (auto-execute)           | Risky (require approval)         |
| ----------------------------- | -------------------------------- |
| Read data, search, fetch      | Write, update, delete data       |
| Draft content                 | Send or publish content          |
| List resources                | Create or destroy resources      |
| Calculate, analyze            | Transfer money, make purchases   |
| Internal queries              | External API calls with effects  |

## Extend This Example

- Add a `--auto-approve` flag for batch/CI usage where a human has pre-approved
- Implement risk scoring: low-risk sends auto-approve, high-risk sends require 2FA
- Log all approval decisions to a file for audit compliance
- Add a "remember my choice" option for repeated similar actions
- Connect real email (SendGrid, SES) and search (Tavily) APIs

## Related Examples

- [Retry & Fallback](../retry-fallback) -- resilience patterns for when API calls fail
- [Streaming](../streaming) -- real-time output for better user experience during approvals
