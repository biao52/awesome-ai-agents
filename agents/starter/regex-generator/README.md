# Regex Generator

> An agent that takes a natural language description and generates a tested, validated regular expression with a clear explanation -- no more StackOverflow regex hunting.

## What You'll Build

A CLI tool that converts plain English descriptions into working regular expressions. It generates the pattern, explains each part, provides example matches, and optionally tests against your own strings. Both the Python and TypeScript versions actually execute the regex to verify it works before showing it to you.

## What You'll Learn

- How to use the OpenAI SDK with JSON response format for structured output
- How to validate AI-generated code by executing it (the regex) in-process
- How to build a CLI agent with both direct and interactive input modes
- How to craft system prompts that produce cross-language-compatible output
- How to implement retry logic for both API errors and malformed responses

## Architecture

```
User provides a description of what to match
    ┌──────────────────────────────────────────────┐
    │  python main.py "Match email addresses"      │
    │  --test "user@example.com,notanemail"        │
    └─────────────────┬────────────────────────────┘
                      ↓
              Send description to GPT-4o-mini
              with structured JSON output format
                      ↓
              Model returns:
              → regex pattern
              → flags (i, g, m)
              → explanation
              → example match/no-match strings
                      ↓
              Validate pattern compiles
              Test against user's strings (if provided)
                      ↓
              Display: pattern, usage snippets,
              explanation, examples, test results
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **OpenAI API key** -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- **Estimated cost:** ~$0.001 per regex generation (gpt-4o-mini is very cheap)

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
   python main.py "Match email addresses"
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
   npx tsx index.ts "Match email addresses"
   ```

## How It Works

The agent uses OpenAI's JSON response format (`response_format: { type: "json_object" }`) to guarantee structured output. The system prompt defines an exact JSON schema with fields for the pattern, flags, explanation, and example strings. This eliminates the need for fragile output parsing -- the model's response is valid JSON every time.

The generated regex is designed to work in both Python and JavaScript. The system prompt explicitly requires cross-language compatibility, which means avoiding Python-only features like `(?P<name>...)` named groups (JavaScript uses `(?<name>...)`) and JavaScript-only features like lookbehind assertions in older engines. The output includes ready-to-use code snippets for both languages.

After generation, the agent validates the pattern by actually compiling it. In Python, this uses `re.compile()`. In TypeScript, it uses `new RegExp()`. If the pattern is invalid, the agent warns you but still shows the output so you can debug it. When test strings are provided via `--test`, the agent runs the regex against each string and shows whether it matched, what text was captured, and any capture groups.

The retry logic handles two types of failures: transient API errors (rate limits, server errors) with exponential backoff, and malformed JSON responses with immediate retry. The JSON format constraint makes parse errors rare, but the retry ensures robustness in edge cases.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `MODEL` | No | `gpt-4o-mini` | Override the model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: CLI parsing, regex generation, testing, and display |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Generate a regex from a description
python main.py "Match email addresses"

# Generate and test against specific strings
python main.py "Match US phone numbers" --test "+1-555-123-4567,not-a-phone,555.123.4567"

# Interactive mode (prompts for description and test strings)
python main.py

# Show help
python main.py --help
```

**Example output:**

```
🚀 Starting regex generator agent...
🤖 Model: gpt-4o-mini

🔍 Generating regex for: Match email addresses
🧪 Testing against 3 string(s)...

════════════════════════════════════════════════════════════
🎯 Generated Regex
════════════════════════════════════════════════════════════

  Pattern:  [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}
  Flags:    i

  Python usage:
    re.search(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", text, re.IGNORECASE)

  JavaScript usage:
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i

────────────────────────────────────────────────────────────
📖 Explanation
────────────────────────────────────────────────────────────

  [a-zA-Z0-9._%+-]+  -- One or more word characters, dots, percent, plus, or hyphens (local part)
  @                   -- Literal @ symbol
  [a-zA-Z0-9.-]+     -- One or more word characters, dots, or hyphens (domain)
  \.                  -- Literal dot
  [a-zA-Z]{2,}       -- Two or more letters (TLD)

────────────────────────────────────────────────────────────
🧪 Test Results
────────────────────────────────────────────────────────────

  ✅ "user@example.com" -- matched: "user@example.com"
  ❌ "notanemail" -- no match
  ✅ "foo@bar.co" -- matched: "foo@bar.co"

════════════════════════════════════════════════════════════
✅ Done!
```

## Common Issues & Troubleshooting

**"Missing environment variables: OPENAI_API_KEY"**
- Make sure you copied `.env.example` to `.env`: `cp .env.example .env`
- Open `.env` and replace `your-openai-api-key-here` with your actual key
- Your key should start with `sk-`

**"The generated pattern is invalid"**
- This is rare with gpt-4o-mini but can happen for very complex descriptions
- Try rephrasing your description to be more specific
- Run the agent again -- the model may produce a different (valid) pattern

**Test strings with commas**
- The `--test` flag splits on commas, so strings containing commas will be split
- For strings with commas, use interactive mode instead

## Extend This Example

- **Add `--flavor` flag** -- generate regex optimized for a specific language (Python, JavaScript, Go, Rust)
- **Add regex visualization** -- output a railroad diagram or visual breakdown using ASCII art
- **Regex history** -- save generated patterns to a local file for reuse
- **Batch mode** -- accept multiple descriptions from a file and generate all at once
- **Performance testing** -- benchmark the regex against large inputs to detect catastrophic backtracking

## Related Examples

- [Cron Translator](../cron-translator) -- Similar pattern of natural language to structured format conversion
- [Code Review Agent](../code-review-agent) -- Uses single-prompt analysis for a different domain (code quality)
