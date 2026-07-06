"""
Human-in-the-Loop Agent

An agent that pauses for human approval before executing risky actions.
Safe actions (search, draft) run automatically. Dangerous actions (send email)
require explicit user confirmation before execution.

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

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

MODEL = os.getenv("MODEL", "gpt-4o-mini")

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
    required = ["OPENAI_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}")
        print("Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

# Actions classified by risk level. Only actions in REQUIRES_APPROVAL
# will pause for human confirmation before execution.
REQUIRES_APPROVAL = {"send_email"}

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": "Search the web for information. Returns a list of relevant results.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query.",
                    }
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "draft_email",
            "description": (
                "Draft an email. This does NOT send the email -- it only creates a draft "
                "for review. Use send_email to actually send it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": "Recipient email address.",
                    },
                    "subject": {
                        "type": "string",
                        "description": "Email subject line.",
                    },
                    "body": {
                        "type": "string",
                        "description": "Email body text.",
                    },
                },
                "required": ["to", "subject", "body"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_email",
            "description": (
                "Send an email to the specified recipient. This is an irreversible action "
                "that actually delivers the email."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": "Recipient email address.",
                    },
                    "subject": {
                        "type": "string",
                        "description": "Email subject line.",
                    },
                    "body": {
                        "type": "string",
                        "description": "Email body text.",
                    },
                },
                "required": ["to", "subject", "body"],
            },
        },
    },
]

# ---------------------------------------------------------------------------
# Simulated tool implementations
# ---------------------------------------------------------------------------


def execute_search_web(query: str) -> str:
    """Simulate a web search and return results."""
    log("🌐", f"Searching the web for: {query}")
    # In production, you would call a real search API (Tavily, Serper, etc.)
    results = [
        {
            "title": f"Result 1 for '{query}'",
            "url": f"https://example.com/result-1?q={query.replace(' ', '+')}",
            "snippet": f"This is a relevant result about {query}. It contains useful information.",
        },
        {
            "title": f"Result 2 for '{query}'",
            "url": f"https://example.com/result-2?q={query.replace(' ', '+')}",
            "snippet": f"Another perspective on {query} with additional details and data.",
        },
        {
            "title": f"Result 3 for '{query}'",
            "url": f"https://example.com/result-3?q={query.replace(' ', '+')}",
            "snippet": f"Expert analysis of {query} from a trusted source.",
        },
    ]
    return json.dumps(results, indent=2)


def execute_draft_email(to: str, subject: str, body: str) -> str:
    """Simulate drafting an email (safe, no side effects)."""
    log("📝", f"Drafting email to {to}")
    draft = {
        "status": "drafted",
        "to": to,
        "subject": subject,
        "body": body,
        "message": "Email drafted successfully. Use send_email to deliver it.",
    }
    return json.dumps(draft, indent=2)


def execute_send_email(to: str, subject: str, body: str) -> str:
    """Simulate sending an email (risky, irreversible)."""
    log("📧", f"Sending email to {to}")
    # In production, this would call an email API (SendGrid, SES, etc.)
    result = {
        "status": "sent",
        "to": to,
        "subject": subject,
        "message_id": "msg_abc123",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Tool dispatcher
# ---------------------------------------------------------------------------

TOOL_HANDLERS: dict[str, Any] = {
    "search_web": lambda args: execute_search_web(args["query"]),
    "draft_email": lambda args: execute_draft_email(args["to"], args["subject"], args["body"]),
    "send_email": lambda args: execute_send_email(args["to"], args["subject"], args["body"]),
}


def request_human_approval(tool_name: str, args: dict[str, Any]) -> bool:
    """Ask the user for approval before executing a risky action.

    Returns True if the user approves, False otherwise.
    """
    print()
    print("=" * 60)
    print(f"  APPROVAL REQUIRED: {tool_name}")
    print("=" * 60)
    print()
    for key, value in args.items():
        # Indent multi-line values for readability
        value_str = str(value)
        if "\n" in value_str:
            indented = value_str.replace("\n", "\n      ")
            print(f"  {key}: {indented}")
        else:
            print(f"  {key}: {value_str}")
    print()
    print("-" * 60)

    while True:
        choice = input("  Do you approve this action? [y/n]: ").strip().lower()
        if choice in ("y", "yes"):
            return True
        if choice in ("n", "no"):
            return False
        print("  Please enter 'y' or 'n'.")


def execute_tool(tool_name: str, arguments: dict[str, Any]) -> str:
    """Execute a tool, requesting approval if the action is risky.

    Safe tools run automatically. Risky tools (those in REQUIRES_APPROVAL)
    pause and ask the user for confirmation first.
    """
    handler = TOOL_HANDLERS.get(tool_name)
    if handler is None:
        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    # Gate: check if this action requires human approval
    if tool_name in REQUIRES_APPROVAL:
        approved = request_human_approval(tool_name, arguments)
        if not approved:
            log("🚫", f"User denied {tool_name} -- action cancelled")
            return json.dumps({
                "status": "cancelled",
                "reason": "User denied approval for this action.",
            })
        log("✅", f"User approved {tool_name}")

    return handler(arguments)


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a helpful assistant that can search the web, draft emails, and send emails.

When the user asks you to send an email:
1. First draft the email using draft_email so the user can review it.
2. Then use send_email to actually deliver it.

Be conversational and helpful. Summarize search results clearly.
When drafting emails, write professional, concise content."""


async def run_agent_turn(
    client: AsyncOpenAI,
    messages: list[dict[str, Any]],
) -> str:
    """Run one turn of the agent loop (may involve multiple tool calls).

    Sends the conversation to the model, processes any tool calls
    (with approval gates for risky actions), and returns the final
    text response.
    """
    while True:
        try:
            response = await client.chat.completions.create(
                model=MODEL,
                messages=messages,
                tools=TOOLS,
                tool_choice="auto",
            )
        except Exception as exc:
            log("❌", f"API error: {exc}")
            return f"Sorry, I encountered an error: {exc}"

        choice = response.choices[0]
        message = choice.message

        # Append the assistant message to the conversation
        messages.append(message.model_dump(exclude_none=True))

        # If the model wants to call tools, process them
        if message.tool_calls:
            for tool_call in message.tool_calls:
                fn_name = tool_call.function.name
                try:
                    fn_args = json.loads(tool_call.function.arguments)
                except json.JSONDecodeError:
                    fn_args = {}

                if fn_name in REQUIRES_APPROVAL:
                    log("⚠️", f"Risky action detected: {fn_name} -- requesting approval")
                else:
                    log("⚙️", f"Executing safe action: {fn_name}")

                result = execute_tool(fn_name, fn_args)

                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result,
                })

            # Continue the loop so the model can process tool results
            continue

        # No tool calls -- return the text response
        return message.content or ""


async def chat_loop() -> None:
    """Run an interactive chat loop with the human-in-the-loop agent."""
    client = AsyncOpenAI()
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
    ]

    print()
    print("Human-in-the-Loop Agent")
    print("=" * 40)
    print("This agent can search the web, draft emails, and send emails.")
    print("Sending emails requires your explicit approval.")
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

        log("🤖", "Thinking...")
        reply = await run_agent_turn(client, messages)

        print(f"\nAssistant: {reply}\n")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Start the human-in-the-loop agent."""
    validate_env()
    log("🚀", "Starting human-in-the-loop agent...")
    log("🔒", f"Actions requiring approval: {', '.join(REQUIRES_APPROVAL)}")
    await chat_loop()
    log("👋", "Goodbye!")


if __name__ == "__main__":
    asyncio.run(main())
