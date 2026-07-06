# Cron Translator

> An agent that converts between natural language and cron expressions -- never Google "cron syntax" again.

## What You'll Build

A CLI tool that translates in both directions: describe a schedule in plain English and get a cron expression, or paste a cryptic cron expression and get a human-readable explanation. Both directions include a field-by-field breakdown and the next 5 calculated run times so you can verify the schedule is correct.

## What You'll Learn

- How to use the OpenAI SDK with JSON response format for structured output
- How to build a bidirectional translation agent with auto-detection
- How to implement cron expression parsing and next-run-time calculation in pure Python/TypeScript
- How to design CLI agents that handle both direct arguments and interactive prompts
- How to combine AI translation with deterministic validation (calculated run times)

## Architecture

```
User provides input (auto-detected direction)
    ┌──────────────────────────────────────────────┐
    │  "Every weekday at 9am"  →  natural language │
    │  "0 9 * * 1-5"          →  cron expression   │
    └─────────────────┬────────────────────────────┘
                      ↓
              Auto-detect input format
              (5 space-separated cron-like fields?)
                      ↓
              ┌───────┴───────┐
              ↓               ↓
        NL → Cron        Cron → NL
        (generate)       (explain)
              ↓               ↓
              └───────┬───────┘
                      ↓
              Parse cron expression locally
              Calculate next 5 run times
                      ↓
              Display: expression, field breakdown,
              explanation, next runs, usage examples
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **OpenAI API key** -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- **Estimated cost:** ~$0.001 per translation (gpt-4o-mini is very cheap)

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
   # Natural language to cron
   python main.py "Every weekday at 9am"

   # Cron to natural language
   python main.py "0 9 * * 1-5"
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
   npx tsx index.ts "Every weekday at 9am"
   ```

## How It Works

The agent first auto-detects the input direction by checking whether the input looks like a cron expression. The detection is simple: if the input has exactly 5 space-separated tokens and each token contains only digits, asterisks, commas, slashes, or hyphens, it's treated as a cron expression. Everything else is treated as natural language. This heuristic works well in practice because natural language descriptions rarely look like cron fields.

For natural-language-to-cron translation, the system prompt instructs GPT-4o-mini to generate a 5-field cron expression with a field-by-field explanation. The prompt includes specific rules about cron conventions (day-of-week numbering, the difference between `*` and `*/N`, etc.) to ensure correct output. For cron-to-natural-language, a separate system prompt focuses on producing a clear, jargon-free description.

The next-run-time calculation is done entirely in Python/TypeScript with no external cron libraries. It parses each field into a set of matching values, then iterates forward from the current time, checking each minute against the cron constraints. This gives you immediate, deterministic feedback on whether the cron expression does what you expect -- a crucial validation step when the AI generates the expression.

Both system prompts use OpenAI's JSON response format to guarantee valid structured output. The response includes the cron expression (or description), a detailed explanation, and a per-field breakdown. This structured format makes the output consistent and easy to display without parsing text.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `MODEL` | No | `gpt-4o-mini` | Override the model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: auto-detection, translation, cron parsing, and display |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Natural language to cron
python main.py "Every weekday at 9am"
python main.py "Every 15 minutes"
python main.py "First day of every month at midnight"
python main.py "Every Sunday at 3:30pm"

# Cron to natural language
python main.py "0 9 * * 1-5"
python main.py "*/15 * * * *"
python main.py "0 0 1 * *"
python main.py "30 15 * * 0"

# Interactive mode
python main.py

# Show help
python main.py --help
```

**Example output (natural language to cron):**

```
🚀 Starting cron translator agent...
🤖 Model: gpt-4o-mini

🔄 Detected natural language: Every weekday at 9am
🔍 Generating cron expression...

============================================================
🎯 Generated Cron Expression
============================================================

  Cron:  0 9 * * 1-5

  Field breakdown:
           0  minute           At minute 0
           9  hour             At 9:00 AM
           *  day of month     Every day of the month
           *  month            Every month
         1-5  day of week      Monday through Friday

------------------------------------------------------------
⏰ Next 5 Run Times
------------------------------------------------------------

  1. 2026-07-06 09:00 (Monday)
  2. 2026-07-07 09:00 (Tuesday)
  3. 2026-07-08 09:00 (Wednesday)
  4. 2026-07-09 09:00 (Thursday)
  5. 2026-07-10 09:00 (Friday)

------------------------------------------------------------
💻 Usage
------------------------------------------------------------

  crontab:         0 9 * * 1-5 /path/to/command
  GitHub Actions:  cron: '0 9 * * 1-5'

============================================================
✅ Done!
```

## Common Issues & Troubleshooting

**"Missing environment variables: OPENAI_API_KEY"**
- Make sure you copied `.env.example` to `.env`: `cp .env.example .env`
- Open `.env` and replace `your-openai-api-key-here` with your actual key
- Your key should start with `sk-`

**Wrong direction detected**
- If your natural language input gets detected as cron, wrap it in quotes
- The detector looks for exactly 5 space-separated tokens with cron-like characters
- Example: "5 things at 3 on 2 days" might trigger false positive -- rephrase it

**Next run times seem wrong**
- The calculator uses your system's local time, not UTC
- Cron expressions are typically interpreted in UTC on servers
- The AI assumes UTC unless you specify a timezone in your description

**Complex cron features not supported**
- The next-run calculator handles standard 5-field cron (minute, hour, DOM, month, DOW)
- Non-standard extensions like `L` (last), `W` (weekday), `#` (nth weekday) are detected but the calculator may not compute them accurately

## Extend This Example

- **Add timezone support** -- accept a `--timezone` flag and convert run times accordingly
- **Add `--count` flag** -- show more or fewer next run times (default is 5)
- **Cron validation** -- check for common mistakes like `60` in the minute field or overlapping constraints
- **Integration mode** -- output just the cron expression (no formatting) for use in scripts: `python main.py --raw "Every weekday at 9am"`
- **Reverse validation** -- after generating a cron expression, translate it back to English and compare

## Related Examples

- [Regex Generator](../regex-generator) -- Similar pattern of natural language to structured format conversion
- [Git Commit Agent](../git-commit-agent) -- Another single-prompt agent that generates structured text output
