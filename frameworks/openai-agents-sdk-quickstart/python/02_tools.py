"""
02 - Agent with Tools
=====================

An agent that can call external tools (functions) to gather information
before responding. This demonstrates the function-calling pattern that
the Agents SDK wraps with its @tool decorator.

Pattern: User message -> Model decides to call tool(s) -> Execute tools
         -> Feed results back -> Model produces final response
"""

import asyncio
import json
import os
import sys
from typing import Any

from openai import AsyncOpenAI
from dotenv import load_dotenv


def validate_env() -> None:
    """Ensure required environment variables are set."""
    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        print("Error: OPENAI_API_KEY is not set.")
        print("Copy .env.example to .env and add your key.")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Tool definitions -- in the Agents SDK these would be @tool decorated funcs
# ---------------------------------------------------------------------------

def get_weather(city: str) -> dict[str, Any]:
    """Simulate fetching weather data for a city."""
    # In production, this would call a real weather API
    weather_data: dict[str, dict[str, Any]] = {
        "new york": {"temp_f": 72, "condition": "Partly cloudy", "humidity": 55},
        "london": {"temp_f": 61, "condition": "Overcast", "humidity": 78},
        "tokyo": {"temp_f": 85, "condition": "Sunny", "humidity": 60},
    }
    data = weather_data.get(city.lower(), {"temp_f": 68, "condition": "Clear", "humidity": 50})
    return {"city": city, **data}


def calculate(expression: str) -> dict[str, Any]:
    """Evaluate a mathematical expression safely."""
    # Only allow safe math operations
    allowed = set("0123456789+-*/(). ")
    if not all(c in allowed for c in expression):
        return {"error": "Invalid characters in expression"}
    try:
        result = eval(expression)  # noqa: S307 -- safe: input is filtered
        return {"expression": expression, "result": result}
    except Exception as e:
        return {"error": str(e)}


# Map of function names to implementations
TOOL_FUNCTIONS = {
    "get_weather": get_weather,
    "calculate": calculate,
}

# OpenAI function-calling schema -- the Agents SDK generates this automatically
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather for a city",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "City name"},
                },
                "required": ["city"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "Evaluate a mathematical expression",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {"type": "string", "description": "Math expression to evaluate"},
                },
                "required": ["expression"],
            },
        },
    },
]

AGENT_INSTRUCTIONS = (
    "You are a helpful assistant with access to weather and calculator tools. "
    "Use them when the user asks about weather or needs calculations."
)


async def run_agent_with_tools(user_message: str) -> str:
    """
    Run an agent that can use tools via function calling.

    The loop mirrors the Agents SDK's tool execution cycle:
    1. Send messages to the model with tool definitions
    2. If the model returns tool_calls, execute them
    3. Feed results back and repeat until the model produces a text response
    """
    client = AsyncOpenAI()
    model = os.getenv("MODEL", "gpt-4o-mini")

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": AGENT_INSTRUCTIONS},
        {"role": "user", "content": user_message},
    ]

    # Tool execution loop -- keep going until the model gives a final answer
    while True:
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            tools=TOOLS,
            temperature=0.3,
        )

        choice = response.choices[0]

        # If no tool calls, the model is done -- return the text response
        if not choice.message.tool_calls:
            return choice.message.content or ""

        # Process each tool call
        messages.append(choice.message.model_dump())
        for tool_call in choice.message.tool_calls:
            fn_name = tool_call.function.name
            fn_args = json.loads(tool_call.function.arguments)

            print(f"  [Tool Call] {fn_name}({fn_args})")

            # Execute the tool
            fn = TOOL_FUNCTIONS.get(fn_name)
            if fn:
                result = fn(**fn_args)
            else:
                result = {"error": f"Unknown tool: {fn_name}"}

            print(f"  [Tool Result] {result}")

            # Feed the result back to the model
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": json.dumps(result),
            })


async def main() -> None:
    """Run the tools agent with sample queries."""
    validate_env()

    print("=== Agent with Tools ===")
    print()

    queries = [
        "What's the weather in Tokyo?",
        "What is (42 * 17) + (256 / 8)?",
        "Compare the weather in New York and London.",
    ]

    for query in queries:
        print(f"User: {query}")
        result = await run_agent_with_tools(query)
        print(f"Agent: {result}")
        print()


if __name__ == "__main__":
    asyncio.run(main())
