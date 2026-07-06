# Incident Responder

> An agent that takes alert descriptions and system context, then produces a structured incident response plan with triage assessment, investigation steps, communication templates, and escalation criteria.

## What You'll Learn

- How to build a domain-expert agent with a deeply specialized system prompt
- How to structure complex output (incident response plans with multiple sections)
- How to support both CLI arguments and interactive input modes
- How to use OpenAI's chat completions API for single-turn expert reasoning

## Architecture

```
User provides alert + optional context
    |
    v
Build prompt with all available context:
    -> Alert description (required)
    -> Severity level (optional, auto-detected if omitted)
    -> Affected service name (optional)
    -> Runbook URL (optional)
    |
    v
Send to GPT-4o with incident commander system prompt
    |
    v
Output: Structured incident response plan
    -> Triage assessment
    -> Severity classification
    -> Immediate actions (first 15 minutes)
    -> Investigation steps with commands
    -> Likely root causes ranked by probability
    -> Mitigation options
    -> Communication templates (Slack, status page, escalation)
    -> Escalation criteria
    -> Post-incident checklist
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **OpenAI API key** -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- **Estimated cost:** ~$0.02-0.05 per response plan

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env   # Then add your API key
python main.py "High CPU usage on api-prod-01, 98% for 15 minutes" --severity high --service "API Gateway"
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env   # Then add your API key
npx tsx index.ts "High CPU usage on api-prod-01, 98% for 15 minutes" --severity high --service "API Gateway"
```

## How It Works

The agent is built around a single, deeply specialized system prompt that encodes the knowledge of an experienced incident commander. Unlike agents that use tool calling or multi-turn conversations, this agent produces its entire output in one pass. The quality comes from the prompt engineering, not from complex orchestration.

The system prompt defines a strict output format with nine sections. Each section serves a specific purpose in incident response: triage (what is happening), investigation (how to find the cause), mitigation (how to reduce impact now), and communication (who to tell what). The prompt instructs the model to include actual commands, queries, and runbook-style steps rather than generic advice.

The CLI supports two modes. Direct mode takes the alert description as a positional argument with optional `--severity`, `--service`, and `--runbook` flags. Interactive mode prompts for each field when no arguments are provided. This makes it useful both in automation (piped from alerting systems) and during live incidents (where an engineer types the alert description).

The severity parameter is optional because the agent will recommend its own severity classification based on the alert description. Providing an existing severity gives the agent context about how the alert was initially triaged, but the agent may recommend escalation or de-escalation.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `MODEL` | No | `gpt-4o` | Override the model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | CLI entry point, argument parsing, interactive mode, OpenAI API call |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Quick incident response with all context
python main.py "Database connection pool exhausted, 0 available connections" \
  --severity critical \
  --service "User Database" \
  --runbook "https://wiki.internal/runbooks/db-pool"

# Minimal -- just the alert
python main.py "5xx error rate at 15% on checkout service"

# Interactive mode (prompts for each field)
python main.py

# Show help
python main.py --help
```

**Example alerts to try:**

- `"High CPU usage on api-prod-01, 98% for 15 minutes" --severity high`
- `"Kafka consumer lag growing on payments topic, 50k messages behind" --service "Payment Processor"`
- `"SSL certificate expires in 2 hours for api.example.com" --severity critical`
- `"Memory usage at 95% on worker nodes, OOM kills observed"`
- `"Deployment of v2.3.1 failed, 3 of 5 pods in CrashLoopBackOff" --service "Order Service"`

## Common Issues & Troubleshooting

**Response plan seems generic**
- Provide more specific details in the alert description. Include hostnames, metric values, durations, and affected endpoints. The more context you give, the more specific the response plan will be.

**Commands in the response plan are wrong for my stack**
- The agent infers your stack from the alert description. Mention specific technologies (e.g., "Kubernetes", "PostgreSQL", "Redis") to get relevant commands.

**Want to use a different model**
- Set the `MODEL` environment variable. GPT-4o produces the best results, but GPT-4o-mini works for less complex incidents at lower cost.

## Extend This Example

- Pipe alerts directly from PagerDuty, OpsGenie, or Datadog webhooks
- Save response plans to a Notion or Confluence page automatically
- Add `--output plan.md` to save the plan to a file for sharing
- Chain with the Log Analyzer agent: analyze logs first, then feed findings as context to the incident responder
- Add a follow-up mode that accepts updates and revises the plan as the incident evolves

## Related Examples

- [Log Analyzer](../log-analyzer) -- Analyzes log files to find the anomalies that trigger incidents
- [Code Review Agent](../../starter/code-review-agent) -- Reviews code changes that might have caused the incident
- [Deep Research Agent](../deep-research-agent) -- Similar expert-reasoning pattern applied to research
