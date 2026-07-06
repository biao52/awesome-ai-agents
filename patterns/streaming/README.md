# Streaming Agent

> An agent that streams both text and tool-call responses in real-time, showing output as it's generated.

## What You'll Learn

- How to handle streaming events from the Anthropic API
- Processing `text_delta` and `input_json_delta` events in a tool-calling agent
- Buffering streamed tool call arguments into complete JSON for execution
- Building a responsive CLI that shows output character by character

## Architecture

```
User Message
    |
    v
Claude API (streaming)
    |
    +--> text_delta events --> print to stdout immediately
    |
    +--> content_block_start (tool_use) --> show tool name
    |
    +--> input_json_delta events --> show args as they stream
    |
    +--> content_block_stop --> parse full JSON, execute tool
    |
    +--> message_delta (stop_reason) --> end turn or continue
         |
         v
    If stop_reason == "tool_use":
         Feed results back, stream again
    Else:
         Turn complete
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- API key for Anthropic -- get one at [console.anthropic.com](https://console.anthropic.com)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env  # Then add your API key
python main.py
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env  # Then add your API key
npx tsx index.ts
```

## How It Works

The agent uses Anthropic's streaming API (`client.messages.stream()`) to receive the response as a sequence of server-sent events. Instead of waiting for the entire response to complete, the agent processes each event as it arrives and writes output immediately.

There are two categories of streaming events that matter. **Text deltas** carry fragments of the model's text response -- each delta might be a single word or a few characters. The agent prints these immediately using `flush=True` (Python) or `process.stdout.write()` (TypeScript), creating the "typing" effect. **Input JSON deltas** carry fragments of tool call arguments as the model generates them. These partial JSON strings are accumulated in a buffer until the `content_block_stop` event fires, at which point the full JSON is parsed and the tool is executed.

The tricky part is handling the multi-turn loop. When the model's stop reason is `tool_use`, the agent executes the requested tools, appends their results to the conversation, and starts a new streaming request. This loop continues until the model produces a final text response with stop reason `end_turn`. Each iteration streams its output in real-time, so the user sees continuous progress even when multiple tool calls are involved.

One important detail: the full content blocks (text + tool_use) must be saved to the messages array exactly as the API expects them. The streaming events are ephemeral -- you need to reconstruct the complete message structure from the accumulated deltas for the conversation history.

## Configuration

| Variable          | Required | Description                                          |
| ----------------- | -------- | ---------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Yes    | Your Anthropic API key                               |
| `MODEL`           | No       | Override the default model (default: claude-sonnet-4-20250514) |

## Key Files

| File                    | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `main.py` / `index.ts`  | Entry point, streaming loop, event handling      |

## Streaming Events Reference

| Event Type             | When It Fires                          | What It Contains            |
| ---------------------- | -------------------------------------- | --------------------------- |
| `content_block_start`  | New text or tool_use block begins      | Block type, tool name/id    |
| `text_delta`           | Text fragment generated                | Partial text string         |
| `input_json_delta`     | Tool argument fragment generated       | Partial JSON string         |
| `content_block_stop`   | Block complete                         | Nothing (signal only)       |
| `message_delta`        | Message metadata update                | Stop reason, usage stats    |

## Buffering Strategies

When streaming tool call arguments, you have two choices:

1. **Accumulate and parse** (used in this example): Buffer all `input_json_delta` fragments into a string, then `JSON.parse()` when the block stops. Simple and reliable.

2. **Incremental parse**: Use a streaming JSON parser to extract fields as they arrive. Useful when tool arguments are large and you want to show progress (e.g., streaming a long code block argument). More complex to implement.

For most agents, option 1 is the right choice. Option 2 only matters when tool arguments are hundreds of tokens long.

## Extend This Example

- Add a progress spinner that shows while waiting for the first token
- Implement incremental JSON parsing for large tool arguments
- Add token usage tracking and display cost per response
- Stream to a web frontend via Server-Sent Events (SSE)
- Add cancellation support (Ctrl+C during streaming aborts the request)

## Related Examples

- [Human-in-the-Loop](../human-in-the-loop) -- add approval gates to streamed tool calls
- [Retry & Fallback](../retry-fallback) -- handle API errors during streaming with model fallback
