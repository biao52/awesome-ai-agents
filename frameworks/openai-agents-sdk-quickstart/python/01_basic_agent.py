"""
01 - Basic Agent Pattern
========================

The simplest agent: a system prompt combined with user input produces a response.
This demonstrates the core pattern that the OpenAI Agents SDK abstracts --
an agent is just a model with instructions and a conversation loop.

Pattern: System prompt -> User message -> Model response
"""

import asyncio
import os
import sys

from openai import AsyncOpenAI
from dotenv import load_dotenv


def validate_env() -> None:
    """Ensure required environment variables are set."""
    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        print("Error: OPENAI_API_KEY is not set.")
        print("Copy .env.example to .env and add your key.")
        sys.exit(1)


# Agent configuration -- in the Agents SDK, this would be an Agent() object
AGENT_NAME = "Assistant"
AGENT_INSTRUCTIONS = (
    "You are a helpful assistant. You answer questions clearly and concisely. "
    "If you do not know the answer, say so honestly."
)


async def run_agent(user_message: str) -> str:
    """
    Run the basic agent with a single user message.

    This mirrors what Agent.run() does under the hood:
    1. Combine the system prompt with user input
    2. Call the model
    3. Return the response
    """
    client = AsyncOpenAI()
    model = os.getenv("MODEL", "gpt-4o-mini")

    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": AGENT_INSTRUCTIONS},
            {"role": "user", "content": user_message},
        ],
        temperature=0.7,
    )

    return response.choices[0].message.content or ""


async def main() -> None:
    """Run the basic agent with a sample query."""
    validate_env()

    print(f"=== {AGENT_NAME} ===")
    print()

    query = "What are three benefits of using AI agents in software development?"
    print(f"User: {query}")
    print()

    result = await run_agent(query)
    print(f"Agent: {result}")


if __name__ == "__main__":
    asyncio.run(main())
