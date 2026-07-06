"""
Email Drafter Agent -- Drafts professional emails based on a situation description,
with tone control and support for multiple draft variations.

Uses Anthropic Claude for writing (best-in-class for natural language generation).
"""

import os
import sys
import asyncio
from typing import Any

from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
MAX_RETRIES = 3
VALID_TONES = ["formal", "casual", "friendly", "assertive", "professional"]
DEFAULT_TONE = "professional"
DEFAULT_DRAFTS = 1
MAX_DRAFTS = 5

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["ANTHROPIC_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        print("   Get your Anthropic key at: https://console.anthropic.com/settings/keys")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert email writer who crafts clear, effective emails for professional contexts. You adapt your writing style to match the requested tone while keeping emails concise and actionable.

When drafting an email, you MUST output exactly this format:

SUBJECT: <subject line>

<email body>

Rules:
- Write a clear, specific subject line (not generic like "Follow Up" -- include context)
- Open with an appropriate greeting for the tone
- Get to the point quickly -- no filler sentences
- Include a clear call to action or next step when appropriate
- Close with an appropriate sign-off for the tone
- Keep emails concise: 3-6 short paragraphs maximum
- Use bullet points or numbered lists when presenting multiple items
- Never use placeholder names like [Name] -- if recipient info is provided, use it; otherwise use a natural greeting without a name
- Match the tone exactly:
  - formal: Conservative language, full titles, structured paragraphs
  - professional: Business-appropriate but not stiff, balanced warmth
  - friendly: Warm and personable while still clear and purposeful
  - casual: Relaxed language, conversational, but still coherent
  - assertive: Direct, confident, clear expectations and deadlines"""


# ---------------------------------------------------------------------------
# Email drafting via Anthropic Claude
# ---------------------------------------------------------------------------


async def draft_email(
    situation: str,
    tone: str,
    recipient: str,
    model: str,
    draft_number: int | None = None,
    total_drafts: int = 1,
) -> dict[str, str]:
    """Generate an email draft for the given situation. Returns dict with subject and body."""
    client = AsyncAnthropic()

    # Build the user prompt with all available context
    parts: list[str] = []
    parts.append(f"Situation: {situation}")

    if recipient:
        parts.append(f"Recipient: {recipient}")

    parts.append(f"Tone: {tone}")

    if total_drafts > 1 and draft_number is not None:
        parts.append(
            f"This is draft {draft_number} of {total_drafts}. "
            "Make this variation meaningfully different from other drafts -- "
            "try a different angle, structure, or emphasis while keeping "
            "the same core message and tone."
        )

    user_message = "\n".join(parts)

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=2048,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
                temperature=0.7 if total_drafts > 1 else 0.4,
            )

            # Extract text content from response
            result = ""
            for block in response.content:
                if block.type == "text":
                    result += block.text

            return parse_email_response(result)

        except Exception as e:
            error_str = str(e)
            is_transient = (
                "rate" in error_str.lower()
                or "overloaded" in error_str.lower()
                or "529" in error_str
                or "500" in error_str
            )
            if attempt < MAX_RETRIES and is_transient:
                wait_time = 2 ** attempt
                log("...", f"API error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait_time}s...")
                await asyncio.sleep(wait_time)
            else:
                raise

    raise RuntimeError("Unreachable: max retries exceeded")


def parse_email_response(response: str) -> dict[str, str]:
    """Parse Claude's response into subject and body components."""
    lines = response.strip().split("\n")
    subject = ""
    body_start = 0

    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.upper().startswith("SUBJECT:"):
            subject = stripped[len("SUBJECT:"):].strip()
            body_start = i + 1
            break

    # Skip blank lines between subject and body
    while body_start < len(lines) and not lines[body_start].strip():
        body_start += 1

    body = "\n".join(lines[body_start:]).strip()

    # Fallback if no SUBJECT: prefix was found
    if not subject and body:
        subject = "(No subject generated)"

    return {"subject": subject, "body": body}


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


def format_draft(draft: dict[str, str], draft_number: int | None = None) -> str:
    """Format a single email draft for display."""
    lines: list[str] = []

    if draft_number is not None:
        lines.append("")
        lines.append("=" * 60)
        lines.append(f"  DRAFT {draft_number}")
        lines.append("=" * 60)
    else:
        lines.append("")
        lines.append("=" * 60)

    lines.append(f"  Subject: {draft['subject']}")
    lines.append("-" * 60)
    lines.append("")
    lines.append(draft["body"])
    lines.append("")
    lines.append("=" * 60)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Interactive mode
# ---------------------------------------------------------------------------


async def interactive_mode(model: str) -> None:
    """Run the agent in interactive mode, prompting for input."""
    log("💬", "Interactive mode -- describe the email you need to write.")
    print()

    try:
        situation = input("Situation: ").strip()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")
        sys.exit(0)

    if not situation:
        print("Please describe the situation for the email.")
        sys.exit(1)

    try:
        recipient = input("Recipient (optional, press Enter to skip): ").strip()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")
        sys.exit(0)

    print(f"Available tones: {', '.join(VALID_TONES)}")
    try:
        tone_input = input(f"Tone (default: {DEFAULT_TONE}): ").strip().lower()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")
        sys.exit(0)

    tone = tone_input if tone_input in VALID_TONES else DEFAULT_TONE

    try:
        drafts_input = input("Number of drafts (default: 1): ").strip()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")
        sys.exit(0)

    try:
        num_drafts = int(drafts_input) if drafts_input else DEFAULT_DRAFTS
        num_drafts = max(1, min(num_drafts, MAX_DRAFTS))
    except ValueError:
        num_drafts = DEFAULT_DRAFTS

    await generate_and_display(situation, tone, recipient, num_drafts, model)


# ---------------------------------------------------------------------------
# Core generation logic
# ---------------------------------------------------------------------------


async def generate_and_display(
    situation: str,
    tone: str,
    recipient: str,
    num_drafts: int,
    model: str,
) -> None:
    """Generate email drafts and display them."""
    log("📧", f"Drafting {'email' if num_drafts == 1 else f'{num_drafts} email variations'}...")
    log("🎨", f"Tone: {tone}")
    if recipient:
        log("👤", f"Recipient: {recipient}")
    log("🤖", f"Model: {model}")
    print()

    try:
        if num_drafts == 1:
            log("✍️", "Generating draft...")
            draft = await draft_email(situation, tone, recipient, model)
            print(format_draft(draft))
        else:
            # Generate multiple drafts concurrently
            log("✍️", f"Generating {num_drafts} drafts...")
            tasks = [
                draft_email(
                    situation, tone, recipient, model,
                    draft_number=i, total_drafts=num_drafts,
                )
                for i in range(1, num_drafts + 1)
            ]
            drafts = await asyncio.gather(*tasks)

            for i, draft in enumerate(drafts, 1):
                print(format_draft(draft, draft_number=i))

    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\nError generating email: {e}")
        print("   Check your ANTHROPIC_API_KEY and network connection.")
        sys.exit(1)

    log("✅", "Done!")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the email drafter agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    # No arguments -- enter interactive mode
    if not args:
        await interactive_mode(model)
        return

    # Parse CLI arguments
    situation_parts: list[str] = []
    tone = DEFAULT_TONE
    recipient = ""
    num_drafts = DEFAULT_DRAFTS

    i = 0
    while i < len(args):
        if args[i] == "--tone" and i + 1 < len(args):
            tone = args[i + 1].lower()
            if tone not in VALID_TONES:
                print(f"Invalid tone: {args[i + 1]}")
                print(f"   Valid tones: {', '.join(VALID_TONES)}")
                sys.exit(1)
            i += 2
        elif args[i] == "--recipient" and i + 1 < len(args):
            recipient = args[i + 1]
            i += 2
        elif args[i] == "--drafts" and i + 1 < len(args):
            try:
                num_drafts = int(args[i + 1])
                if num_drafts < 1 or num_drafts > MAX_DRAFTS:
                    print(f"Drafts must be between 1 and {MAX_DRAFTS}.")
                    sys.exit(1)
            except ValueError:
                print(f"Invalid number of drafts: {args[i + 1]}")
                sys.exit(1)
            i += 2
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py [SITUATION] [OPTIONS]")
            print()
            print("Arguments:")
            print("  SITUATION             Describe the email situation (in quotes)")
            print()
            print("Options:")
            print(f"  --tone TONE           Email tone: {', '.join(VALID_TONES)} (default: {DEFAULT_TONE})")
            print("  --recipient INFO      Recipient context (e.g. \"John, VP of Engineering\")")
            print(f"  --drafts N            Generate N draft variations, 1-{MAX_DRAFTS} (default: {DEFAULT_DRAFTS})")
            print("  --help, -h            Show this help message")
            print()
            print("Examples:")
            print("  python main.py \"Follow up with client who hasn't responded in 2 weeks\"")
            print("  python main.py \"Request a deadline extension\" --tone formal --recipient \"Professor Smith\"")
            print("  python main.py \"Decline a meeting invitation politely\" --tone friendly --drafts 3")
            print()
            print("If no arguments are provided, the agent runs in interactive mode.")
            sys.exit(0)
        else:
            situation_parts.append(args[i])
            i += 1

    situation = " ".join(situation_parts).strip()
    if not situation:
        print("Please provide a situation description.")
        print("   Use --help for usage information.")
        sys.exit(1)

    log("🚀", "Starting email drafter agent...")
    await generate_and_display(situation, tone, recipient, num_drafts, model)


if __name__ == "__main__":
    asyncio.run(main())
