# Fine-Tune Data Generator

> An agent that generates synthetic training data for fine-tuning language models, producing diverse input/output pairs in OpenAI-compatible JSONL format.

## What You'll Learn

- How to use Claude to generate structured, diverse training data in batches
- How to enforce variety through difficulty levels and length preferences
- How to validate and deduplicate generated examples programmatically
- How to produce JSONL output compatible with OpenAI's fine-tuning API

## Architecture

```
User provides task description + count
    |
    v
Agent creates batch generation plan
    |
    v
For each batch (10 examples at a time):
    -> Select difficulty level (simple/moderate/complex/edge-case)
    -> Select length preference (short/medium/long)
    -> Include existing examples to avoid duplicates
    -> Claude generates batch of training examples
    |
    v
Validate structure (messages array, roles, content)
    |
    v
Deduplicate across all batches
    |
    v
Output: JSONL file with messages arrays
        (system + user + assistant per example)
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
  - Free tier includes $5 of credits
- **Estimated cost:** ~$0.02-0.05 per 50 examples (depends on task complexity)

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
   python main.py "Classify customer support tickets into billing/technical/general" --count 50
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
   npx tsx index.ts "Classify customer support tickets into billing/technical/general" --count 50
   ```

## How It Works

The agent generates training data in batches of 10 examples, rotating through four difficulty levels (simple, moderate, complex, edge-case) and three length preferences (short, medium, long). This rotation prevents the model from producing a homogeneous dataset where all examples look the same. Each batch prompt includes a sample of already-generated examples so Claude can avoid duplicates.

Every generated example goes through structural validation: it must have a `messages` array with at least `user` and `assistant` roles, and every message must contain non-empty string content. The optional `system` message provides task context. After validation, a deduplication pass removes examples with identical user messages (case-insensitive comparison).

The output format is OpenAI-compatible JSONL -- each line is a JSON object with a `messages` array. You can feed this directly into `openai api fine_tuning.jobs.create`. The agent also prints dataset statistics (average lengths, min/max) so you can spot issues before starting an expensive fine-tuning job.

Temperature is set to 0.9 for generation to maximize diversity. If the API returns invalid JSON (which happens occasionally at high temperatures), the agent retries up to 3 times with exponential backoff.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `MODEL` | No | `claude-sonnet-4-20250514` | Override the Claude model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: CLI parsing, batch orchestration, JSONL output |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Generate 50 examples for a classification task
python main.py "Classify customer support tickets into billing/technical/general"

# Generate 100 examples with custom output path
python main.py "Summarize news articles in one sentence" --count 100 --output news_data.jsonl

# Short form flags
python main.py "Translate English to French" -n 200 -o french_data.jsonl

# Show help
python main.py --help
```

**Example output:**

```
🚀 Starting fine-tune data generator...
🤖 Model: claude-sonnet-4-20250514
📋 Task: Classify customer support tickets into billing/technical/general
🔢 Target examples: 50
📁 Output: training_data.jsonl

🔄 Batch 1: generating 10 examples (difficulty=simple, length=short (1-2 sentences))
✅ Got 10 examples. Total unique: 10/50
🔄 Batch 2: generating 10 examples (difficulty=moderate, length=medium (3-5 sentences))
✅ Got 10 examples. Total unique: 20/50
...
💾 Wrote 50 examples to /path/to/training_data.jsonl

📊 Dataset Statistics
════════════════════════════════════════
  Total examples:        50
  Total messages:        150
  Avg user msg length:   87 chars
  Avg assistant length:  42 chars
  Min assistant length:  12 chars
  Max assistant length:  95 chars

✅ Done! Generated 50 training examples.
💡 To fine-tune with OpenAI, run:
   openai api fine_tuning.jobs.create -t training_data.jsonl -m gpt-4o-mini-2024-07-18
```

## Common Issues & Troubleshooting

**"Missing environment variables: ANTHROPIC_API_KEY"**
- Make sure you copied `.env.example` to `.env`: `cp .env.example .env`
- Open `.env` and replace `your-anthropic-api-key-here` with your actual key
- Your key should start with `sk-ant-`

**Invalid JSON responses / empty batches**
- This happens occasionally at high temperature. The agent automatically retries up to 3 times.
- If it persists, try a different task description -- very vague descriptions produce worse results.

**Duplicate examples in the output**
- The agent deduplicates by user message content. If you still see near-duplicates, increase the count and filter manually.
- More specific task descriptions produce more diverse examples.

**Rate limit errors**
- The agent waits 1 second between batches and retries with exponential backoff.
- For large datasets (500+), consider running in smaller chunks.

## Extend This Example

- **Add a `--format` flag** to support CSV or Alpaca format in addition to JSONL
- **Add multi-turn conversations** -- generate examples with 2-3 back-and-forth exchanges instead of single-turn
- **Add a validation prompt** -- use a second LLM call to grade the quality of generated examples and filter low-quality ones
- **Add domain-specific constraints** -- let the user provide example inputs or a style guide to constrain generation
- **Parallel batch generation** -- use asyncio.gather to generate multiple batches concurrently

## Related Examples

- [Code Review Agent](../../starter/code-review-agent) -- Uses Claude with a single-prompt pattern for structured analysis
- [Deep Research Agent](../deep-research-agent) -- Shows multi-step orchestration with batched API calls
- [Prompt Optimizer](../prompt-optimizer) -- Another advanced agent that iterates on prompt quality
