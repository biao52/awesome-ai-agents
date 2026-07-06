# Retry & Fallback Agent

> An agent with exponential backoff retry logic and automatic model fallback when the primary provider is unavailable.

## What You'll Learn

- Implementing exponential backoff retry for transient API failures
- Distinguishing retryable errors (rate limits, server errors) from non-retryable ones (auth, bad request)
- Automatic failover from a primary model to a fallback model
- Tracking which model handled each request for observability

## Architecture

```
User Message
    |
    v
Try Primary Model (Claude)
    |
    +--> Success? --> Return response [model: claude]
    |
    +--> Retryable error?
         |
         +--> Retry with backoff (2s, 4s, 8s)
         |    |
         |    +--> Success? --> Return response [model: claude]
         |    |
         |    +--> All retries exhausted?
         |         |
         v         v
    Try Fallback Model (GPT-4o-mini)
         |
         +--> Success? --> Return response [model: gpt-4o-mini]
         |
         +--> Retry with backoff (2s, 4s, 8s)
              |
              +--> Success? --> Return response [model: gpt-4o-mini]
              |
              +--> All retries exhausted? --> Error to user
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- API key for Anthropic -- get one at [console.anthropic.com](https://console.anthropic.com)
- API key for OpenAI -- get one at [platform.openai.com](https://platform.openai.com)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env  # Then add both API keys
python main.py

# To see the fallback in action:
python main.py --simulate-failure
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add both API keys
npx tsx index.ts

# To see the fallback in action:
npx tsx index.ts --simulate-failure
```

## How It Works

The agent wraps every API call in a `retry_with_backoff` function that catches transient errors (rate limits, connection errors, 5xx server errors) and retries with exponential delays. The delay doubles each attempt: 2 seconds, then 4, then 8. Non-retryable errors like authentication failures or malformed requests are raised immediately -- retrying those would be pointless.

If the primary model (Claude) exhausts all retry attempts, the agent switches to the fallback model (GPT-4o-mini) and applies the same retry logic. The conversation history is converted between API formats transparently. The response includes a label showing which model actually handled the request, so you always know what happened.

The `--simulate-failure` flag forces the primary model to throw a simulated 500 error on every call. This lets you see the full fallback sequence without waiting for a real outage: primary fails 3 times with backoff delays, then the agent switches to the fallback model and succeeds.

Every request tracks statistics: how many attempts each model needed, total wall-clock time, and any errors encountered. Type `stats` during the chat to see the numbers for the last request. In production, you would send these metrics to your observability stack (Datadog, Prometheus, etc.).

## Configuration

| Variable          | Required | Description                                        |
| ----------------- | -------- | -------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Yes    | Your Anthropic API key (primary model)             |
| `OPENAI_API_KEY`  | Yes      | Your OpenAI API key (fallback model)               |
| `PRIMARY_MODEL`   | No       | Override primary model (default: claude-sonnet-4-20250514) |
| `FALLBACK_MODEL`  | No       | Override fallback model (default: gpt-4o-mini)     |

## Key Files

| File                    | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `main.py` / `index.ts`  | Entry point, retry logic, fallback orchestration  |

## When to Use Retry vs Fallback

**Retry alone** is enough when:
- You only have one provider
- Failures are transient (rate limits during traffic spikes)
- Latency from retries is acceptable (background jobs, batch processing)

**Fallback** is needed when:
- Uptime matters more than model consistency
- A provider might have extended outages (hours, not seconds)
- You need SLA guarantees that one provider cannot deliver alone
- Different requests have different latency budgets

**Neither** is needed when:
- You are doing fire-and-forget work (log analysis, async pipelines)
- The calling code already has its own retry logic
- Failures should surface immediately to the user (debugging, testing)

## Retryable vs Non-Retryable Errors

| Retryable (worth retrying)              | Non-Retryable (fail fast)              |
| --------------------------------------- | -------------------------------------- |
| 429 Rate Limit                          | 401 Authentication error               |
| 500 Internal Server Error               | 400 Bad Request (malformed input)      |
| 502/503 Service Unavailable             | 404 Model not found                    |
| Connection timeout / DNS failure        | 413 Request too large (context limit)  |
| Socket reset / network interruption     | 422 Invalid parameters                 |

## Extend This Example

- Add circuit breaker logic: after N consecutive failures, skip the primary model entirely for a cooldown period
- Implement request hedging: send to both models simultaneously, use whichever responds first
- Add cost tracking: compare costs between primary and fallback models
- Build a model router that picks the cheapest model that can handle each request's complexity
- Add health checks: periodically ping the primary model during fallback mode to detect recovery

## Related Examples

- [Human-in-the-Loop](../human-in-the-loop) -- approval gates for risky actions
- [Streaming](../streaming) -- real-time output that also needs error handling
