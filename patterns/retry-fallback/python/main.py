"""
Retry & Fallback Agent

An agent with exponential backoff retry logic and automatic model fallback.
If the primary model (Claude) fails after all retries, it falls back to
the secondary model (GPT-4o-mini) transparently.

Usage:
    python main.py                     # Normal mode
    python main.py --simulate-failure  # Simulate primary model failure
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import anthropic
import openai
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PRIMARY_MODEL = os.getenv("PRIMARY_MODEL", "claude-sonnet-4-20250514")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gpt-4o-mini")
MAX_RETRIES = 3
BASE_DELAY_SECONDS = 2  # Exponential backoff: 2s, 4s, 8s

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
    required = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}")
        print("Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Request tracking
# ---------------------------------------------------------------------------


@dataclass
class RequestStats:
    """Track retry and fallback statistics for each request."""
    primary_attempts: int = 0
    fallback_attempts: int = 0
    model_used: str = ""
    total_time_seconds: float = 0.0
    errors: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Retry logic
# ---------------------------------------------------------------------------


async def retry_with_backoff(
    fn: Any,
    max_retries: int = MAX_RETRIES,
    base_delay: float = BASE_DELAY_SECONDS,
    model_label: str = "model",
) -> tuple[Any, int]:
    """Call an async function with exponential backoff retry.

    Returns a tuple of (result, attempts_used).
    Raises the last exception if all retries are exhausted.
    """
    last_error: Exception | None = None

    for attempt in range(1, max_retries + 1):
        try:
            result = await fn()
            return result, attempt
        except (
            anthropic.APIConnectionError,
            anthropic.RateLimitError,
            anthropic.InternalServerError,
            openai.APIConnectionError,
            openai.RateLimitError,
            openai.InternalServerError,
        ) as exc:
            last_error = exc
            if attempt < max_retries:
                delay = base_delay * (2 ** (attempt - 1))
                log("🔄", f"{model_label} attempt {attempt}/{max_retries} failed: {exc}")
                log("⏳", f"Retrying in {delay}s...")
                await asyncio.sleep(delay)
            else:
                log("❌", f"{model_label} attempt {attempt}/{max_retries} failed: {exc}")
        except (
            anthropic.APIStatusError,
            openai.APIStatusError,
        ) as exc:
            # Non-retryable errors (auth failures, bad requests, etc.)
            last_error = exc
            log("❌", f"{model_label} non-retryable error: {exc}")
            raise

    raise last_error  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Model clients
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a helpful, concise assistant. Answer questions directly.
Keep responses clear and to the point."""


class SimulatedFailureError(Exception):
    """Raised when --simulate-failure flag is used."""
    pass


async def call_primary(
    client: anthropic.AsyncAnthropic,
    messages: list[dict[str, str]],
    simulate_failure: bool = False,
) -> str:
    """Call the primary model (Anthropic Claude).

    If simulate_failure is True, raises an error to demonstrate the fallback.
    """
    if simulate_failure:
        raise anthropic.InternalServerError(
            message="Simulated server error for testing fallback",
            response=None,  # type: ignore[arg-type]
            body=None,
        )

    # Convert messages to Anthropic format
    anthropic_messages: list[anthropic.types.MessageParam] = []
    for msg in messages:
        if msg["role"] in ("user", "assistant"):
            anthropic_messages.append({
                "role": msg["role"],  # type: ignore[typeddict-item]
                "content": msg["content"],
            })

    response = await client.messages.create(
        model=PRIMARY_MODEL,
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=anthropic_messages,
    )

    text_blocks = [b.text for b in response.content if b.type == "text"]
    return "\n".join(text_blocks)


async def call_fallback(
    client: openai.AsyncOpenAI,
    messages: list[dict[str, str]],
) -> str:
    """Call the fallback model (OpenAI GPT)."""
    openai_messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for msg in messages:
        if msg["role"] in ("user", "assistant"):
            openai_messages.append({"role": msg["role"], "content": msg["content"]})

    response = await client.chat.completions.create(
        model=FALLBACK_MODEL,
        messages=openai_messages,  # type: ignore[arg-type]
    )

    return response.choices[0].message.content or ""


# ---------------------------------------------------------------------------
# Agent with retry + fallback
# ---------------------------------------------------------------------------


async def send_with_resilience(
    anthropic_client: anthropic.AsyncAnthropic,
    openai_client: openai.AsyncOpenAI,
    messages: list[dict[str, str]],
    simulate_failure: bool = False,
) -> tuple[str, RequestStats]:
    """Send a message with retry logic and model fallback.

    Strategy:
    1. Try primary model with exponential backoff (up to MAX_RETRIES)
    2. If all retries fail, switch to fallback model
    3. Try fallback model with same retry logic

    Returns a tuple of (response_text, stats).
    """
    stats = RequestStats()
    start_time = time.monotonic()

    # -- Try primary model --
    log("🎯", f"Trying primary model: {PRIMARY_MODEL}")
    try:
        result, attempts = await retry_with_backoff(
            fn=lambda: call_primary(anthropic_client, messages, simulate_failure),
            model_label=f"Primary ({PRIMARY_MODEL})",
        )
        stats.primary_attempts = attempts
        stats.model_used = PRIMARY_MODEL
        stats.total_time_seconds = time.monotonic() - start_time
        log("✅", f"Primary model responded (attempt {attempts}/{MAX_RETRIES})")
        return result, stats
    except Exception as exc:
        stats.primary_attempts = MAX_RETRIES
        stats.errors.append(f"Primary: {exc}")
        log("⚠️", f"Primary model exhausted all {MAX_RETRIES} retries")

    # -- Fall back to secondary model --
    log("🔀", f"Falling back to: {FALLBACK_MODEL}")
    try:
        result, attempts = await retry_with_backoff(
            fn=lambda: call_fallback(openai_client, messages),
            model_label=f"Fallback ({FALLBACK_MODEL})",
        )
        stats.fallback_attempts = attempts
        stats.model_used = FALLBACK_MODEL
        stats.total_time_seconds = time.monotonic() - start_time
        log("✅", f"Fallback model responded (attempt {attempts}/{MAX_RETRIES})")
        return result, stats
    except Exception as exc:
        stats.fallback_attempts = MAX_RETRIES
        stats.errors.append(f"Fallback: {exc}")
        stats.total_time_seconds = time.monotonic() - start_time
        log("❌", "Both models failed. All retries exhausted.")
        raise RuntimeError(
            f"Both models failed after retries. "
            f"Errors: {'; '.join(stats.errors)}"
        ) from exc


def print_stats(stats: RequestStats) -> None:
    """Display request statistics."""
    print(f"  Model used: {stats.model_used}")
    print(f"  Primary attempts: {stats.primary_attempts}")
    if stats.fallback_attempts > 0:
        print(f"  Fallback attempts: {stats.fallback_attempts}")
    print(f"  Total time: {stats.total_time_seconds:.2f}s")
    if stats.errors:
        print(f"  Errors encountered: {len(stats.errors)}")


# ---------------------------------------------------------------------------
# Chat loop
# ---------------------------------------------------------------------------


async def chat_loop(simulate_failure: bool = False) -> None:
    """Run an interactive chat loop with retry and fallback."""
    anthropic_client = anthropic.AsyncAnthropic()
    openai_client = openai.AsyncOpenAI()
    messages: list[dict[str, str]] = []

    print()
    print("Retry & Fallback Agent")
    print("=" * 40)
    print(f"Primary model:  {PRIMARY_MODEL}")
    print(f"Fallback model: {FALLBACK_MODEL}")
    print(f"Max retries:    {MAX_RETRIES} (backoff: {BASE_DELAY_SECONDS}s, {BASE_DELAY_SECONDS * 2}s, {BASE_DELAY_SECONDS * 4}s)")
    if simulate_failure:
        print("** SIMULATE FAILURE MODE: primary model will always fail **")
    print("Type 'quit' or 'exit' to stop. Type 'stats' to see last request stats.")
    print()

    last_stats: RequestStats | None = None

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

        if user_input.lower() == "stats":
            if last_stats:
                print("\nLast request stats:")
                print_stats(last_stats)
                print()
            else:
                print("\nNo requests made yet.\n")
            continue

        messages.append({"role": "user", "content": user_input})

        log("🤖", "Processing request...")

        try:
            reply, stats = await send_with_resilience(
                anthropic_client,
                openai_client,
                messages,
                simulate_failure=simulate_failure,
            )
            last_stats = stats
            messages.append({"role": "assistant", "content": reply})
            print(f"\nAssistant [{stats.model_used}]: {reply}\n")
        except RuntimeError as exc:
            log("💀", f"Request failed completely: {exc}")
            print(f"\nSorry, both models are unavailable right now. Please try again later.\n")
            # Remove the failed user message so conversation stays clean
            messages.pop()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Start the retry-fallback agent."""
    parser = argparse.ArgumentParser(description="Retry & Fallback Agent")
    parser.add_argument(
        "--simulate-failure",
        action="store_true",
        help="Simulate primary model failure to demonstrate fallback behavior.",
    )
    args = parser.parse_args()

    validate_env()
    log("🚀", "Starting retry-fallback agent...")
    await chat_loop(simulate_failure=args.simulate_failure)
    log("👋", "Goodbye!")


if __name__ == "__main__":
    asyncio.run(main())
