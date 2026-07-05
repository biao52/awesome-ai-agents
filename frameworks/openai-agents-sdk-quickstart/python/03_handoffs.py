"""
03 - Multi-Agent Handoffs
=========================

A triage agent analyzes user intent and routes (hands off) the conversation
to a specialized agent -- either sales or support. Each agent has its own
system prompt and tools.

This demonstrates the handoff pattern that the Agents SDK provides via
Agent.handoff(). Under the hood, handoffs are just tool calls that switch
the active agent.

Pattern: Triage agent -> detect intent -> hand off to specialist agent
         -> specialist responds with domain-specific behavior
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
# Agent definitions -- each agent has a name, instructions, and optional tools
# ---------------------------------------------------------------------------

AGENTS: dict[str, dict[str, Any]] = {
    "triage": {
        "name": "Triage Agent",
        "instructions": (
            "You are a triage agent. Analyze the user's message and decide which "
            "specialist to route them to. Use the handoff_to_sales tool for purchase, "
            "pricing, or product inquiries. Use handoff_to_support for technical issues, "
            "bugs, or account problems. Always hand off -- do not answer directly."
        ),
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "handoff_to_sales",
                    "description": "Route the user to the sales agent for purchasing, pricing, or product questions",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "reason": {"type": "string", "description": "Why this handoff is appropriate"},
                        },
                        "required": ["reason"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "handoff_to_support",
                    "description": "Route the user to the support agent for technical issues or account problems",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "reason": {"type": "string", "description": "Why this handoff is appropriate"},
                        },
                        "required": ["reason"],
                    },
                },
            },
        ],
    },
    "sales": {
        "name": "Sales Agent",
        "instructions": (
            "You are a sales specialist for a SaaS product. You help users with "
            "pricing, plans, and purchasing decisions. Be enthusiastic but honest. "
            "Available plans: Starter ($29/mo), Pro ($99/mo), Enterprise (custom). "
            "Use the check_pricing tool to look up specific plan details."
        ),
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "check_pricing",
                    "description": "Look up pricing details for a specific plan",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "plan": {"type": "string", "enum": ["starter", "pro", "enterprise"]},
                        },
                        "required": ["plan"],
                    },
                },
            },
        ],
    },
    "support": {
        "name": "Support Agent",
        "instructions": (
            "You are a technical support specialist. Help users troubleshoot issues, "
            "explain features, and resolve account problems. Be patient and thorough. "
            "Use the lookup_account tool to check account status."
        ),
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "lookup_account",
                    "description": "Look up account details by email",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "email": {"type": "string", "description": "User's email address"},
                        },
                        "required": ["email"],
                    },
                },
            },
        ],
    },
}


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def check_pricing(plan: str) -> dict[str, Any]:
    """Look up pricing for a plan."""
    plans = {
        "starter": {"name": "Starter", "price": "$29/mo", "features": ["5 users", "10GB storage", "Email support"]},
        "pro": {"name": "Pro", "price": "$99/mo", "features": ["25 users", "100GB storage", "Priority support", "API access"]},
        "enterprise": {"name": "Enterprise", "price": "Custom", "features": ["Unlimited users", "Unlimited storage", "24/7 support", "SLA", "SSO"]},
    }
    return plans.get(plan, {"error": "Unknown plan"})


def lookup_account(email: str) -> dict[str, Any]:
    """Simulate looking up an account."""
    return {
        "email": email,
        "plan": "Pro",
        "status": "active",
        "created": "2024-06-15",
        "usage": "67% of storage limit",
    }


TOOL_FUNCTIONS: dict[str, Any] = {
    "check_pricing": check_pricing,
    "lookup_account": lookup_account,
}


async def run_agent(agent_key: str, user_message: str, client: AsyncOpenAI, model: str) -> str:
    """Run a single agent to completion, handling any tool calls."""
    agent = AGENTS[agent_key]
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": agent["instructions"]},
        {"role": "user", "content": user_message},
    ]

    while True:
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            tools=agent.get("tools", []) or None,
            temperature=0.3,
        )
        choice = response.choices[0]

        if not choice.message.tool_calls:
            return choice.message.content or ""

        messages.append(choice.message.model_dump())
        for tool_call in choice.message.tool_calls:
            fn_name = tool_call.function.name
            fn_args = json.loads(tool_call.function.arguments)
            fn = TOOL_FUNCTIONS.get(fn_name)
            if fn:
                result = fn(**fn_args)
            else:
                result = {"error": f"Unknown tool: {fn_name}"}
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": json.dumps(result),
            })


async def run_with_handoffs(user_message: str) -> str:
    """
    Run the triage agent, detect handoffs, then run the target agent.

    In the Agents SDK, this is handled automatically by the Runner.
    Here we implement the handoff detection manually.
    """
    client = AsyncOpenAI()
    model = os.getenv("MODEL", "gpt-4o-mini")

    # Step 1: Run triage agent to determine routing
    triage = AGENTS["triage"]
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": triage["instructions"]},
        {"role": "user", "content": user_message},
    ]

    response = await client.chat.completions.create(
        model=model,
        messages=messages,
        tools=triage["tools"],
        temperature=0.1,
    )

    choice = response.choices[0]

    # Step 2: Check if a handoff was triggered
    if choice.message.tool_calls:
        tool_call = choice.message.tool_calls[0]
        fn_name = tool_call.function.name
        fn_args = json.loads(tool_call.function.arguments)

        if fn_name == "handoff_to_sales":
            target = "sales"
        elif fn_name == "handoff_to_support":
            target = "support"
        else:
            return f"Unknown handoff: {fn_name}"

        print(f"  [Handoff] Triage -> {AGENTS[target]['name']} (reason: {fn_args.get('reason', 'N/A')})")

        # Step 3: Run the target agent with the original user message
        return await run_agent(target, user_message, client, model)

    # Fallback: triage responded directly (shouldn't happen with good instructions)
    return choice.message.content or ""


async def main() -> None:
    """Run the handoff example with different user intents."""
    validate_env()

    print("=== Multi-Agent Handoffs ===")
    print()

    queries = [
        "How much does the Pro plan cost? I'm thinking of upgrading.",
        "My API calls are returning 500 errors since yesterday. My email is alice@example.com.",
        "I want to buy the Enterprise plan for my team of 50 people.",
    ]

    for query in queries:
        print(f"User: {query}")
        result = await run_with_handoffs(query)
        print(f"Agent: {result}")
        print()


if __name__ == "__main__":
    asyncio.run(main())
