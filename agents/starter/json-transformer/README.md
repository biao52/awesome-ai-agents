# JSON Transformer Agent

> An agent that transforms JSON data based on natural language instructions -- describe what you want changed and the agent produces the transformed output.

## What You'll Build

A CLI tool that takes input JSON (from a file or piped via stdin) and a natural language transformation description, sends both to an LLM, and outputs the transformed JSON. Useful for renaming fields, flattening structures, filtering arrays, converting formats, and any other JSON manipulation you can describe in words.

## What You'll Learn

- How to use OpenAI's chat API for structured data transformation
- How to validate both input and output JSON for reliability
- How to handle multiple input sources (file and stdin pipe) in a CLI tool
- How to strip unwanted markdown fencing from LLM output
- How to craft a system prompt that enforces strict output format (JSON only, no prose)

## Architecture

```
User provides JSON + transformation instructions
    ┌─────────────────────────────────────────────┐
    │  --input data.json "Flatten nested objects" │
    │  cat data.json | python main.py "Add IDs"   │
    └─────────────────┬───────────────────────────┘
                      ↓
              Validate input is valid JSON
                      ↓
              Send to OpenAI with system prompt
              enforcing JSON-only output
                      ↓
              LLM generates transformed JSON
                      ↓
              Validate output is valid JSON
              Re-format with consistent indentation
                      ↓
              Output to stdout or save to file
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **OpenAI API key** -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- **Estimated cost:** ~$0.001-0.005 per transformation (gpt-4o-mini is very cheap)

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

4. Open `.env` and add your OpenAI API key (get one from the link above).

5. Run the agent:
   ```bash
   # Transform from a file
   python main.py --input data.json "Flatten nested objects and rename 'firstName' to 'first_name'"

   # Pipe JSON via stdin
   echo '[{"name": "Alice", "age": 30}]' | python main.py "Add an 'id' field to each object"

   # Save output to file
   python main.py --input data.json --output result.json "Convert to snake_case keys"
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
   # Transform from a file
   npx tsx index.ts --input data.json "Flatten nested objects"

   # Pipe JSON via stdin
   echo '[{"name": "Alice"}]' | npx tsx index.ts "Add an email field"

   # Save output to file
   npx tsx index.ts --input data.json --output result.json "Convert to snake_case keys"
   ```

## How It Works

The JSON Transformer uses a **single-prompt pattern** -- it sends the input JSON and transformation instructions to OpenAI in one request and gets back the transformed JSON. There's no tool calling or multi-step reasoning needed because the LLM can perform the transformation directly in its response.

The system prompt is the key to reliable output. It instructs the model to output ONLY valid JSON with no markdown fencing, no explanations, and no extra text. It also specifies rules about preserving data types, handling edge cases (empty arrays, null values), and not fabricating data. Despite these instructions, some models occasionally wrap output in markdown code fences, so the code strips those if present.

Input handling supports two modes: `--input FILE` reads from disk, and stdin pipe handles `cat data.json | python main.py "instructions"`. Both paths validate that the input is valid JSON before sending it to the API. After receiving the response, the output is also validated and re-formatted with consistent 2-space indentation. If the output isn't valid JSON (which is rare with a good system prompt), a warning is shown but the raw output is still displayed.

The temperature is set to 0.1 for deterministic transformations. This means running the same transformation twice will produce the same output. Retry logic with exponential backoff handles transient API errors (rate limits, server overload).

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `MODEL` | No | `gpt-4o-mini` | Override the OpenAI model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: CLI parsing, JSON validation, transformation, and output |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Transform from a file
python main.py --input data.json "Flatten nested objects"

# Pipe via stdin
cat data.json | python main.py "Sort by date descending"

# Save to file
python main.py --input data.json --output result.json "Remove null values"

# Show help
python main.py --help
```

**Example output:**

```
🚀 Starting JSON transformer agent...
🤖 Model: gpt-4o-mini

📄 Reading: users.json
📊 Input: JSON array with 3 items
🔄 Transformation: Rename 'firstName' to 'first_name' and 'lastName' to 'last_name'

⚡ Transforming...

[
  {
    "first_name": "Alice",
    "last_name": "Johnson",
    "email": "alice@example.com"
  },
  {
    "first_name": "Bob",
    "last_name": "Smith",
    "email": "bob@example.com"
  },
  {
    "first_name": "Carol",
    "last_name": "Williams",
    "email": "carol@example.com"
  }
]

✅ Done!
```

## Common Issues & Troubleshooting

**"Missing environment variables: OPENAI_API_KEY"**
- Make sure you copied `.env.example` to `.env`: `cp .env.example .env`
- Open `.env` and replace `your-openai-api-key-here` with your actual key
- Your key should start with `sk-`

**"Invalid JSON in input"**
- Make sure your input file contains valid JSON
- Use `python -m json.tool data.json` to validate your JSON file
- Common issue: trailing commas are not valid JSON

**"No input JSON provided"**
- Use `--input FILE` to specify a file, or pipe via stdin: `cat file.json | python main.py "..."`
- The agent cannot read from interactive input -- it needs file or pipe

**Output is not valid JSON**
- This is rare but can happen with very complex transformations
- Try being more specific in your instructions
- Try a more capable model: `MODEL=gpt-4o python main.py ...`

**"Rate limit" or "overloaded" errors**
- The agent automatically retries up to 3 times with exponential backoff
- If it still fails, wait a minute and try again

**Large JSON files time out**
- The agent caps input at 200K characters
- For very large files, consider splitting them and transforming in batches

## Extend This Example

- **Add `--schema` flag** -- provide a target JSON schema and have the agent transform input to match it exactly
- **Add batch mode** -- accept a directory of JSON files and transform them all with the same instructions
- **Add `--diff` mode** -- show a before/after diff of the transformation so you can review changes
- **Chain transformations** -- support multiple instructions separated by `|` and apply them sequentially
- **Add validation against a schema** -- use JSON Schema or zod to validate the output matches expected structure

## Related Examples

- [Code Review Agent](../code-review-agent) -- Another single-prompt pattern, but for code analysis instead of data transformation
- [Web Scraping Agent](../web-scraping-agent) -- Extracts structured JSON from HTML pages using a similar approach
- [SQL Agent](../sql-agent) -- Transforms natural language to SQL queries, a related "language to structured output" pattern
