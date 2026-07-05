# Realtime Voice Agent

> A text-based demonstration of OpenAI's Realtime API WebSocket protocol, with streaming responses and function calling.

## What You'll Learn

- How to connect to OpenAI's Realtime API via WebSocket
- Streaming text responses using the Realtime event protocol
- Function calling within a real-time conversation session
- Session configuration for modalities, tools, and instructions
- Graceful connection management with reconnection logic

## Architecture

```
User types a message
    |
    v
RealtimeClient sends over WebSocket:
    1. conversation.item.create  (user message)
    2. response.create           (trigger model response)
    |
    v
OpenAI Realtime API (wss://api.openai.com/v1/realtime)
    |
    v
Server streams back events:
    - response.text.delta        (partial text, printed live)
    - response.function_call_arguments.done  (tool call)
    - response.done              (generation complete)
    |
    v
If tool call detected:
    -> Execute locally (e.g. get_weather)
    -> Send conversation.item.create (function_call_output)
    -> Send response.create (continue generation)
    |
    v
Final text displayed to user
```

## Prerequisites

- Python 3.11+ / Node.js 20+
- OpenAI API key with Realtime API access -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- A paid OpenAI plan (the Realtime API is not available on free tier)

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

This example demonstrates OpenAI's Realtime API using **text mode** to keep the setup simple and portable. The WebSocket protocol is identical whether you're sending text or audio -- the only difference is the event types and payload encoding. This makes it a great way to learn the protocol before adding audio I/O complexity.

The client connects to `wss://api.openai.com/v1/realtime` with an API key in the headers and an `OpenAI-Beta: realtime=v1` flag. Once connected, it sends a `session.update` event to configure the session -- setting the modalities to text-only, registering available tools (a weather lookup function), and providing system instructions.

When you type a message, the client sends two events in sequence: `conversation.item.create` to add your message to the conversation, then `response.create` to trigger the model to respond. The server streams back `response.text.delta` events containing partial text, which the client prints to stdout in real-time. When the model decides to call a tool, the server sends function call events instead. The client executes the tool locally, sends the result back as a `function_call_output`, and triggers another `response.create` to let the model incorporate the tool result.

The reconnection logic uses exponential backoff -- if the initial WebSocket connection fails, the client retries with increasing delays (2s, 4s, 8s, ...) up to 5 attempts. Signal handlers ensure graceful shutdown on Ctrl+C. For production use, you'd also want to handle mid-conversation disconnects and resume the session.

## Key Events Reference

The Realtime API uses a bidirectional event protocol over WebSocket. Here are the events this example uses:

### Client to Server

| Event | Purpose |
| --- | --- |
| `session.update` | Configure modalities, tools, instructions |
| `conversation.item.create` | Add a user message or function call output |
| `response.create` | Trigger the model to generate a response |

### Server to Client

| Event | Purpose |
| --- | --- |
| `session.created` | Confirms the session is ready |
| `session.updated` | Confirms session config was applied |
| `response.text.delta` | Partial text chunk (streamed) |
| `response.text.done` | Text generation for this item is complete |
| `response.function_call_arguments.done` | Tool call is ready to execute |
| `response.done` | Full response generation is complete |
| `error` | Something went wrong |

For the full event reference, see the [Realtime API docs](https://platform.openai.com/docs/api-reference/realtime).

## Adding Actual Voice I/O

This demo uses text input/output to focus on the protocol. To add real voice:

**Python:** Use `pyaudio` to capture microphone input as PCM audio, base64-encode it, and send it via `input_audio_buffer.append` events. For playback, decode the `response.audio.delta` events and play them through the speakers.

**TypeScript (browser):** Use the Web Audio API with `getUserMedia()` for microphone access. The WebSocket connection works the same way from the browser.

**TypeScript (Node.js):** Use `node-microphone` or `sox` for audio capture, similar to the Python approach.

The key change is replacing `conversation.item.create` (text) with `input_audio_buffer.append` (audio) and listening for `response.audio.delta` instead of `response.text.delta`.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Your OpenAI API key (requires paid plan) |

## Key Files

| File | Purpose |
| --- | --- |
| `main.py` / `index.ts` | WebSocket client, event handling, conversation loop |
| -- | Weather tool defined inline as a function calling demo |

## Cost Notes

The Realtime API has separate pricing from the standard Chat API. As of writing:

- **Text tokens:** Same pricing as the underlying model (gpt-4o-realtime-preview)
- **Audio tokens:** Charged per audio token for both input and output
- **Text-only mode** (what this demo uses) avoids audio token costs entirely

A typical text conversation costs roughly the same as using the Chat Completions API with gpt-4o. Check [OpenAI's pricing page](https://openai.com/pricing) for current rates.

## CLI Usage

```bash
# Start an interactive conversation
python main.py

# Example session:
# You: What's the weather like in Tokyo?
# Assistant: Let me check that for you...
# [tool call: get_weather("Tokyo")]
# Assistant: It's currently 28C (82F) and sunny in Tokyo with 55% humidity.

# You: How about London?
# Assistant: London is 19C (66F) and partly cloudy with 72% humidity.

# You: quit
```

## Troubleshooting

**"Connection failed" or 403 errors:** Make sure your OpenAI API key has access to the Realtime API. This requires a paid plan -- the free tier does not include Realtime access.

**"Model not found" errors:** The `gpt-4o-realtime-preview` model may change names as it moves through preview stages. Check the [OpenAI docs](https://platform.openai.com/docs/models) for the current model ID.

**WebSocket closes mid-conversation:** The Realtime API has idle timeouts. If you pause for a long time between messages, the server may close the connection. The client will notify you when this happens.

## Extend This Example

- **Add voice I/O** -- use pyaudio (Python) or Web Audio API (TypeScript) to send/receive actual audio
- **Add more tools** -- register additional function tools like calendar lookup, note-taking, or web search
- **Build a voice assistant** -- combine with a wake word detector (Porcupine, Snowboy) for hands-free activation
- **Add conversation persistence** -- save and reload conversation history across sessions
- **Interruption handling** -- for voice mode, use `input_audio_buffer.commit` and `response.cancel` to handle user interruptions mid-response

## Related Examples

- [Customer Support Agent](../../agents/starter/customer-support-agent) -- A text-based agent with tools and conversation memory
- [Conversation Memory](../../memory/conversation-memory) -- Persistent memory across sessions
