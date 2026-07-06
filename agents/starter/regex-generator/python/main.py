"""
Regex Generator Agent -- Takes a natural language description and generates a
tested regular expression with explanation.

Uses OpenAI GPT-4o-mini for generation and Python's re module for validation.
"""

import os
import re
import sys
import json
import asyncio
from typing import Any

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o-mini"
MAX_RETRIES = 3

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
# Regex generation via OpenAI
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert at writing regular expressions. Given a natural language description, generate a regex pattern that matches the described text.

You MUST respond with valid JSON in this exact format:
{
  "pattern": "the regex pattern as a string",
  "flags": "any flags to use (e.g., 'i' for case-insensitive, 'g' for global, 'm' for multiline) -- leave empty string if none",
  "explanation": "a clear, line-by-line breakdown of what each part of the regex does",
  "examples_match": ["list of 3-5 example strings that SHOULD match"],
  "examples_no_match": ["list of 3-5 example strings that should NOT match"]
}

Rules:
- The pattern must be valid in both Python (re module) and JavaScript (RegExp)
- Prefer readable patterns over clever ones -- use character classes and named groups where helpful
- Escape special characters properly
- The explanation should be understandable by someone who doesn't know regex well
- Break down the pattern piece by piece in the explanation
- Be precise: "match email addresses" means RFC-compliant-ish emails, not just "anything with @"
- Consider edge cases in your examples (e.g., for emails: subdomains, plus addressing, TLDs)
- Output ONLY the JSON object, no markdown fencing, no extra text"""


async def generate_regex(description: str, model: str) -> dict[str, Any]:
    """Send the description to the model and return the generated regex info."""
    client = AsyncOpenAI()

    user_message = f"Generate a regex pattern for: {description}"

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.chat.completions.create(
                model=model,
                max_tokens=1024,
                temperature=0.2,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
                response_format={"type": "json_object"},
            )

            content = response.choices[0].message.content
            if not content:
                raise ValueError("Empty response from API")

            result = json.loads(content)

            # Validate required fields
            required_fields = ["pattern", "explanation"]
            for field in required_fields:
                if field not in result:
                    raise ValueError(f"Missing required field: {field}")

            # Set defaults for optional fields
            result.setdefault("flags", "")
            result.setdefault("examples_match", [])
            result.setdefault("examples_no_match", [])

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
# Regex testing
# ---------------------------------------------------------------------------


def test_regex(pattern: str, flags_str: str, test_strings: list[str]) -> list[dict[str, Any]]:
    """Test a regex pattern against a list of strings. Returns results."""
    # Build re flags from string
    flag_map: dict[str, int] = {
        "i": re.IGNORECASE,
        "m": re.MULTILINE,
        "s": re.DOTALL,
    }
    flags = 0
    for char in flags_str:
        if char in flag_map:
            flags |= flag_map[char]

    try:
        compiled = re.compile(pattern, flags)
    except re.error as e:
        return [{"string": s, "error": f"Invalid regex: {e}"} for s in test_strings]

    results: list[dict[str, Any]] = []
    for test_str in test_strings:
        match = compiled.search(test_str)
        result: dict[str, Any] = {
            "string": test_str,
            "matches": match is not None,
        }
        if match:
            result["matched_text"] = match.group()
            if match.groups():
                result["groups"] = list(match.groups())
            # Find all matches
            all_matches = compiled.findall(test_str)
            if len(all_matches) > 1:
                result["all_matches"] = all_matches
        results.append(result)

    return results


def validate_pattern(pattern: str, flags_str: str) -> bool:
    """Check if a regex pattern is valid."""
    flag_map: dict[str, int] = {
        "i": re.IGNORECASE,
        "m": re.MULTILINE,
        "s": re.DOTALL,
    }
    flags = 0
    for char in flags_str:
        if char in flag_map:
            flags |= flag_map[char]

    try:
        re.compile(pattern, flags)
        return True
    except re.error:
        return False


# ---------------------------------------------------------------------------
# Display helpers
# ---------------------------------------------------------------------------


def display_results(regex_info: dict[str, Any], test_results: list[dict[str, Any]] | None = None) -> None:
    """Display the generated regex and test results."""
    print()
    print("═" * 60)
    log("🎯", "Generated Regex")
    print("═" * 60)
    print()

    pattern = regex_info["pattern"]
    flags = regex_info.get("flags", "")

    print(f"  Pattern:  {pattern}")
    if flags:
        print(f"  Flags:    {flags}")
    print()

    # Python usage
    print("  Python usage:")
    if flags:
        flag_names = {"i": "re.IGNORECASE", "m": "re.MULTILINE", "s": "re.DOTALL"}
        py_flags = " | ".join(flag_names.get(f, f"re.{f}") for f in flags if f in flag_names)
        print(f'    re.search(r"{pattern}", text, {py_flags})')
    else:
        print(f'    re.search(r"{pattern}", text)')
    print()

    # JavaScript usage
    print("  JavaScript usage:")
    print(f"    /{pattern}/{flags}")
    print()

    # Explanation
    print("─" * 60)
    log("📖", "Explanation")
    print("─" * 60)
    print()
    for line in regex_info["explanation"].splitlines():
        print(f"  {line}")
    print()

    # Built-in examples
    examples_match = regex_info.get("examples_match", [])
    examples_no_match = regex_info.get("examples_no_match", [])

    if examples_match or examples_no_match:
        print("─" * 60)
        log("📋", "Examples from AI")
        print("─" * 60)
        print()
        if examples_match:
            print("  Should match:")
            for ex in examples_match:
                print(f"    ✅ {ex}")
        if examples_no_match:
            print("  Should NOT match:")
            for ex in examples_no_match:
                print(f"    ❌ {ex}")
        print()

    # User-provided test results
    if test_results:
        print("─" * 60)
        log("🧪", "Test Results")
        print("─" * 60)
        print()
        for result in test_results:
            if "error" in result:
                print(f"  ⚠️  \"{result['string']}\" -- {result['error']}")
            elif result["matches"]:
                matched = result["matched_text"]
                groups = result.get("groups")
                all_matches = result.get("all_matches")
                line = f"  ✅ \"{result['string']}\" -- matched: \"{matched}\""
                if groups:
                    line += f"  groups: {groups}"
                if all_matches and len(all_matches) > 1:
                    line += f"  ({len(all_matches)} total matches)"
                print(line)
            else:
                print(f"  ❌ \"{result['string']}\" -- no match")
        print()

    print("═" * 60)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the regex generator agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    # Parse CLI arguments
    description: str | None = None
    test_strings: list[str] = []

    i = 0
    while i < len(args):
        if args[i] == "--test" and i + 1 < len(args):
            test_strings = [s.strip() for s in args[i + 1].split(",") if s.strip()]
            i += 2
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py [DESCRIPTION] [OPTIONS]")
            print()
            print("Generates a tested regex from a natural language description.")
            print()
            print("Arguments:")
            print("  DESCRIPTION    What the regex should match (in quotes)")
            print()
            print("Options:")
            print("  --test STRINGS   Comma-separated test strings to validate against")
            print("  --help           Show this help message")
            print()
            print("Examples:")
            print('  python main.py "Match email addresses"')
            print('  python main.py "Match US phone numbers" --test "+1-555-123-4567,not-a-phone,555.123.4567"')
            print('  python main.py "Match URLs starting with https"')
            print()
            print("If no description is given, you'll be prompted interactively.")
            sys.exit(0)
        elif not description and not args[i].startswith("--"):
            description = args[i]
            i += 1
        else:
            print(f"❌ Unknown argument: {args[i]}")
            print("   Use --help for usage information.")
            sys.exit(1)
            i += 1
        i += 1

    log("🚀", "Starting regex generator agent...")
    log("🤖", f"Model: {model}")
    print()

    # Get description interactively if not provided
    if not description:
        try:
            description = input("📝 What should the regex match? ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\n❌ Cancelled.")
            sys.exit(0)

        if not description:
            print("❌ No description provided.")
            sys.exit(1)

        # Ask for test strings interactively too
        if not test_strings:
            try:
                test_input = input("🧪 Test strings (comma-separated, or press Enter to skip): ").strip()
                if test_input:
                    test_strings = [s.strip() for s in test_input.split(",") if s.strip()]
            except (KeyboardInterrupt, EOFError):
                print("\n❌ Cancelled.")
                sys.exit(0)

    log("🔍", f"Generating regex for: {description}")
    print()

    # Generate the regex
    try:
        regex_info = await generate_regex(description, model)
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error generating regex: {e}")
        print("   Check your OPENAI_API_KEY and network connection.")
        sys.exit(1)

    # Validate the generated pattern
    pattern = regex_info["pattern"]
    flags = regex_info.get("flags", "")

    if not validate_pattern(pattern, flags):
        log("⚠️", "The generated pattern is invalid in Python. Displaying anyway.")

    # Run tests against user-provided strings
    test_results: list[dict[str, Any]] | None = None
    if test_strings:
        log("🧪", f"Testing against {len(test_strings)} string(s)...")
        test_results = test_regex(pattern, flags, test_strings)

    # Display results
    display_results(regex_info, test_results)

    log("✅", "Done!")


if __name__ == "__main__":
    asyncio.run(main())
