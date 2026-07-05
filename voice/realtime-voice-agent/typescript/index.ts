/**
 * Realtime Voice Agent -- Text-based simulation of OpenAI's Realtime API.
 *
 * Demonstrates the WebSocket protocol for real-time conversations:
 * - Connect to the Realtime API via WebSocket
 * - Send text messages (simulating voice input)
 * - Receive streamed text responses (simulating voice output)
 * - Function calling during the conversation (weather tool demo)
 *
 * For actual voice I/O, you would use the Web Audio API in a browser
 * or a Node.js audio library like node-microphone. The WebSocket protocol
 * remains the same -- you'd send input_audio_buffer.append events with
 * base64-encoded PCM audio instead of conversation.item.create with text.
 */

import "dotenv/config";
import WebSocket from "ws";
import * as readline from "readline";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["OPENAI_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface WeatherResult {
  location: string;
  temperature_c: number;
  temperature_f: number;
  conditions: string;
  humidity_percent: number;
}

interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const WEATHER_TOOL: ToolDefinition = {
  type: "function",
  name: "get_weather",
  description:
    "Get the current weather for a given location. Returns temperature, conditions, and humidity.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name, e.g. 'San Francisco' or 'London, UK'",
      },
    },
    required: ["location"],
  },
};

function getWeather(location: string): WeatherResult {
  /** Simulated weather lookup. In production, call a real weather API. */
  const seed = location.length > 0 ? location.charCodeAt(0) : 0;
  const lowSeed = location.toLowerCase().charCodeAt(0) || 0;
  const tempC = 15 + (lowSeed % 20);
  const conditions = [
    "sunny",
    "partly cloudy",
    "overcast",
    "light rain",
    "windy",
  ];
  const humidity = 40 + (seed % 40);

  return {
    location,
    temperature_c: tempC,
    temperature_f: Math.round((tempC * 9) / 5 + 32),
    conditions: conditions[seed % conditions.length],
    humidity_percent: humidity,
  };
}

const TOOL_HANDLERS: Record<
  string,
  (args: Record<string, string>) => unknown
> = {
  get_weather: (args) => getWeather(args.location),
};

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------

interface SessionConfig {
  type: string;
  session: {
    modalities: string[];
    instructions: string;
    tools: ToolDefinition[];
    tool_choice: string;
  };
}

const SESSION_CONFIG: SessionConfig = {
  type: "session.update",
  session: {
    modalities: ["text"],
    instructions:
      "You are a helpful voice assistant. Keep responses concise and " +
      "conversational -- around 1-3 sentences unless the user asks for " +
      "detail. You have access to a weather tool you can call when " +
      "users ask about weather.",
    tools: [WEATHER_TOOL],
    tool_choice: "auto",
  },
};

// ---------------------------------------------------------------------------
// Realtime client
// ---------------------------------------------------------------------------

interface PendingCall {
  name: string;
  arguments: string;
}

interface ServerEvent {
  type: string;
  delta?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { message?: string };
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
  };
  [key: string]: unknown;
}

class RealtimeClient {
  private apiKey: string;
  private ws: WebSocket | null = null;
  private running = false;
  private responseText = "";
  private pendingCalls: Map<string, PendingCall> = new Map();
  private responseDoneResolve: (() => void) | null = null;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  // -- Connection lifecycle ------------------------------------------------

  async connect(): Promise<void> {
    let attempt = 0;

    while (attempt < MAX_RECONNECT_ATTEMPTS) {
      try {
        await this.tryConnect();
        log("\u{1F50C}", "Connected to OpenAI Realtime API");
        return;
      } catch (err) {
        attempt++;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          log(
            "\u274C",
            `Failed to connect after ${MAX_RECONNECT_ATTEMPTS} attempts: ${err}`
          );
          throw err;
        }
        const delay = RECONNECT_DELAY_MS * Math.pow(2, attempt - 1);
        log(
          "\u{1F504}",
          `Connection attempt ${attempt} failed, retrying in ${delay}ms...`
        );
        await sleep(delay);
      }
    }
  }

  private tryConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error("Connection timeout"));
      }, 10_000);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.running = true;
        this.setupListeners();
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private setupListeners(): void {
    if (!this.ws) return;

    this.ws.on("message", (data) => {
      try {
        const event: ServerEvent = JSON.parse(data.toString());
        this.handleEvent(event);
      } catch {
        log("\u26A0\uFE0F", "Received non-JSON message from API");
      }
    });

    this.ws.on("close", () => {
      if (this.running) {
        log("\u26A0\uFE0F", "WebSocket closed unexpectedly");
        this.resolveResponse();
      }
    });

    this.ws.on("error", (err) => {
      if (this.running) {
        log("\u274C", `WebSocket error: ${err.message}`);
        this.resolveResponse();
      }
    });
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      log("\u{1F44B}", "Disconnected from Realtime API");
    }
  }

  // -- Sending messages ----------------------------------------------------

  private send(event: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }
    this.ws.send(JSON.stringify(event));
  }

  configureSession(): void {
    this.send(SESSION_CONFIG as unknown as Record<string, unknown>);
    log("\u2699\uFE0F", "Session configured (text mode, weather tool enabled)");
  }

  async sendUserMessage(text: string): Promise<string> {
    this.responseText = "";

    const responsePromise = new Promise<void>((resolve) => {
      this.responseDoneResolve = resolve;
    });

    // 1. Create the conversation item
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text,
          },
        ],
      },
    });

    // 2. Ask the model to respond
    this.send({
      type: "response.create",
      response: {
        modalities: ["text"],
      },
    });

    // 3. Wait for response.done
    await responsePromise;
    return this.responseText;
  }

  // -- Handling events -----------------------------------------------------

  private handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case "session.created":
        log("\u{1F4E1}", "Session created");
        break;

      case "session.updated":
        log("\u2705", "Session updated");
        break;

      case "response.text.delta":
        if (event.delta) {
          this.responseText += event.delta;
          process.stdout.write(event.delta);
        }
        break;

      case "response.text.done":
        process.stdout.write("\n");
        break;

      case "response.output_item.added":
        if (event.item?.type === "function_call" && event.item.call_id) {
          this.pendingCalls.set(event.item.call_id, {
            name: event.item.name || "",
            arguments: "",
          });
        }
        break;

      case "response.function_call_arguments.delta":
        if (event.call_id) {
          const pending = this.pendingCalls.get(event.call_id);
          if (pending) {
            pending.arguments += event.delta || "";
          }
        }
        break;

      case "response.function_call_arguments.done":
        if (event.call_id) {
          const callInfo = this.pendingCalls.get(event.call_id);
          this.pendingCalls.delete(event.call_id);
          if (callInfo) {
            const name = callInfo.name || event.name || "";
            const args = event.arguments || callInfo.arguments || "{}";
            this.handleFunctionCall(event.call_id, name, args);
          }
        }
        break;

      case "response.done":
        this.resolveResponse();
        break;

      case "error":
        log(
          "\u274C",
          `API error: ${event.error?.message || "Unknown error"}`
        );
        this.resolveResponse();
        break;
    }
  }

  private handleFunctionCall(
    callId: string,
    name: string,
    argsJson: string
  ): void {
    const handler = TOOL_HANDLERS[name];
    let result: unknown;

    if (!handler) {
      result = { error: `Unknown tool: ${name}` };
    } else {
      try {
        const args = JSON.parse(argsJson) as Record<string, string>;
        result = handler(args);
        log("\u{1F527}", `Called ${name}(${argsJson})`);
      } catch (err) {
        result = { error: String(err) };
        log("\u274C", `Tool ${name} failed: ${err}`);
      }
    }

    // Send function call output
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });

    // Trigger a new response based on the tool output
    this.send({
      type: "response.create",
      response: {
        modalities: ["text"],
      },
    });
  }

  private resolveResponse(): void {
    if (this.responseDoneResolve) {
      this.responseDoneResolve();
      this.responseDoneResolve = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Interactive conversation loop
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function prompt(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer);
    });
  });
}

async function runConversation(client: RealtimeClient): Promise<void> {
  log(
    "\u{1F3A4}",
    "Ready! Type your messages below. Type 'quit' or press Ctrl+C to exit."
  );
  log(
    "\u{1F4A1}",
    "Try asking about the weather to see function calling in action.\n"
  );

  const rl = createReadlineInterface();

  try {
    while (true) {
      const userInput = await prompt(rl, "You: ");
      const text = userInput.trim();

      if (!text) continue;
      if (["quit", "exit", "q"].includes(text.toLowerCase())) break;

      process.stdout.write("Assistant: ");
      try {
        await client.sendUserMessage(text);
      } catch (err) {
        process.stdout.write("\n");
        log("\u274C", `Error sending message: ${err}`);
      }
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  log("\u{1F680}", "Starting Realtime Voice Agent (text mode)");
  log(
    "\u{1F4E1}",
    "This demonstrates the OpenAI Realtime API WebSocket protocol."
  );
  log(
    "\u{1F4DD}",
    "For actual voice I/O, add a browser audio interface or node-microphone.\n"
  );

  const apiKey = process.env.OPENAI_API_KEY!;
  const client = new RealtimeClient(apiKey);

  // Handle graceful shutdown
  const shutdown = async (): Promise<void> => {
    log("\n\u{1F44B}", "Shutting down...");
    await client.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await client.connect();
    client.configureSession();
    await runConversation(client);
    await client.disconnect();
  } catch (err) {
    log("\u274C", `Fatal error: ${err}`);
    await client.disconnect();
    process.exit(1);
  }

  log("\u2705", "Session ended. Goodbye!");
}

main().catch(console.error);
