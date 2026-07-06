"""
Cron Translator Agent -- Converts between natural language and cron expressions.
Auto-detects the input format and translates in the appropriate direction.

Uses OpenAI GPT-4o-mini for translation.
"""

import os
import re
import sys
import json
import asyncio
from datetime import datetime, timedelta
from typing import Any

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o-mini"
MAX_RETRIES = 3

# Cron field names for display
CRON_FIELDS = ["minute", "hour", "day of month", "month", "day of week"]

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        print("   Get your OpenAI key at: https://platform.openai.com/api-keys")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Input detection
# ---------------------------------------------------------------------------


def is_cron_expression(text: str) -> bool:
    """Detect if the input looks like a cron expression.

    A cron expression typically has 5 space-separated fields containing
    digits, asterisks, slashes, commas, or hyphens.
    """
    text = text.strip()
    # Check if it has 5 space-separated tokens that look like cron fields
    parts = text.split()
    if len(parts) != 5:
        return False

    cron_field_pattern = re.compile(r'^[\d*,/\-LW#?]+$')
    return all(cron_field_pattern.match(part) for part in parts)


# ---------------------------------------------------------------------------
# Next run time calculation
# ---------------------------------------------------------------------------


def parse_cron_field(field: str, min_val: int, max_val: int) -> list[int]:
    """Parse a single cron field into a list of matching values."""
    values: set[int] = set()

    for part in field.split(","):
        # Handle step values (*/2, 1-5/2)
        step = 1
        if "/" in part:
            part, step_str = part.split("/", 1)
            try:
                step = int(step_str)
            except ValueError:
                return list(range(min_val, max_val + 1))

        if part == "*":
            values.update(range(min_val, max_val + 1, step))
        elif "-" in part:
            try:
                start, end = part.split("-", 1)
                start_int = int(start)
                end_int = int(end)
                values.update(range(start_int, end_int + 1, step))
            except ValueError:
                return list(range(min_val, max_val + 1))
        else:
            try:
                values.add(int(part))
            except ValueError:
                return list(range(min_val, max_val + 1))

    return sorted(values)


def calculate_next_runs(cron_expr: str, count: int = 5) -> list[str]:
    """Calculate the next N run times for a cron expression.

    This is a simplified calculator that handles standard 5-field cron.
    For complex expressions, it provides a best-effort approximation.
    """
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        return ["(Could not parse cron expression)"]

    try:
        minutes = parse_cron_field(parts[0], 0, 59)
        hours = parse_cron_field(parts[1], 0, 23)
        days_of_month = parse_cron_field(parts[2], 1, 31)
        months = parse_cron_field(parts[3], 1, 12)
        days_of_week = parse_cron_field(parts[4], 0, 6)  # 0=Sunday
    except Exception:
        return ["(Could not parse cron expression)"]

    # Check if day-of-week is restricted (not all days)
    dow_restricted = parts[4] != "*"
    dom_restricted = parts[2] != "*"

    now = datetime.now().replace(second=0, microsecond=0)
    current = now + timedelta(minutes=1)
    results: list[str] = []
    max_iterations = 525_600  # One year of minutes

    for _ in range(max_iterations):
        if current.month not in months:
            # Skip to next month
            if current.month == 12:
                current = current.replace(year=current.year + 1, month=1, day=1, hour=0, minute=0)
            else:
                current = current.replace(month=current.month + 1, day=1, hour=0, minute=0)
            continue

        # Check day constraints
        # Python weekday: Monday=0..Sunday=6, cron: Sunday=0..Saturday=6
        py_dow = (current.weekday() + 1) % 7  # Convert to cron format

        day_match = True
        if dom_restricted and dow_restricted:
            # When both are restricted, match either (standard cron behavior)
            day_match = current.day in days_of_month or py_dow in days_of_week
        elif dom_restricted:
            day_match = current.day in days_of_month
        elif dow_restricted:
            day_match = py_dow in days_of_week

        if not day_match:
            current += timedelta(days=1)
            current = current.replace(hour=0, minute=0)
            continue

        if current.hour not in hours:
            current += timedelta(hours=1)
            current = current.replace(minute=0)
            continue

        if current.minute not in minutes:
            current += timedelta(minutes=1)
            continue

        results.append(current.strftime("%Y-%m-%d %H:%M (%A)"))
        current += timedelta(minutes=1)

        if len(results) >= count:
            break

    return results if results else ["(No runs found in the next year)"]


# ---------------------------------------------------------------------------
# Translation via OpenAI
# ---------------------------------------------------------------------------

SYSTEM_PROMPT_TO_CRON = """You are an expert at writing cron expressions. Given a natural language description of a schedule, generate the corresponding 5-field cron expression.

You MUST respond with valid JSON in this exact format:
{
  "cron": "the 5-field cron expression",
  "explanation": "a human-readable explanation of what the cron expression does, field by field",
  "fields": {
    "minute": "explanation of the minute field value",
    "hour": "explanation of the hour field value",
    "day_of_month": "explanation of the day-of-month field value",
    "month": "explanation of the month field value",
    "day_of_week": "explanation of the day-of-week field value"
  }
}

Rules:
- Use standard 5-field cron format: minute hour day-of-month month day-of-week
- Day of week: 0=Sunday, 1=Monday, ..., 6=Saturday
- Use * for "every", */N for "every Nth", ranges (1-5), lists (1,3,5)
- Assume UTC unless the user specifies a timezone
- Be precise: "every weekday at 9am" means "0 9 * * 1-5", not "0 9 * * *"
- Output ONLY the JSON object"""

SYSTEM_PROMPT_TO_ENGLISH = """You are an expert at reading cron expressions. Given a 5-field cron expression, explain what it does in clear, natural language.

You MUST respond with valid JSON in this exact format:
{
  "description": "a clear, natural language description of when this cron job runs",
  "explanation": "a detailed field-by-field breakdown of the cron expression",
  "fields": {
    "minute": "explanation of the minute field value",
    "hour": "explanation of the hour field value",
    "day_of_month": "explanation of the day-of-month field value",
    "month": "explanation of the month field value",
    "day_of_week": "explanation of the day-of-week field value"
  }
}

Rules:
- Describe the schedule in plain English that anyone can understand
- Include frequency: how often it runs (every minute, hourly, daily, weekly, etc.)
- Be specific about times, days, and any constraints
- Mention edge cases or notable behaviors
- Output ONLY the JSON object"""


async def translate(input_text: str, is_cron: bool, model: str) -> dict[str, Any]:
    """Send the input to the model and return the translation."""
    client = AsyncOpenAI()

    if is_cron:
        system_prompt = SYSTEM_PROMPT_TO_ENGLISH
        user_message = f"Explain this cron expression: {input_text}"
    else:
        system_prompt = SYSTEM_PROMPT_TO_CRON
        user_message = f"Convert this schedule to a cron expression: {input_text}"

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.chat.completions.create(
                model=model,
                max_tokens=1024,
                temperature=0.2,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                response_format={"type": "json_object"},
            )

            content = response.choices[0].message.content
            if not content:
                raise ValueError("Empty response from API")

            result = json.loads(content)
            return result

        except json.JSONDecodeError as e:
            if attempt < MAX_RETRIES:
                log("⏳", f"Invalid JSON response (attempt {attempt}/{MAX_RETRIES}), retrying...")
                await asyncio.sleep(2 ** attempt)
            else:
                print(f"❌ Failed to parse API response as JSON: {e}")
                sys.exit(1)
        except Exception as e:
            error_str = str(e)
            is_transient = any(
                keyword in error_str.lower()
                for keyword in ["rate", "overloaded", "529", "500", "timeout"]
            )
            if attempt < MAX_RETRIES and is_transient:
                wait_time = 2 ** attempt
                log("⏳", f"API error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait_time}s...")
                await asyncio.sleep(wait_time)
            else:
                raise

    raise RuntimeError("Unreachable: max retries exceeded")


# ---------------------------------------------------------------------------
# Display helpers
# ---------------------------------------------------------------------------


def display_cron_result(result: dict[str, Any], cron_expr: str) -> None:
    """Display the result of a natural language -> cron translation."""
    print()
    print("=" * 60)
    log("🎯", "Generated Cron Expression")
    print("=" * 60)
    print()
    print(f"  Cron:  {cron_expr}")
    print()

    # Field breakdown
    fields = result.get("fields", {})
    if fields:
        parts = cron_expr.split()
        print("  Field breakdown:")
        for i, (field_name, value) in enumerate(zip(CRON_FIELDS, parts)):
            field_key = field_name.replace(" ", "_")
            desc = fields.get(field_key, "")
            print(f"    {value:>10}  {field_name:<15}  {desc}")
        print()

    # Explanation
    explanation = result.get("explanation", "")
    if explanation:
        print("-" * 60)
        log("📖", "Explanation")
        print("-" * 60)
        print()
        for line in explanation.splitlines():
            print(f"  {line}")
        print()

    # Next run times
    print("-" * 60)
    log("⏰", "Next 5 Run Times")
    print("-" * 60)
    print()
    next_runs = calculate_next_runs(cron_expr)
    for i, run_time in enumerate(next_runs, 1):
        print(f"  {i}. {run_time}")
    print()

    # Usage examples
    print("-" * 60)
    log("💻", "Usage")
    print("-" * 60)
    print()
    print(f"  crontab:    {cron_expr} /path/to/command")
    print(f"  GitHub Actions:  cron: '{cron_expr}'")
    print()
    print("=" * 60)


def display_english_result(result: dict[str, Any], cron_expr: str) -> None:
    """Display the result of a cron -> natural language translation."""
    print()
    print("=" * 60)
    log("🎯", "Cron Expression Explained")
    print("=" * 60)
    print()
    print(f"  Cron:     {cron_expr}")
    print(f"  Meaning:  {result.get('description', 'N/A')}")
    print()

    # Field breakdown
    fields = result.get("fields", {})
    if fields:
        parts = cron_expr.split()
        print("  Field breakdown:")
        for i, (field_name, value) in enumerate(zip(CRON_FIELDS, parts)):
            field_key = field_name.replace(" ", "_")
            desc = fields.get(field_key, "")
            print(f"    {value:>10}  {field_name:<15}  {desc}")
        print()

    # Detailed explanation
    explanation = result.get("explanation", "")
    if explanation:
        print("-" * 60)
        log("📖", "Detailed Explanation")
        print("-" * 60)
        print()
        for line in explanation.splitlines():
            print(f"  {line}")
        print()

    # Next run times
    print("-" * 60)
    log("⏰", "Next 5 Run Times")
    print("-" * 60)
    print()
    next_runs = calculate_next_runs(cron_expr)
    for i, run_time in enumerate(next_runs, 1):
        print(f"  {i}. {run_time}")
    print()
    print("=" * 60)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the cron translator agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    # Parse CLI arguments
    input_text: str | None = None

    i = 0
    while i < len(args):
        if args[i] in ("--help", "-h"):
            print("Usage: python main.py [INPUT]")
            print()
            print("Translates between natural language and cron expressions.")
            print("Auto-detects the direction based on input format.")
            print()
            print("Arguments:")
            print("  INPUT    Natural language schedule or cron expression")
            print()
            print("Examples:")
            print('  python main.py "Every weekday at 9am"')
            print('  python main.py "Every 15 minutes"')
            print('  python main.py "First Monday of every month at noon"')
            print('  python main.py "0 9 * * 1-5"')
            print('  python main.py "*/15 * * * *"')
            print('  python main.py "0 0 1 * *"')
            print()
            print("If no input is given, you'll be prompted interactively.")
            sys.exit(0)
        elif not input_text and not args[i].startswith("--"):
            input_text = args[i]
            i += 1
        else:
            print(f"❌ Unknown argument: {args[i]}")
            print("   Use --help for usage information.")
            sys.exit(1)
        i += 1

    log("🚀", "Starting cron translator agent...")
    log("🤖", f"Model: {model}")
    print()

    # Get input interactively if not provided
    if not input_text:
        try:
            input_text = input("📝 Enter a schedule or cron expression: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\n❌ Cancelled.")
            sys.exit(0)

        if not input_text:
            print("❌ No input provided.")
            sys.exit(1)

    # Detect direction
    is_cron = is_cron_expression(input_text)

    if is_cron:
        log("🔄", f"Detected cron expression: {input_text}")
        log("🔍", "Translating to natural language...")
    else:
        log("🔄", f"Detected natural language: {input_text}")
        log("🔍", "Generating cron expression...")

    # Translate
    try:
        result = await translate(input_text, is_cron, model)
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error during translation: {e}")
        print("   Check your OPENAI_API_KEY and network connection.")
        sys.exit(1)

    # Display results
    if is_cron:
        display_english_result(result, input_text)
    else:
        cron_expr = result.get("cron", "")
        if not cron_expr:
            print("❌ The model did not return a cron expression.")
            sys.exit(1)
        display_cron_result(result, cron_expr)

    log("✅", "Done!")


if __name__ == "__main__":
    asyncio.run(main())
