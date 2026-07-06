# Email Drafter Agent

> Drafts professional emails from a situation description, with tone control and support for generating multiple draft variations side by side.

## What You'll Learn

- Prompt engineering for tone-controlled writing (formal, casual, friendly, assertive, professional)
- Generating multiple output variations from the same prompt using temperature tuning
- Structured output parsing (subject line + email body extraction)
- Interactive CLI with fallback to argument-based invocation
- Retry with exponential backoff on transient API errors

## Architecture

```
User describes a situation
    |
    v
CLI parses tone, recipient, and draft count
    |
    v
For each draft:
    --> Build prompt (situation + tone + recipient + variation instruction)
    --> Send to Claude (higher temperature for multi-draft)
    --> Parse response into subject + body
    |
    v
Output: Formatted email draft(s) with subject lines
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- Anthropic API key -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env  # Then add your API key
python main.py "I need to follow up with a client who hasn't responded in 2 weeks about our proposal"
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your API key
npx tsx index.ts "I need to follow up with a client who hasn't responded in 2 weeks about our proposal"
```

## How It Works

The agent takes a natural language description of a situation and turns it into a ready-to-send email. Instead of asking you to fill in a template, you describe what you need in plain English and the agent figures out the right structure, greeting, tone, and call to action. This works because Claude is particularly strong at understanding social context and adapting writing style.

Tone control is the core feature. The same situation produces very different emails depending on whether you pick "formal" (conservative, titled, structured) versus "casual" (relaxed, conversational) versus "assertive" (direct, clear deadlines). The system prompt defines each tone precisely so the output is consistent, not random. Temperature is set low (0.4) for single drafts to keep output focused, and higher (0.7) for multi-draft mode so each variation actually differs.

When you request multiple drafts with `--drafts 3`, the agent generates all variations concurrently using `asyncio.gather` in Python and `Promise.all` in TypeScript. Each draft gets an instruction to take a different angle or emphasis, so you get genuinely distinct options rather than near-identical copies. The subject line is parsed separately from the body using a simple `SUBJECT:` prefix format, which is more reliable than asking for JSON when the output is prose.

Recipient context is optional but useful. Telling the agent the recipient is "Professor Smith" versus "your teammate Jake" gives Claude enough context to pick the right greeting, level of formality within the tone, and sign-off. Approximate cost per email draft is ~$0.005-0.01.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `MODEL` | No | Override the model (default: `claude-sonnet-4-20250514`) |

## Key Files

| File | Purpose |
| --- | --- |
| `main.py` / `index.ts` | Entry point, CLI parsing, prompt construction, and output formatting |

## CLI Usage

```bash
# Interactive mode (prompts for situation, tone, recipient, draft count)
python main.py

# Direct mode with defaults (professional tone, single draft)
python main.py "Follow up with a client who hasn't responded in 2 weeks"

# Specify tone
python main.py "Decline a meeting invitation" --tone friendly

# Add recipient context
python main.py "Request a deadline extension for the Q3 report" --tone formal --recipient "Professor Smith"

# Generate 3 variations to compare
python main.py "Apologize for a delayed shipment" --tone professional --drafts 3
```

## Example Output

**Formal tone:**

```
🚀 Starting email drafter agent...
📧 Drafting email...
🎨 Tone: formal
👤 Recipient: John, VP of Engineering
🤖 Model: claude-sonnet-4-20250514

✍️ Generating draft...

============================================================
  Subject: Follow-Up: Partnership Proposal Submitted June 20
------------------------------------------------------------

Dear Mr. John,

I hope this message finds you well. I am writing to follow up on
the partnership proposal we submitted on June 20 for your review.

We understand that evaluating proposals of this scope requires
careful consideration. However, as we approach the two-week mark,
I wanted to confirm receipt and inquire whether any additional
information would be helpful as you assess the proposal.

We remain enthusiastic about the potential collaboration and are
available at your convenience to discuss any questions or
clarifications.

I look forward to hearing from you.

Respectfully,
[Your Name]

============================================================
✅ Done!
```

**Casual tone (same situation):**

```
============================================================
  Subject: Quick check-in on that proposal
------------------------------------------------------------

Hey John,

Just wanted to ping you about the proposal we sent over a
couple weeks ago. No rush at all -- just making sure it
didn't get buried in the inbox.

If you've had a chance to look it over and have any questions,
happy to jump on a quick call. Otherwise, just let me know
when's a good time to circle back.

Cheers,
[Your Name]

============================================================
```

## Extend This Example

- Add a **reply mode** that takes an incoming email and drafts a response in the chosen tone
- Integrate with a mail API (Gmail, Outlook) to send drafts directly after user confirmation
- Add **language support** with a `--language` flag to draft emails in other languages
- Build a **template library** of common email types (meeting request, thank you, introduction) for one-shot generation
- Add **length control** with `--length short/medium/long` to constrain email length

## Related Examples

- [Content Pipeline](../../../multi-agent/content-pipeline) -- Multi-agent writing pipeline with research, drafting, and editing
- [Customer Support Agent](../customer-support-agent) -- Conversational agent with knowledge base and response generation
