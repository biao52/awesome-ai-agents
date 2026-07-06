"""
Incident Responder Agent -- Takes alert descriptions and context, then produces
a structured incident response plan with triage, actions, and communication templates.

Uses OpenAI GPT-4o for analysis and response generation.
"""

import os
import sys
import asyncio
from typing import Any

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o"
MAX_RETRIES = 3

SEVERITY_LEVELS = ["critical", "high", "medium", "low"]

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
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a senior Site Reliability Engineer and Incident Commander with 15+ years of experience managing production incidents at large-scale distributed systems. You have handled thousands of incidents across cloud infrastructure, databases, networking, and application layers.

Given an alert description and optional context, produce a comprehensive incident response plan. Be specific and actionable -- generic advice is not helpful during an incident.

Your response must follow this exact format:

## Triage Assessment
[2-3 sentences: what is likely happening, how confident you are, and what the blast radius is]

## Severity Classification
**Recommended Severity:** [SEV-1 / SEV-2 / SEV-3 / SEV-4]
**Justification:** [Why this severity level]
**User Impact:** [Estimated scope of user impact]

## Immediate Actions (first 15 minutes)
[Numbered list of concrete steps to take RIGHT NOW, in priority order]
1. **[ACTION]:** Specific command, check, or action with details
2. ...

## Investigation Steps
[Ordered steps to identify root cause]
1. **Check [SYSTEM]:** What to look for and what it means
   - Command/query: `specific command to run`
   - Expected vs. concerning output
2. ...

## Likely Root Causes
[Ranked by probability]
1. **[CAUSE]** (probability: High/Medium/Low)
   - Why: Reasoning based on the alert
   - Verify: How to confirm or rule out
   - Fix: Steps to resolve if confirmed
2. ...

## Mitigation Options
[If root cause is not yet confirmed, what can we do to reduce impact?]
1. **[OPTION]:** Description, trade-offs, and rollback plan
2. ...

## Communication Template

### Internal (Slack/Teams)
```
[Ready-to-paste incident notification for engineering channel]
```

### Status Page (if customer-facing)
```
[Ready-to-paste status page update]
```

### Escalation (if needed)
```
[Ready-to-paste escalation message with context for on-call]
```

## Escalation Criteria
[When to escalate to the next level]
- Escalate to SEV-[N-1] if: [condition]
- Page [TEAM] if: [condition]
- Engage vendor support if: [condition]

## Post-Incident
[What to do after the incident is resolved]
1. Verify: How to confirm the fix is working
2. Monitor: What metrics to watch for the next 24 hours
3. Follow-up: Action items for the post-mortem

Rules:
- Be specific to the alert described. Do not give generic incident response advice.
- Include actual commands, queries, and URLs where possible.
- Consider cascading failures and downstream effects.
- Always include a rollback option if a change was recently deployed.
- Time is critical during incidents -- prioritize speed over perfection.
- If the alert description is vague, state your assumptions explicitly."""


# ---------------------------------------------------------------------------
# Incident response agent
# ---------------------------------------------------------------------------


async def generate_response_plan(
    alert: str,
    severity: str | None = None,
    service: str | None = None,
    runbook: str | None = None,
    model: str = DEFAULT_MODEL,
) -> str:
    """Generate an incident response plan from an alert description."""
    client = AsyncOpenAI()

    # Build the user message with all available context
    parts: list[str] = [f"**Alert:** {alert}"]

    if severity:
        parts.append(f"**Reported Severity:** {severity}")
    if service:
        parts.append(f"**Affected Service:** {service}")
    if runbook:
        parts.append(f"**Runbook URL:** {runbook}")

    parts.append("\nProduce a complete incident response plan now.")
    user_message = "\n".join(parts)

    for attempt in range(MAX_RETRIES):
        try:
            response = await client.chat.completions.create(
                model=model,
                max_tokens=4096,
                temperature=0.3,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
            )

            content = response.choices[0].message.content
            return content or "Error: Empty response from model."

        except Exception as e:
            error_str = str(e).lower()
            if "rate" in error_str or "overloaded" in error_str:
                wait = 2 ** (attempt + 1)
                log("⏳", f"API rate limit, retrying in {wait}s...")
                await asyncio.sleep(wait)
                continue
            raise

    return "Error: Failed to generate response plan after multiple retries."


# ---------------------------------------------------------------------------
# Interactive mode
# ---------------------------------------------------------------------------


async def interactive_mode(model: str) -> None:
    """Run in interactive mode, prompting for alert details."""
    print()
    print("📋 Incident Responder -- Interactive Mode")
    print("=" * 50)
    print()

    alert = input("🚨 Describe the alert or incident:\n> ").strip()
    if not alert:
        print("❌ Alert description is required.")
        sys.exit(1)

    print()
    severity = input("⚡ Severity (critical/high/medium/low) [press Enter to auto-detect]: ").strip().lower()
    if severity and severity not in SEVERITY_LEVELS:
        print(f"⚠️  Unknown severity '{severity}', will auto-detect.")
        severity = ""

    service = input("🔧 Affected service [press Enter to skip]: ").strip()
    runbook = input("📖 Runbook URL [press Enter to skip]: ").strip()

    print()
    log("🧠", "Generating incident response plan...")
    print()

    plan = await generate_response_plan(
        alert=alert,
        severity=severity or None,
        service=service or None,
        runbook=runbook or None,
        model=model,
    )

    print("=" * 60)
    print("🚨 Incident Response Plan")
    print("=" * 60)
    print()
    print(plan)
    print()
    print("=" * 60)
    log("✅", "Response plan complete!")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    if "--help" in args or "-h" in args:
        print("Usage: python main.py \"Alert description\" [options]")
        print("       python main.py  (interactive mode)")
        print()
        print("Options:")
        print("  --severity LEVEL   Severity level: critical, high, medium, low")
        print("  --service NAME     Name of the affected service")
        print("  --runbook URL      URL to the relevant runbook")
        print()
        print("Examples:")
        print('  python main.py "High CPU on api-prod-01, 98% for 15 min" --severity high')
        print('  python main.py "Database connection pool exhausted" --service "User DB"')
        print()
        print("Environment variables:")
        print("  OPENAI_API_KEY  Your OpenAI API key (required)")
        print("  MODEL           Override the model (default: gpt-4o)")
        sys.exit(0)

    # Parse args
    alert_parts: list[str] = []
    severity: str | None = None
    service: str | None = None
    runbook: str | None = None

    i = 0
    while i < len(args):
        if args[i] == "--severity" and i + 1 < len(args):
            severity = args[i + 1].lower()
            if severity not in SEVERITY_LEVELS:
                print(f"⚠️  Unknown severity '{severity}', will auto-detect.")
                severity = None
            i += 2
        elif args[i] == "--service" and i + 1 < len(args):
            service = args[i + 1]
            i += 2
        elif args[i] == "--runbook" and i + 1 < len(args):
            runbook = args[i + 1]
            i += 2
        else:
            alert_parts.append(args[i])
            i += 1

    alert = " ".join(alert_parts).strip()

    # If no alert provided, enter interactive mode
    if not alert:
        await interactive_mode(model)
        return

    log("🚀", "Starting incident responder...")
    log("🤖", f"Model: {model}")
    log("🚨", f"Alert: {alert}")
    if severity:
        log("⚡", f"Severity: {severity}")
    if service:
        log("🔧", f"Service: {service}")
    if runbook:
        log("📖", f"Runbook: {runbook}")
    print()

    log("🧠", "Generating incident response plan...")
    print()

    plan = await generate_response_plan(
        alert=alert,
        severity=severity,
        service=service,
        runbook=runbook,
        model=model,
    )

    print("=" * 60)
    print("🚨 Incident Response Plan")
    print("=" * 60)
    print()
    print(plan)
    print()
    print("=" * 60)
    log("✅", "Response plan complete!")


if __name__ == "__main__":
    asyncio.run(main())
