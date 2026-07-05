"""
Realtime Voice Agent -- Text-based simulation of OpenAI's Realtime API.

Demonstrates the WebSocket protocol for real-time conversations:
- Connect to the Realtime API via WebSocket
- Send text messages (simulating voice input)
- Receive streamed text responses (simulating voice output)
- Function calling during the conversation (weather tool demo)

For actual voice I/O, you would add pyaudio for microphone capture
and audio playback. The WebSocket protocol remains the same -- you'd
send input_audio_buffer.append events with base64-encoded PCM audio
instead of conversation.item.create with text content.
"""

import os
import sys
import json
import signal
import asyncio
from typing import Any

from dotenv import load_dotenv

load_dotenv()


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"
RECONNECT_DELAY_SECONDS = 2
MAX_RECONNECT_ATTEMPTS = 5


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

WEATHER_TOOL = {
    "type": "function",
    "name": "get_weather",
    "description": (
        "Get the current weather for a given location. "
        "Returns temperature, conditions, and humidity."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "location": {
                "type": "string",
                "description": "City name, e.g. 'San Francisco' or 'London, UK'",
            }
        },
        "required": ["location"],
    },
}


def get_weather(location: str) -> dict[str, Any]:
    """Simulated weather lookup. In production, call a real weather API."""
    # Deterministic fake data keyed on the first character for variety.
    seed = ord(location[0].lower()) if location else 0
    temp_c = 15 + (seed % 20)
    conditions = ["sunny", "partly cloudy", "overcast", "light rain", "windy"]
    humidity = 40 + (seed % 40)

    return {
        "location": location,
        "temperature_c": temp_c,
        "temperature_f": round(temp_c * 9 / 5 + 32),
        "conditions": conditions[seed % len(conditions)],
        "humidity_percent": humidity,
    }


TOOL_HANDLERS: dict[str, Any] = {
    "get_weather": get_weather,
}


# ---------------------------------------------------------------------------
# Session configuration
# ---------------------------------------------------------------------------

SESSION_CONFIG = {
    "type": "session.update",
    "session": {
        "modalities": ["text"],
        "instructions": (
            "You are a helpful voice assistant. Keep responses concise and "
            "conversational -- around 1-3 sentences unless the user asks for "
            "detail. You have access to a weather tool you can call when "
            "users ask about weather."
        ),
        "tools": [WEATHER_TOOL],
        "tool_choice": "auto",
    },
}


# ---------------------------------------------------------------------------
# Realtime client
# ---------------------------------------------------------------------------

class RealtimeClient:
    """Manages a WebSocket connection to the OpenAI Realtime API."""

    def __init__(self, api_key: str) -> None:
        self.api_key = api_key
        self.ws: Any = None
        self._running = False
        self._response_text = ""
        self._pending_function_calls: dict[str, dict[str, Any]] = {}
        self._response_done_event: asyncio.Event = asyncio.Event()

    # -- Connection lifecycle ------------------------------------------------

    async def connect(self) -> None:
        """Open a WebSocket connection with exponential backoff on failure."""
        try:
            import websockets
        except ImportError:
            log("", "Missing dependency: pip install websockets")
            sys.exit(1)

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "OpenAI-Beta": "realtime=v1",
        }

        attempt = 0
        while attempt < MAX_RECONNECT_ATTEMPTS:
            try:
                self.ws = await websockets.connect(
                    REALTIME_URL,
                    additional_headers=headers,
                    ping_interval=20,
                    ping_timeout=10,
                    close_timeout=5,
                )
                log("", "Connected to OpenAI Realtime API")
                return
            except Exception as exc:
                attempt += 1
                if attempt >= MAX_RECONNECT_ATTEMPTS:
                    log("", f"Failed to connect after {MAX_RECONNECT_ATTEMPTS} attempts: {exc}")
                    raise
                delay = RECONNECT_DELAY_SECONDS * (2 ** (attempt - 1))
                log("", f"Connection attempt {attempt} failed, retrying in {delay}s...")
                await asyncio.sleep(delay)

    async def disconnect(self) -> None:
        """Gracefully close the WebSocket connection."""
        self._running = False
        if self.ws:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None
            log("", "Disconnected from Realtime API")

    # -- Sending messages ----------------------------------------------------

    async def _send(self, event: dict[str, Any]) -> None:
        """Send a JSON event over the WebSocket."""
        if not self.ws:
            raise RuntimeError("Not connected")
        await self.ws.send(json.dumps(event))

    async def configure_session(self) -> None:
        """Send session configuration (tools, instructions, modalities)."""
        await self._send(SESSION_CONFIG)
        log("", "Session configured (text mode, weather tool enabled)")

    async def send_user_message(self, text: str) -> str:
        """Send a user text message and wait for the complete response."""
        self._response_text = ""
        self._response_done_event.clear()

        # 1. Create the conversation item
        await self._send({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": text,
                    }
                ],
            },
        })

        # 2. Ask the model to respond
        await self._send({
            "type": "response.create",
            "response": {
                "modalities": ["text"],
            },
        })

        # 3. Wait for response.done
        await self._response_done_event.wait()
        return self._response_text

    async def _handle_function_call(self, call_id: str, name: str, arguments: str) -> None:
        """Execute a function call and send the result back to the API."""
        handler = TOOL_HANDLERS.get(name)
        if not handler:
            result = {"error": f"Unknown tool: {name}"}
        else:
            try:
                args = json.loads(arguments)
                result = handler(**args)
                log("", f"Called {name}({arguments})")
            except Exception as exc:
                result = {"error": str(exc)}
                log("", f"Tool {name} failed: {exc}")

        # Send function call output
        await self._send({
            "type": "conversation.item.create",
            "item": {
                "type": "function_call_output",
                "call_id": call_id,
                "output": json.dumps(result),
            },
        })

        # Trigger a new response based on the tool output
        await self._send({
            "type": "response.create",
            "response": {
                "modalities": ["text"],
            },
        })

    # -- Receiving messages --------------------------------------------------

    async def _handle_event(self, event: dict[str, Any]) -> None:
        """Process a single server event."""
        event_type = event.get("type", "")

        if event_type == "session.created":
            log("", "Session created")

        elif event_type == "session.updated":
            log("", "Session updated")

        elif event_type == "response.text.delta":
            delta = event.get("delta", "")
            self._response_text += delta
            # Stream output character by character
            print(delta, end="", flush=True)

        elif event_type == "response.text.done":
            print()  # Newline after streamed text

        elif event_type == "response.function_call_arguments.delta":
            # Accumulate function call arguments
            call_id = event.get("call_id", "")
            if call_id not in self._pending_function_calls:
                self._pending_function_calls[call_id] = {
                    "name": event.get("name", ""),
                    "arguments": "",
                }
            self._pending_function_calls[call_id]["arguments"] += event.get("delta", "")

        elif event_type == "response.function_call_arguments.done":
            call_id = event.get("call_id", "")
            call_info = self._pending_function_calls.pop(call_id, None)
            if call_info:
                name = call_info.get("name", event.get("name", ""))
                arguments = event.get("arguments", call_info.get("arguments", "{}"))
                await self._handle_function_call(call_id, name, arguments)

        elif event_type == "response.done":
            self._response_done_event.set()

        elif event_type == "error":
            error = event.get("error", {})
            log("", f"API error: {error.get('message', 'Unknown error')}")
            self._response_done_event.set()

        elif event_type == "response.output_item.added":
            item = event.get("item", {})
            if item.get("type") == "function_call":
                call_id = item.get("call_id", "")
                self._pending_function_calls[call_id] = {
                    "name": item.get("name", ""),
                    "arguments": "",
                }

    async def listen(self) -> None:
        """Listen for events from the WebSocket in the background."""
        self._running = True
        try:
            async for raw_message in self.ws:
                if not self._running:
                    break
                try:
                    event = json.loads(raw_message)
                    await self._handle_event(event)
                except json.JSONDecodeError:
                    log("", "Received non-JSON message from API")
        except Exception as exc:
            if self._running:
                log("", f"WebSocket listener error: {exc}")
                self._response_done_event.set()


# ---------------------------------------------------------------------------
# Interactive conversation loop
# ---------------------------------------------------------------------------

async def run_conversation(client: RealtimeClient) -> None:
    """Run an interactive text conversation through the Realtime API."""
    log("", "Ready! Type your messages below. Type 'quit' or press Ctrl+C to exit.")
    log("", "Try asking about the weather to see function calling in action.\n")

    while True:
        try:
            # Read user input from stdin (works in async context)
            user_input = await asyncio.get_event_loop().run_in_executor(
                None, lambda: input("You: ")
            )
        except (EOFError, KeyboardInterrupt):
            print()
            break

        text = user_input.strip()
        if not text:
            continue
        if text.lower() in ("quit", "exit", "q"):
            break

        print("Assistant: ", end="", flush=True)
        try:
            await client.send_user_message(text)
        except Exception as exc:
            print()
            log("", f"Error sending message: {exc}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> None:
    """Entry point: connect, configure, and start the conversation loop."""
    validate_env()

    log("", "Starting Realtime Voice Agent (text mode)")
    log("", "This demonstrates the OpenAI Realtime API WebSocket protocol.")
    log("", "For actual voice I/O, add pyaudio for microphone and speaker support.\n")

    api_key = os.getenv("OPENAI_API_KEY", "")
    client = RealtimeClient(api_key)

    # Handle graceful shutdown
    shutdown_event = asyncio.Event()

    def handle_signal() -> None:
        log("\n", "Shutting down...")
        shutdown_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, handle_signal)
        except NotImplementedError:
            # Windows does not support add_signal_handler
            pass

    try:
        await client.connect()
        await client.configure_session()

        # Start the listener in the background
        listener_task = asyncio.create_task(client.listen())

        # Run the interactive conversation
        await run_conversation(client)

        # Clean shutdown
        await client.disconnect()
        listener_task.cancel()
        try:
            await listener_task
        except asyncio.CancelledError:
            pass

    except Exception as exc:
        log("", f"Fatal error: {exc}")
        await client.disconnect()
        sys.exit(1)

    log("", "Session ended. Goodbye!")


if __name__ == "__main__":
    asyncio.run(main())
