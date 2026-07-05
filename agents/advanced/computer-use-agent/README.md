# Computer Use Agent

A browser automation agent that uses Claude's vision to see screenshots and decide what actions to take -- clicking, typing, scrolling, and navigating -- to complete tasks on the web.

## What You'll Build

A fully autonomous browser agent that:

- Launches a real browser using Playwright
- Takes screenshots of the current page
- Sends screenshots to Claude, which analyzes the visual content
- Claude returns a structured action (click, type, scroll, navigate, or done)
- Executes the action via Playwright and repeats
- Stops when the task is complete or the step limit is reached

The agent works like a human at a computer: it looks at the screen, decides what to do, acts, and checks the result.

## What You'll Learn

- How to send screenshots to Claude as base64 images via the Messages API
- Building a perception-action loop with an LLM in the driver's seat
- Crafting system prompts that teach Claude about coordinate systems and available actions
- Structured output parsing from Claude's responses
- Browser automation with Playwright (async API)
- Error handling, retries, and graceful cleanup in agent systems

## Architecture

```
+------------------+     screenshot (base64 PNG)     +------------------+
|                  | -------------------------------->|                  |
|    Playwright    |                                  |   Claude API     |
|    (Browser)     |     action JSON                  |   (Vision)       |
|                  | <--------------------------------|                  |
+--------+---------+                                  +------------------+
         |
         |  1. Launch browser, go to start URL
         |  2. Take screenshot
         |  3. Send screenshot + task to Claude
         |  4. Claude returns action JSON
         |  5. Execute action (click/type/scroll/navigate)
         |  6. Repeat from step 2
         |  7. Stop when Claude returns "done" or max steps reached
         |
         v
    Task complete
```

## Prerequisites

- **Python 3.10+** or **Node.js 18+**
- An [Anthropic API key](https://console.anthropic.com/settings/keys)
- Playwright browsers installed (see Quick Start)
- Estimated cost: **~$0.02--0.05 per task** (depending on number of steps)

## Quick Start

### Python

```bash
cd python

# Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Install Playwright's Chromium browser
playwright install chromium

# Set your API key
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Run the agent
python main.py "Search Google for 'Claude AI' and tell me the first result"
```

### TypeScript

```bash
cd typescript

# Install dependencies
npm install

# Install Playwright's Chromium browser
npx playwright install chromium

# Set your API key
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Run the agent
npx tsx index.ts "Search Google for 'Claude AI' and tell me the first result"
```

## How It Works

The agent operates on a simple but powerful loop: **see, think, act**. At each step, Playwright captures a screenshot of the browser viewport and encodes it as a base64 PNG. This image is sent to Claude alongside the task description and step counter.

Claude's system prompt describes the coordinate system (1280x720 pixels, origin at top-left), the available actions, and the rules for responding. Claude analyzes the screenshot visually -- reading text, identifying buttons, locating input fields -- and returns a single JSON object specifying the next action.

The agent parses Claude's JSON response and translates it into Playwright calls: `mouse.click()` for click actions, `keyboard.type()` for text input, `mouse.wheel()` for scrolling, and `page.goto()` for navigation. After each action, a short delay lets the page settle before the next screenshot.

The conversation history accumulates across steps, giving Claude context about what it has already tried. This helps it avoid repeating failed actions and build on previous progress. The loop terminates when Claude returns a "done" action with a result summary, or when the configurable step limit is reached.

Safety features include exponential-backoff retries on API errors, a hard step limit to prevent runaway loops, graceful browser cleanup in all exit paths, and JSON parsing that handles markdown fences and embedded JSON.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Your Anthropic API key |
| `MODEL` | `claude-sonnet-4-20250514` | Claude model to use |
| `MAX_STEPS` | `20` | Maximum browser actions before stopping |
| `HEADLESS` | `true` | Run browser without a visible window |

Set these in a `.env` file or as environment variables.

## Key Files

| File | Description |
|------|-------------|
| `python/main.py` | Python implementation -- async Playwright + Anthropic SDK |
| `python/requirements.txt` | Python dependencies |
| `typescript/index.ts` | TypeScript implementation -- Playwright + @anthropic-ai/sdk |
| `typescript/package.json` | Node.js dependencies and scripts |

## CLI Usage

### Basic usage

```bash
# Python
python main.py "Go to wikipedia.org and find the article about Mars"

# TypeScript
npx tsx index.ts "Go to wikipedia.org and find the article about Mars"
```

### Start at a specific URL

```bash
# Python
python main.py --url https://en.wikipedia.org "Find the population of France"

# TypeScript
npx tsx index.ts --url https://en.wikipedia.org "Find the population of France"
```

### Show the browser window (non-headless)

```bash
HEADLESS=false python main.py "Search for today's weather in San Francisco"
```

### Limit the number of steps

```bash
MAX_STEPS=10 python main.py "Find the top story on Hacker News"
```

## Common Issues

**Playwright browsers not installed**
Run `playwright install chromium` (Python) or `npx playwright install chromium` (TypeScript) before first use. Playwright needs to download a browser binary.

**Headless mode fails on some pages**
Some sites detect headless browsers. Try `HEADLESS=false` to use a visible browser window, which can bypass some detection.

**Coordinate accuracy**
Claude targets element centers based on visual analysis. Complex or dense UIs may cause mis-clicks. If the agent gets stuck, try being more specific in your task description or starting from a page closer to the target.

**API rate limits**
The agent includes exponential backoff for API errors. If you hit rate limits consistently, add a delay between steps or reduce `MAX_STEPS`.

**Large conversation history**
Each step adds a screenshot to the conversation. After many steps, the context window fills up. Keep `MAX_STEPS` reasonable (10--20) for most tasks.

## Extend This Example

- **Add keyboard shortcuts** -- support pressing Escape, Tab, arrow keys, or key combos
- **Multi-tab support** -- let Claude open and switch between browser tabs
- **Element highlighting** -- overlay bounding boxes on screenshots to help Claude identify elements
- **Action history display** -- show a visual timeline of actions taken
- **Session recording** -- save screenshots and actions for replay and debugging
- **Accessibility tree** -- supplement screenshots with the page's accessibility tree for more accurate interactions

## Related Examples

- **Tool Use Agent** -- structured tool calling without vision
- **Multi-Turn Chat** -- managing conversation history with Claude
- **Streaming Agent** -- real-time output from long-running agent tasks
