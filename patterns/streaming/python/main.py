"""
Streaming Agent

An agent that streams both text and tool-call responses in real-time.
Text appears character by character, tool arguments stream as they're
generated, and tool results feed back into the conversation seamlessly.

Usage:
    python main.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

import anthropic
from dotenv import load_dotenv

load_dotenv()

MODEL = os.getenv("MODEL", "claude-sonnet-4-20250514")
MAX_TOKENS = 4096

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    timestamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{timestamp}] {emoji} {message}")


# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["ANTHROPIC_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}")
        print("Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

TOOLS: list[anthropic.types.ToolParam] = [
    {
        "name": "get_weather",
        "description": "Get the current weather for a city. Returns temperature, conditions, and humidity.",
        "input_schema": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "The city name (e.g., 'San Francisco', 'London').",
                },
            },
            "required": ["city"],
        },
    },
    {
        "name": "search_web",
        "description": "Search the web for information. Returns a list of relevant results.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query.",
                },
            },
            "required": ["query"],
        },
    },
]

# ---------------------------------------------------------------------------
# Simulated tool implementations
# ---------------------------------------------------------------------------

WEATHER_DATA: dict[str, dict[str, Any]] = {
    "san francisco": {"temp_f": 62, "condition": "Foggy", "humidity": 78},
    "london": {"temp_f": 55, "condition": "Overcast", "humidity": 82},
    "tokyo": {"temp_f": 73, "condition": "Clear", "humidity": 60},
    "new york": {"temp_f": 68, "condition": "Partly cloudy", "humidity": 65},
}


def execute_get_weather(city: str) -> str:
    """Simulate fetching weather data for a city."""
    log("🌤️", f"Fetching weather for: {city}")
    key = city.lower().strip()
    if key in WEATHER_DATA:
        data = WEATHER_DATA[key]
        return json.dumps({
            "city": city,
            "temperature_f": data["temp_f"],
            "temperature_c": round((data["temp_f"] - 32) * 5 / 9, 1),
            "condition": data["condition"],
            "humidity_percent": data["humidity"],
        })
    return json.dumps({
        "city": city,
        "temperature_f": 70,
        "temperature_c": 21.1,
        "condition": "Clear",
        "humidity_percent": 50,
        "note": "Simulated data -- city not in local database.",
    })


def execute_search_web(query: str) -> str:
    """Simulate a web search."""
    log("🌐", f"Searching: {query}")
    results = [
        {
            "title": f"Result 1 for '{query}'",
            "url": f"https://example.com/1?q={query.replace(' ', '+')}",
            "snippet": f"Comprehensive overview of {query} with recent data and analysis.",
        },
        {
            "title": f"Result 2 for '{query}'",
            "url": f"https://example.com/2?q={query.replace(' ', '+')}",
            "snippet": f"In-depth report on {query} published this year.",
        },
    ]
    return json.dumps(results, indent=2)


def dispatch_tool(name: str, input_data: dict[str, Any]) -> str:
    """Route a tool call to the correct handler."""
    if name == "get_weather":
        return execute_get_weather(input_data.get("city", ""))
    if name == "search_web":
        return execute_search_web(input_data.get("query", ""))
    return json.dumps({"error": f"Unknown tool: {name}"})


# ---------------------------------------------------------------------------
# Streaming agent loop
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a helpful assistant with access to weather data and web search.
Answer questions conversationally. When you use tools, explain what you found.
Keep responses concise and informative."""


async def run_streaming_turn(
    client: anthropic.AsyncAnthropic,
    messages: list[dict[str, Any]],
) -> None:
    """Run one turn of the agent, streaming text and handling tool use.

    This function processes the streaming response from Claude, printing
    text deltas in real time. If the model calls tools, it executes them
    and continues the conversation with the results.
    """
    while True:
        # Collect content blocks and track state during streaming
        content_blocks: list[dict[str, Any]] = []
        current_tool_name: str = ""
        current_tool_input_json: str = ""
        current_block_index: int = -1
        stop_reason: str | None = None

        print("\nAssistant: ", end="", flush=True)

        try:
            async with client.messages.stream(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                messages=messages,
                tools=TOOLS,
            ) as stream:
                async for event in stream:
                    event_type = event.type

                    # -- Content block started --
                    if event_type == "content_block_start":
                        current_block_index = event.index
                        block = event.content_block

                        if block.type == "text":
                            content_blocks.append({"type": "text", "text": ""})
                        elif block.type == "tool_use":
                            current_tool_name = block.name
                            current_tool_input_json = ""
                            content_blocks.append({
                                "type": "tool_use",
                                "id": block.id,
                                "name": block.name,
                                "input": {},
                            })
                            # Visual indicator that a tool is being called
                            print(f"\n  [calling {block.name}(", end="", flush=True)

                    # -- Content block delta (the streaming part) --
                    elif event_type == "content_block_delta":
                        delta = event.delta

                        if delta.type == "text_delta":
                            # Stream text character by character to stdout
                            print(delta.text, end="", flush=True)
                            content_blocks[current_block_index]["text"] += delta.text

                        elif delta.type == "input_json_delta":
                            # Stream tool input JSON as it arrives
                            print(delta.partial_json, end="", flush=True)
                            current_tool_input_json += delta.partial_json

                    # -- Content block finished --
                    elif event_type == "content_block_stop":
                        if (
                            current_block_index >= 0
                            and content_blocks[current_block_index]["type"] == "tool_use"
                        ):
                            # Parse the accumulated JSON for the tool input
                            try:
                                parsed_input = json.loads(current_tool_input_json)
                            except json.JSONDecodeError:
                                parsed_input = {}
                            content_blocks[current_block_index]["input"] = parsed_input
                            print(")]", flush=True)

                    # -- Message complete --
                    elif event_type == "message_delta":
                        stop_reason = event.delta.stop_reason

        except anthropic.APIError as exc:
            log("❌", f"API error: {exc}")
            print(f"\nSorry, I encountered an error: {exc}")
            return

        print()  # Newline after streaming output

        # Add the assistant's full response to messages
        messages.append({"role": "assistant", "content": content_blocks})

        # If the model stopped because it wants to use tools, execute them
        if stop_reason == "tool_use":
            tool_results: list[dict[str, Any]] = []
            for block in content_blocks:
                if block["type"] == "tool_use":
                    tool_name = block["name"]
                    tool_input = block["input"]
                    result = dispatch_tool(tool_name, tool_input)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block["id"],
                        "content": result,
                    })

            messages.append({"role": "user", "content": tool_results})
            # Continue the loop so the model can respond with tool results
            print("Assistant: ", end="", flush=True)
            continue

        # No tool calls -- turn is complete
        return


async def chat_loop() -> None:
    """Run an interactive chat loop with streaming output."""
    client = anthropic.AsyncAnthropic()
    messages: list[dict[str, Any]] = []

    print()
    print("Streaming Agent")
    print("=" * 40)
    print("Responses stream in real-time. Tool calls are visible as they happen.")
    print("Try: 'What's the weather in San Francisco and Tokyo?'")
    print("Type 'quit' or 'exit' to stop.")
    print()

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not user_input:
            continue

        if user_input.lower() in ("quit", "exit", "q"):
            break

        messages.append({"role": "user", "content": user_input})

        await run_streaming_turn(client, messages)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Start the streaming agent."""
    validate_env()
    log("🚀", "Starting streaming agent...")
    log("📡", f"Model: {MODEL} (streaming enabled)")
    await chat_loop()
    log("👋", "Goodbye!")


if __name__ == "__main__":
    asyncio.run(main())
