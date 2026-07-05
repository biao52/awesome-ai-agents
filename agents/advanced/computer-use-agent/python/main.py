"""
Computer Use Agent -- Browser automation powered by Claude's vision.

Takes screenshots of a browser, sends them to Claude, and executes
the actions Claude decides on (click, type, scroll, navigate) until
the task is complete or the step limit is reached.
"""

import argparse
import asyncio
import base64
import json
import os
import re
import sys
import time
from typing import Any

import anthropic
from dotenv import load_dotenv
from playwright.async_api import Browser, BrowserContext, Page, async_playwright

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
DEFAULT_MAX_STEPS = 20
DEFAULT_HEADLESS = True
DEFAULT_START_URL = "https://www.google.com"
VIEWPORT_WIDTH = 1280
VIEWPORT_HEIGHT = 720
MAX_RETRIES = 3
INITIAL_RETRY_DELAY = 1.0

SYSTEM_PROMPT = """You are a browser automation agent. You can see a screenshot of a web browser and must decide what action to take next to accomplish the user's task.

## Screenshot interpretation
- The screenshot is {width}x{height} pixels.
- The coordinate system starts at (0, 0) in the top-left corner.
- X increases to the right, Y increases downward.
- When clicking, aim for the CENTER of the element you want to interact with.
- Text inputs, buttons, links, and other interactive elements are your targets.
- Look carefully at the page content, URL bar, and any visible text.

## Available actions
Respond with exactly ONE JSON object (no extra text, no markdown fences) describing your next action. The JSON must have an "action" field plus action-specific fields and a "description" field explaining your reasoning.

### click -- click at pixel coordinates
{{"action": "click", "x": <int>, "y": <int>, "description": "<why>"}}

### type -- type text (the currently focused element receives input)
{{"action": "type", "text": "<string>", "description": "<why>"}}

### scroll -- scroll the page
{{"action": "scroll", "direction": "up" | "down", "description": "<why>"}}

### navigate -- go to a URL directly
{{"action": "navigate", "url": "<full URL>", "description": "<why>"}}

### done -- the task is complete
{{"action": "done", "result": "<your answer or summary>", "description": "<why>"}}

## Rules
1. Return ONLY the JSON object. No commentary before or after.
2. Always include a "description" field so the user can follow along.
3. After clicking a text input, use "type" to enter text.
4. After typing a search query, you usually need to press Enter -- use {{"action": "type", "text": "\\n", "description": "Press Enter"}}.
5. If the page hasn't changed after an action, try a different approach.
6. If you are stuck or the task seems impossible, return "done" with an explanation.
7. Be precise with coordinates -- click the exact center of buttons and links.
8. Scroll if you need to see content below or above the current viewport.
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def log(emoji: str, message: str) -> None:
    """Print a timestamped status line."""
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {emoji}  {message}")


def validate_env() -> str:
    """Return the API key or exit with a helpful message."""
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        print("Error: ANTHROPIC_API_KEY is not set.")
        print("Export it or add it to a .env file. See .env.example.")
        sys.exit(1)
    return key


def get_config() -> dict[str, Any]:
    """Read optional configuration from env vars."""
    return {
        "model": os.environ.get("MODEL", DEFAULT_MODEL),
        "max_steps": int(os.environ.get("MAX_STEPS", str(DEFAULT_MAX_STEPS))),
        "headless": os.environ.get("HEADLESS", str(DEFAULT_HEADLESS)).lower()
        in ("true", "1", "yes"),
    }


def parse_action(text: str) -> dict[str, Any]:
    """Extract the action JSON from Claude's response.

    Handles plain JSON, markdown-fenced JSON, or JSON embedded in prose.
    """
    # Try parsing the whole response as JSON first.
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try extracting from markdown code fences.
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Try finding the first { ... } block.
    brace_match = re.search(r"\{[^{}]*\}", text, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not parse action JSON from response:\n{text[:300]}")


# ---------------------------------------------------------------------------
# Core agent loop
# ---------------------------------------------------------------------------


async def take_screenshot(page: Page) -> str:
    """Capture the current page as a base64-encoded PNG."""
    raw = await page.screenshot(type="png")
    return base64.standard_b64encode(raw).decode("ascii")


async def execute_action(page: Page, action: dict[str, Any]) -> None:
    """Translate an action dict into Playwright calls."""
    kind = action["action"]

    if kind == "click":
        x, y = int(action["x"]), int(action["y"])
        log("\U0001f5b1\ufe0f", f"Click ({x}, {y}) -- {action.get('description', '')}")
        await page.mouse.click(x, y)
        await page.wait_for_timeout(500)

    elif kind == "type":
        text: str = action["text"]
        display = repr(text) if text == "\n" else text
        log("\u2328\ufe0f", f"Type {display} -- {action.get('description', '')}")
        if text == "\n":
            await page.keyboard.press("Enter")
        else:
            await page.keyboard.type(text, delay=30)
        await page.wait_for_timeout(500)

    elif kind == "scroll":
        direction = action.get("direction", "down")
        delta = -400 if direction == "up" else 400
        log("\U0001f5b2\ufe0f", f"Scroll {direction} -- {action.get('description', '')}")
        await page.mouse.wheel(0, delta)
        await page.wait_for_timeout(500)

    elif kind == "navigate":
        url = action["url"]
        log("\U0001f310", f"Navigate to {url} -- {action.get('description', '')}")
        await page.goto(url, wait_until="domcontentloaded", timeout=15000)
        await page.wait_for_timeout(1000)

    elif kind == "done":
        log("\u2705", f"Done -- {action.get('description', '')}")

    else:
        log("\u26a0\ufe0f", f"Unknown action: {kind}")


async def call_claude(
    client: anthropic.Anthropic,
    model: str,
    system: str,
    messages: list[dict[str, Any]],
) -> str:
    """Send messages to Claude with exponential-backoff retries."""
    delay = INITIAL_RETRY_DELAY
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = client.messages.create(
                model=model,
                max_tokens=1024,
                temperature=0.2,
                system=system,
                messages=messages,
            )
            return resp.content[0].text
        except anthropic.APIError as exc:
            if attempt == MAX_RETRIES:
                raise
            log("\u26a0\ufe0f", f"API error (attempt {attempt}/{MAX_RETRIES}): {exc}")
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("Unreachable")


async def run_agent(task: str, start_url: str, config: dict[str, Any]) -> str:
    """Main agent loop: screenshot -> Claude -> action -> repeat."""
    api_key = validate_env()
    client = anthropic.Anthropic(api_key=api_key)
    model = config["model"]
    max_steps = config["max_steps"]
    headless = config["headless"]

    system = SYSTEM_PROMPT.format(width=VIEWPORT_WIDTH, height=VIEWPORT_HEIGHT)

    log("\U0001f680", f"Starting browser (headless={headless})")
    log("\U0001f4cb", f"Task: {task}")
    log("\U0001f310", f"Start URL: {start_url}")
    log("\u2699\ufe0f", f"Model: {model} | Max steps: {max_steps}")

    pw = await async_playwright().start()
    browser: Browser | None = None
    context: BrowserContext | None = None

    try:
        browser = await pw.chromium.launch(headless=headless)
        context = await browser.new_context(
            viewport={"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
        )
        page = await context.new_page()

        log("\U0001f310", f"Navigating to {start_url}")
        await page.goto(start_url, wait_until="domcontentloaded", timeout=15000)
        await page.wait_for_timeout(1000)

        # Conversation history sent to Claude each step.
        messages: list[dict[str, Any]] = []

        for step in range(1, max_steps + 1):
            log("\U0001f4f8", f"Step {step}/{max_steps} -- capturing screenshot")
            screenshot_b64 = await take_screenshot(page)

            # Build the user message with the screenshot and task reminder.
            user_content: list[dict[str, Any]] = [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": screenshot_b64,
                    },
                },
                {
                    "type": "text",
                    "text": (
                        f"Task: {task}\n\n"
                        f"This is step {step} of {max_steps}. "
                        "What action should I take next?"
                    ),
                },
            ]

            messages.append({"role": "user", "content": user_content})

            # Ask Claude.
            log("\U0001f916", "Asking Claude for next action...")
            raw_response = await asyncio.to_thread(
                call_claude, client, model, system, messages
            )

            # Parse the action.
            try:
                action = parse_action(raw_response)
            except ValueError as exc:
                log("\u26a0\ufe0f", str(exc))
                messages.append(
                    {
                        "role": "assistant",
                        "content": raw_response,
                    }
                )
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "I could not parse your response as a valid action JSON. "
                            "Please respond with ONLY a JSON object."
                        ),
                    }
                )
                continue

            # Record assistant message.
            messages.append({"role": "assistant", "content": raw_response})

            # Check for completion.
            if action["action"] == "done":
                result = action.get("result", "Task completed.")
                log("\U0001f389", f"Agent finished: {result}")
                return result

            # Execute the action.
            await execute_action(page, action)

        log("\u23f0", "Reached maximum steps without completing the task.")
        return "Reached maximum steps without completing the task."

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        await pw.stop()
        log("\U0001f9f9", "Browser cleaned up.")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Computer Use Agent -- automate a browser with Claude's vision.",
    )
    parser.add_argument(
        "task",
        help="Natural-language description of what the agent should do.",
    )
    parser.add_argument(
        "--url",
        default=DEFAULT_START_URL,
        help=f"Starting URL (default: {DEFAULT_START_URL}).",
    )
    args = parser.parse_args()

    config = get_config()
    result = asyncio.run(run_agent(args.task, args.url, config))
    print(f"\n{'='*60}")
    print("RESULT")
    print(f"{'='*60}")
    print(result)


if __name__ == "__main__":
    main()
