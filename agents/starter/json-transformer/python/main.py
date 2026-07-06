"""
JSON Transformer Agent -- Transforms JSON data based on natural language
instructions using OpenAI.

Takes input JSON (from file, stdin, or CLI arg) and a transformation
description, then uses an LLM to produce the transformed output.
"""

import os
import sys
import json
import asyncio
import argparse
from pathlib import Path

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o-mini"
MAX_RETRIES = 3
MAX_INPUT_SIZE = 200_000  # ~200K chars

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
# Input handling -- file, stdin, or CLI argument
# ---------------------------------------------------------------------------


def read_json_from_file(file_path: str) -> str:
    """Read JSON from a file. Returns the raw string."""
    abs_path = Path(file_path).resolve()
    if not abs_path.is_file():
        print(f"❌ File not found: {file_path}")
        sys.exit(1)

    try:
        content = abs_path.read_text(encoding="utf-8")
    except PermissionError:
        print(f"❌ Permission denied: {file_path}")
        sys.exit(1)
    except OSError as e:
        print(f"❌ Could not read file: {e}")
        sys.exit(1)

    if len(content) > MAX_INPUT_SIZE:
        log("⚠️", f"Input is very large ({len(content):,} chars). Truncating to {MAX_INPUT_SIZE:,} chars.")
        content = content[:MAX_INPUT_SIZE]

    return content


def read_json_from_stdin() -> str:
    """Read JSON from stdin (piped input)."""
    if sys.stdin.isatty():
        print("❌ No input JSON provided.")
        print("   Use --input FILE, pipe via stdin, or see --help for usage.")
        sys.exit(1)

    try:
        content = sys.stdin.read()
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)

    if not content.strip():
        print("❌ Empty input. Provide JSON via --input FILE or stdin pipe.")
        sys.exit(1)

    if len(content) > MAX_INPUT_SIZE:
        log("⚠️", f"Input is very large ({len(content):,} chars). Truncating to {MAX_INPUT_SIZE:,} chars.")
        content = content[:MAX_INPUT_SIZE]

    return content


def validate_json(raw: str, label: str = "input") -> None:
    """Validate that a string is valid JSON. Exits on failure."""
    try:
        json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"❌ Invalid JSON in {label}: {e}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# JSON transformation via OpenAI
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a JSON transformation expert. You take input JSON and transform it according to the user's natural language instructions.

Rules:
- Output ONLY valid JSON. No markdown fencing, no explanations, no text before or after.
- Preserve data types unless the transformation explicitly requires changing them.
- If the input is a JSON array, output a JSON array. If it's an object, output an object (unless the transformation changes the structure).
- Handle edge cases gracefully: empty arrays, null values, missing fields.
- If a transformation is ambiguous, choose the most common/sensible interpretation.
- Pretty-print the output JSON with 2-space indentation.
- Never fabricate data. Only transform what's provided in the input.
- If the transformation cannot be applied (e.g., the field doesn't exist), return the input unchanged and add a top-level "_warning" field explaining why."""


async def transform_json(
    input_json: str,
    instructions: str,
    model: str,
) -> str:
    """Send input JSON and transformation instructions to OpenAI, return transformed JSON."""
    client = AsyncOpenAI()

    user_message = f"""Transform the following JSON according to these instructions:

**Instructions:** {instructions}

**Input JSON:**
```json
{input_json}
```"""

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
                temperature=0.1,  # Low temperature for deterministic transformations
                max_tokens=16_384,
            )

            result = response.choices[0].message.content or ""

            # Strip markdown fencing if the model adds it despite instructions
            result = result.strip()
            if result.startswith("```json"):
                result = result[7:]
            if result.startswith("```"):
                result = result[3:]
            if result.endswith("```"):
                result = result[:-3]
            result = result.strip()

            return result

        except Exception as e:
            error_str = str(e)
            is_transient = (
                "rate" in error_str.lower()
                or "overloaded" in error_str.lower()
                or "429" in error_str
                or "500" in error_str
            )

            if attempt < MAX_RETRIES and is_transient:
                wait_time = 2 ** attempt
                log("⏳", f"API error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait_time}s...")
                await asyncio.sleep(wait_time)
            else:
                raise

    raise RuntimeError("Unreachable: max retries exceeded")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Transform JSON data using natural language instructions.",
        epilog='Examples:\n'
               '  python main.py --input data.json "Flatten nested objects"\n'
               '  cat data.json | python main.py "Add an id field to each object"\n'
               '  python main.py --input data.json --output result.json "Rename firstName to first_name"\n',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "instructions",
        nargs="?",
        default=None,
        help="Natural language description of the transformation",
    )
    parser.add_argument(
        "--input", "-i",
        type=str,
        default=None,
        help="Path to the input JSON file",
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        default=None,
        help="Path to save the transformed JSON",
    )
    return parser.parse_args()


async def main() -> None:
    """Main entry point for the JSON transformer agent."""
    validate_env()

    args = parse_args()
    model = os.getenv("MODEL", DEFAULT_MODEL)

    # Get transformation instructions
    if not args.instructions:
        print("❌ No transformation instructions provided.")
        print('   Usage: python main.py --input data.json "Your transformation instructions"')
        sys.exit(1)

    log("🚀", "Starting JSON transformer agent...")
    log("🤖", f"Model: {model}")
    print()

    # Get input JSON
    if args.input:
        log("📄", f"Reading: {args.input}")
        input_json = read_json_from_file(args.input)
    else:
        log("📄", "Reading JSON from stdin...")
        input_json = read_json_from_stdin()

    # Validate input is valid JSON
    validate_json(input_json, "input")

    # Show input stats
    try:
        parsed = json.loads(input_json)
        if isinstance(parsed, list):
            log("📊", f"Input: JSON array with {len(parsed)} items")
        elif isinstance(parsed, dict):
            log("📊", f"Input: JSON object with {len(parsed)} keys")
        else:
            log("📊", f"Input: JSON {type(parsed).__name__}")
    except json.JSONDecodeError:
        pass

    log("🔄", f"Transformation: {args.instructions}")
    print()
    log("⚡", "Transforming...")

    try:
        result = await transform_json(input_json, args.instructions, model)
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error during transformation: {e}")
        print("   Check your OPENAI_API_KEY and network connection.")
        sys.exit(1)

    # Validate output is valid JSON
    try:
        parsed_result = json.loads(result)
        # Re-format with consistent indentation
        result = json.dumps(parsed_result, indent=2, ensure_ascii=False)
    except json.JSONDecodeError:
        log("⚠️", "Warning: Output is not valid JSON. Showing raw output.")

    print()

    # Output the result
    if args.output:
        output_path = Path(args.output)
        try:
            output_path.write_text(result + "\n", encoding="utf-8")
            log("✅", f"Transformed JSON saved to: {output_path}")
        except OSError as e:
            print(f"❌ Could not write file: {e}")
            sys.exit(1)
    else:
        print(result)

    print()
    log("✅", "Done!")


if __name__ == "__main__":
    asyncio.run(main())
