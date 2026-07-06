"""
Fine-Tune Data Generator -- Generates synthetic training data for fine-tuning
language models on custom tasks.

Uses Anthropic Claude to produce diverse, high-quality input/output pairs
in OpenAI-compatible JSONL format (messages array).
"""

import os
import sys
import json
import asyncio
import random
from typing import Any

from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
DEFAULT_COUNT = 50
DEFAULT_OUTPUT = "training_data.jsonl"
MAX_RETRIES = 3
BATCH_SIZE = 10  # Generate examples in batches for diversity

# Difficulty levels to ensure variety in generated data
DIFFICULTY_LEVELS = ["simple", "moderate", "complex", "edge-case"]

# Length preferences to ensure variety
LENGTH_PREFERENCES = ["short (1-2 sentences)", "medium (3-5 sentences)", "long (1-2 paragraphs)"]


# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["ANTHROPIC_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        print("   Get your Anthropic key at: https://console.anthropic.com/settings/keys")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------


def build_generation_prompt(
    task_description: str,
    batch_size: int,
    difficulty: str,
    length_pref: str,
    existing_examples: list[dict[str, Any]],
) -> str:
    """Build the prompt for generating a batch of training examples."""
    existing_summary = ""
    if existing_examples:
        # Show a few existing examples so the model avoids duplicates
        sample = random.sample(existing_examples, min(3, len(existing_examples)))
        existing_summary = "\n\nExamples already generated (avoid duplicates and similar patterns):\n"
        for i, ex in enumerate(sample, 1):
            user_msg = next((m["content"] for m in ex["messages"] if m["role"] == "user"), "")
            existing_summary += f"  {i}. \"{user_msg[:100]}...\"\n" if len(user_msg) > 100 else f"  {i}. \"{user_msg}\"\n"

    return f"""Generate exactly {batch_size} training examples for this task:

Task: {task_description}

Requirements:
- Difficulty level: {difficulty}
- Response length preference: {length_pref}
- Each example must be realistic and something a real user would actually ask
- Vary the phrasing, tone, and specificity across examples
- Include edge cases and ambiguous inputs where appropriate
- The assistant responses should be high quality, accurate, and consistent
- Do NOT include any meta-commentary or explanations outside the examples
{existing_summary}
Output format: Return a JSON array where each element has this structure:
{{
  "messages": [
    {{"role": "system", "content": "<system prompt for the task>"}},
    {{"role": "user", "content": "<user input>"}},
    {{"role": "assistant", "content": "<ideal assistant response>"}}
  ]
}}

Return ONLY the JSON array, no markdown fences, no extra text. The system message
should be the same across all examples and should clearly define the task."""


# ---------------------------------------------------------------------------
# Data generation
# ---------------------------------------------------------------------------


async def generate_batch(
    client: AsyncAnthropic,
    model: str,
    task_description: str,
    batch_size: int,
    difficulty: str,
    length_pref: str,
    existing_examples: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Generate a batch of training examples using Claude."""
    prompt = build_generation_prompt(
        task_description, batch_size, difficulty, length_pref, existing_examples
    )

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=8192,
                temperature=0.9,  # Higher temperature for diversity
                messages=[{"role": "user", "content": prompt}],
            )

            # Extract text content
            text = ""
            for block in response.content:
                if block.type == "text":
                    text += block.text

            # Parse JSON response
            text = text.strip()
            # Handle potential markdown fences
            if text.startswith("```"):
                text = text.split("\n", 1)[1]
                if text.endswith("```"):
                    text = text[:-3]
                text = text.strip()

            examples = json.loads(text)

            if not isinstance(examples, list):
                log("⚠️", f"Expected JSON array, got {type(examples).__name__}. Retrying...")
                continue

            # Validate each example has the correct structure
            valid_examples: list[dict[str, Any]] = []
            for ex in examples:
                if validate_example(ex):
                    valid_examples.append(ex)

            if not valid_examples:
                log("⚠️", "No valid examples in batch. Retrying...")
                continue

            return valid_examples

        except json.JSONDecodeError:
            if attempt < MAX_RETRIES:
                log("⚠️", f"Invalid JSON response (attempt {attempt}/{MAX_RETRIES}). Retrying...")
                await asyncio.sleep(2 ** attempt)
            else:
                log("❌", "Failed to parse JSON after all retries.")
                return []
        except Exception as e:
            error_str = str(e)
            if attempt < MAX_RETRIES and (
                "rate" in error_str.lower()
                or "overloaded" in error_str.lower()
            ):
                wait_time = 2 ** attempt
                log("⏳", f"API error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait_time}s...")
                await asyncio.sleep(wait_time)
            else:
                raise

    return []


def validate_example(example: dict[str, Any]) -> bool:
    """Validate that a training example has the correct structure."""
    if not isinstance(example, dict):
        return False
    if "messages" not in example:
        return False
    messages = example["messages"]
    if not isinstance(messages, list) or len(messages) < 2:
        return False

    # Check that we have at least user and assistant roles
    roles = [m.get("role") for m in messages]
    if "user" not in roles or "assistant" not in roles:
        return False

    # Check all messages have content
    for msg in messages:
        if not isinstance(msg.get("content"), str) or not msg["content"].strip():
            return False

    return True


def deduplicate_examples(examples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove duplicate examples based on user message content."""
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []

    for ex in examples:
        user_msg = next(
            (m["content"].strip().lower() for m in ex["messages"] if m["role"] == "user"),
            "",
        )
        if user_msg and user_msg not in seen:
            seen.add(user_msg)
            unique.append(ex)

    return unique


async def generate_training_data(
    task_description: str,
    count: int,
    model: str,
) -> list[dict[str, Any]]:
    """Generate the full set of training examples."""
    client = AsyncAnthropic()
    all_examples: list[dict[str, Any]] = []

    # Calculate how many batches we need
    remaining = count
    batch_num = 0

    while remaining > 0:
        batch_num += 1
        current_batch_size = min(BATCH_SIZE, remaining)

        # Rotate through difficulty levels and length preferences
        difficulty = DIFFICULTY_LEVELS[(batch_num - 1) % len(DIFFICULTY_LEVELS)]
        length_pref = LENGTH_PREFERENCES[(batch_num - 1) % len(LENGTH_PREFERENCES)]

        log(
            "🔄",
            f"Batch {batch_num}: generating {current_batch_size} examples "
            f"(difficulty={difficulty}, length={length_pref})",
        )

        batch = await generate_batch(
            client=client,
            model=model,
            task_description=task_description,
            batch_size=current_batch_size,
            difficulty=difficulty,
            length_pref=length_pref,
            existing_examples=all_examples,
        )

        if batch:
            all_examples.extend(batch)
            all_examples = deduplicate_examples(all_examples)
            log("✅", f"Got {len(batch)} examples. Total unique: {len(all_examples)}/{count}")
        else:
            log("⚠️", "Empty batch, continuing...")

        remaining = count - len(all_examples)

        # Small delay between batches to avoid rate limits
        if remaining > 0:
            await asyncio.sleep(1)

    return all_examples[:count]


def write_jsonl(examples: list[dict[str, Any]], output_path: str) -> None:
    """Write examples to a JSONL file in OpenAI fine-tuning format."""
    abs_path = os.path.abspath(output_path)
    with open(abs_path, "w", encoding="utf-8") as f:
        for ex in examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")
    log("💾", f"Wrote {len(examples)} examples to {abs_path}")


def print_stats(examples: list[dict[str, Any]]) -> None:
    """Print statistics about the generated dataset."""
    if not examples:
        return

    total_messages = sum(len(ex["messages"]) for ex in examples)
    user_lengths = [
        len(m["content"])
        for ex in examples
        for m in ex["messages"]
        if m["role"] == "user"
    ]
    assistant_lengths = [
        len(m["content"])
        for ex in examples
        for m in ex["messages"]
        if m["role"] == "assistant"
    ]

    print()
    log("📊", "Dataset Statistics")
    print("═" * 40)
    print(f"  Total examples:        {len(examples)}")
    print(f"  Total messages:        {total_messages}")
    if user_lengths:
        print(f"  Avg user msg length:   {sum(user_lengths) // len(user_lengths)} chars")
    if assistant_lengths:
        print(f"  Avg assistant length:  {sum(assistant_lengths) // len(assistant_lengths)} chars")
        print(f"  Min assistant length:  {min(assistant_lengths)} chars")
        print(f"  Max assistant length:  {max(assistant_lengths)} chars")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def parse_args() -> tuple[str, int, str]:
    """Parse CLI arguments. Returns (task_description, count, output_path)."""
    args = sys.argv[1:]
    task_description: str | None = None
    count = DEFAULT_COUNT
    output_path = DEFAULT_OUTPUT

    i = 0
    while i < len(args):
        if args[i] in ("--count", "-n") and i + 1 < len(args):
            try:
                count = int(args[i + 1])
                if count < 1:
                    print("❌ Count must be at least 1.")
                    sys.exit(1)
            except ValueError:
                print(f"❌ Invalid count: {args[i + 1]}")
                sys.exit(1)
            i += 2
        elif args[i] in ("--output", "-o") and i + 1 < len(args):
            output_path = args[i + 1]
            i += 2
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py <task_description> [OPTIONS]")
            print()
            print("Arguments:")
            print("  task_description       Description of the task to generate data for")
            print()
            print("Options:")
            print(f"  --count, -n NUMBER     Number of examples to generate (default: {DEFAULT_COUNT})")
            print(f"  --output, -o PATH      Output JSONL file path (default: {DEFAULT_OUTPUT})")
            print("  --help, -h             Show this help message")
            print()
            print("Examples:")
            print('  python main.py "Classify customer support tickets into billing/technical/general"')
            print('  python main.py "Summarize news articles in one sentence" --count 100')
            print('  python main.py "Translate English to French" -n 200 -o french_data.jsonl')
            sys.exit(0)
        elif not task_description and not args[i].startswith("-"):
            task_description = args[i]
            i += 1
        else:
            print(f"❌ Unknown argument: {args[i]}")
            print("   Use --help for usage information.")
            sys.exit(1)

    if not task_description:
        print("❌ Task description is required.")
        print("   Usage: python main.py \"<task description>\" [--count N] [--output file.jsonl]")
        print("   Use --help for more information.")
        sys.exit(1)

    return task_description, count, output_path


async def main() -> None:
    """Main entry point for the fine-tune data generator."""
    validate_env()

    task_description, count, output_path = parse_args()
    model = os.getenv("MODEL", DEFAULT_MODEL)

    log("🚀", "Starting fine-tune data generator...")
    log("🤖", f"Model: {model}")
    log("📋", f"Task: {task_description}")
    log("🔢", f"Target examples: {count}")
    log("📁", f"Output: {output_path}")
    print()

    try:
        examples = await generate_training_data(task_description, count, model)
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error generating data: {e}")
        print("   Check your ANTHROPIC_API_KEY and network connection.")
        sys.exit(1)

    if not examples:
        print("❌ No examples were generated. Try a different task description.")
        sys.exit(1)

    write_jsonl(examples, output_path)
    print_stats(examples)

    print()
    log("✅", f"Done! Generated {len(examples)} training examples.")
    log("💡", "To fine-tune with OpenAI, run:")
    print(f"   openai api fine_tuning.jobs.create -t {output_path} -m gpt-4o-mini-2024-07-18")


if __name__ == "__main__":
    asyncio.run(main())
