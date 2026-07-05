/**
 * Agentic RAG -- Smart retrieval-augmented generation that decides
 * when to retrieve, answer directly, or ask for clarification.
 *
 * Usage:
 *   npx tsx index.ts
 */

import "dotenv/config";
import * as readline from "node:readline";
import { ChromaClient, type Collection } from "chromadb";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL = process.env.MODEL ?? "gpt-4o-mini";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const TEMPERATURE = 0.3;
const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 64;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const TOP_K = 3;

// ---------------------------------------------------------------------------
// Sample knowledge base (inline markdown documents)
// ---------------------------------------------------------------------------

interface KBDocument {
  title: string;
  content: string;
}

const KNOWLEDGE_BASE: KBDocument[] = [
  {
    title: "API Documentation",
    content: `# Reader API Documentation

## Authentication

All API requests require an API key passed via the \`Authorization\` header:

\`\`\`
Authorization: Bearer rdr_your_api_key_here
\`\`\`

API keys can be generated from your dashboard at https://app.reader.dev/settings/api-keys.

## Endpoints

### POST /v1/read

Scrape and convert a web page to clean markdown.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| url | string | yes | The URL to scrape |
| format | string | no | Output format: "markdown" (default), "html", "text" |
| timeout | number | no | Timeout in milliseconds (default: 30000) |
| waitFor | string | no | CSS selector to wait for before scraping |

**Response:**

\`\`\`json
{
  "success": true,
  "data": {
    "content": "# Page Title\\n\\nPage content in markdown...",
    "metadata": {
      "title": "Page Title",
      "url": "https://example.com",
      "statusCode": 200
    }
  }
}
\`\`\`

### GET /v1/health

Returns API health status. No authentication required.

### POST /v1/batch

Submit multiple URLs for batch processing. Returns a job ID for polling.

## Rate Limits

- Free tier: 100 requests/day
- Pro tier: 10,000 requests/day
- Enterprise: Custom limits

Rate limit headers are included in every response:
- \`X-RateLimit-Limit\`
- \`X-RateLimit-Remaining\`
- \`X-RateLimit-Reset\`

## Error Codes

| Code | Meaning |
|------|---------|
| 401 | Invalid or missing API key |
| 429 | Rate limit exceeded |
| 422 | Invalid request parameters |
| 502 | Target site unreachable |
| 504 | Scrape timeout |`,
  },
  {
    title: "Billing FAQ",
    content: `# Billing FAQ

## Plans and Pricing

### What plans are available?

We offer three plans:

1. **Free** -- 100 requests/day, community support, single API key
2. **Pro ($29/month)** -- 10,000 requests/day, priority support, unlimited API keys, webhook notifications
3. **Enterprise (custom)** -- Custom rate limits, SLA, dedicated support, SSO, audit logs

### How do I upgrade my plan?

Go to your dashboard at https://app.reader.dev/settings/billing and click "Upgrade Plan". You can upgrade at any time and will be prorated for the remainder of your billing cycle.

### Can I get a refund?

We offer a 14-day money-back guarantee on Pro plans. Contact support@reader.dev within 14 days of your first payment.

### What payment methods do you accept?

We accept all major credit cards (Visa, Mastercard, Amex) and process payments through Stripe. Enterprise customers can pay via invoice.

## Usage and Overages

### What happens if I exceed my rate limit?

Requests beyond your rate limit will receive a 429 status code. The response includes a \`Retry-After\` header indicating when you can make the next request.

### Can I purchase additional requests?

Pro plan users can purchase add-on packs of 5,000 requests for $10 each. Go to Settings > Billing > Add-ons.

### How is usage calculated?

Each API call to /v1/read counts as one request, regardless of the page size. Batch API calls count each URL separately. Health check endpoints are free.

## Invoices

### Where can I find my invoices?

All invoices are available at https://app.reader.dev/settings/billing/invoices. You can also configure automatic invoice emails.

### Can I change my billing email?

Yes, go to Settings > Billing > Billing Email to update the email address where invoices are sent.`,
  },
  {
    title: "Getting Started Guide",
    content: `# Getting Started with Reader

## Quick Start

### 1. Create an Account

Sign up at https://app.reader.dev/signup. You can use email/password or sign in with GitHub.

### 2. Get Your API Key

After signing in, go to Settings > API Keys and click "Generate New Key". Copy the key -- it will only be shown once.

### 3. Make Your First Request

\`\`\`bash
curl -X POST https://api.reader.dev/v1/read \\
  -H "Authorization: Bearer rdr_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com"}'
\`\`\`

### 4. Install an SDK (Optional)

**JavaScript/TypeScript:**
\`\`\`bash
npm install @reader/sdk
\`\`\`

\`\`\`javascript
import { Reader } from '@reader/sdk';

const reader = new Reader({ apiKey: 'rdr_your_key' });
const result = await reader.read('https://example.com');
console.log(result.content);
\`\`\`

**Python:**
\`\`\`bash
pip install reader-sdk
\`\`\`

\`\`\`python
from reader_sdk import Reader

reader = Reader(api_key="rdr_your_key")
result = reader.read("https://example.com")
print(result.content)
\`\`\`

## Common Use Cases

- **AI training data** -- Convert web pages to clean markdown for LLM fine-tuning
- **Content aggregation** -- Build feeds from multiple sources
- **Research** -- Extract and summarize articles programmatically
- **Monitoring** -- Track changes on specific web pages

## Troubleshooting

### "401 Unauthorized"
Make sure your API key starts with \`rdr_\` and is included in the \`Authorization\` header as a Bearer token.

### "504 Timeout"
Some pages take longer to load. Try increasing the \`timeout\` parameter (max: 60000ms). If the page requires JavaScript, the engine will wait for rendering.

### "502 Bad Gateway"
The target site may be down or blocking requests. Check if you can access the URL in your browser first.

## Need Help?

- Documentation: https://docs.reader.dev
- Email: support@reader.dev
- Discord: https://discord.gg/reader`,
  },
  {
    title: "Webhooks Guide",
    content: `# Webhooks

## Overview

Webhooks let you receive real-time notifications when batch jobs complete or when monitored pages change. Available on Pro and Enterprise plans.

## Setup

### 1. Register a Webhook Endpoint

\`\`\`bash
curl -X POST https://api.reader.dev/v1/webhooks \\
  -H "Authorization: Bearer rdr_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://yourapp.com/webhook",
    "events": ["batch.completed", "monitor.changed"],
    "secret": "your_webhook_secret"
  }'
\`\`\`

### 2. Verify Signatures

Every webhook request includes an \`X-Reader-Signature\` header. Verify it using HMAC-SHA256.

### 3. Event Types

| Event | Description |
|-------|-------------|
| batch.completed | A batch job has finished processing all URLs |
| batch.failed | A batch job encountered a fatal error |
| monitor.changed | A monitored page has changed content |
| monitor.error | A monitored page could not be reached |

### 4. Retry Policy

Failed webhook deliveries are retried up to 5 times with exponential backoff (1min, 5min, 30min, 2hr, 12hr). After all retries are exhausted, the webhook is marked as failed in your dashboard.

## Managing Webhooks

- List: \`GET /v1/webhooks\`
- Delete: \`DELETE /v1/webhooks/{id}\`
- Test: \`POST /v1/webhooks/{id}/test\``,
  },
];

// ---------------------------------------------------------------------------
// Tool definitions for OpenAI function calling
// ---------------------------------------------------------------------------

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description:
        "Search the knowledge base for relevant documentation. " +
        "Use this when the user asks a factual question that requires " +
        "looking up specific information from docs, guides, or FAQs.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to find relevant documents.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "answer_directly",
      description:
        "Answer the user's question directly from the conversation context " +
        "without retrieving any documents. Use this for follow-up questions, " +
        "greetings, simple clarifications about a previous answer, or when " +
        "the answer is already present in the conversation history.",
      parameters: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            description: "The direct answer to the user's question.",
          },
        },
        required: ["answer"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_clarification",
      description:
        "Ask the user a clarifying question when their query is ambiguous, " +
        "too vague, or could refer to multiple topics. Use this to get more " +
        "context before attempting to answer.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The clarifying question to ask the user.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a helpful support agent for the Reader API platform. You have \
access to a knowledge base of documentation, FAQs, and guides.

For each user message, decide which tool to use:

1. **search_knowledge_base** -- When the user asks a factual question that needs information \
from the docs (pricing, endpoints, authentication, setup, etc.)
2. **answer_directly** -- When you can answer from the current conversation context: \
follow-ups ("can you explain that more?"), greetings, or when the information was already \
retrieved in a prior turn.
3. **ask_clarification** -- When the question is ambiguous or too vague to answer well.

You may call multiple tools in a single turn if needed (e.g., search for info and then \
answer). Always prefer the most efficient route -- do not search if you already have the \
answer in context.

After retrieving documents, evaluate their relevance before answering. If the retrieved \
context does not sufficiently answer the question, say so honestly rather than guessing.`;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string, level: string = "INFO"): void {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  process.stderr.write(`[${timestamp}] [${level}] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY environment variable is required.");
    console.error("Copy .env.example to .env and add your key.");
    process.exit(1);
  }
  return apiKey;
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

function chunkText(
  text: string,
  chunkSize: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = start + chunkSize;
    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    start += chunkSize - overlap;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string
): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        log(`${label} error (attempt ${attempt + 1}): ${err}`, "WARN");
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      } else {
        throw err;
      }
    }
  }
  throw new Error("Unreachable");
}

// ---------------------------------------------------------------------------
// Knowledge base indexing
// ---------------------------------------------------------------------------

async function buildVectorStore(
  client: OpenAI
): Promise<Collection> {
  log("Building vector store from knowledge base...");

  const chroma = new ChromaClient();
  // Delete if exists, then create fresh
  try {
    await chroma.deleteCollection({ name: "knowledge_base" });
  } catch {
    // Collection may not exist yet
  }
  const collection = await chroma.createCollection({
    name: "knowledge_base",
    metadata: { "hnsw:space": "cosine" },
  });

  const allChunks: string[] = [];
  const allIds: string[] = [];
  const allMetadata: Array<{ title: string; chunk_index: string }> = [];

  for (const doc of KNOWLEDGE_BASE) {
    const chunks = chunkText(doc.content);
    for (let i = 0; i < chunks.length; i++) {
      allChunks.push(chunks[i]);
      allIds.push(`${doc.title}::chunk_${i}`);
      allMetadata.push({ title: doc.title, chunk_index: String(i) });
    }
  }

  // Embed in batches
  const batchSize = 100;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < allChunks.length; i += batchSize) {
    const batch = allChunks.slice(i, i + batchSize);
    const response = await withRetry(
      () => client.embeddings.create({ model: EMBEDDING_MODEL, input: batch }),
      "Embedding"
    );
    for (const item of response.data) {
      allEmbeddings.push(item.embedding);
    }
  }

  await collection.add({
    ids: allIds,
    documents: allChunks,
    embeddings: allEmbeddings,
    metadatas: allMetadata,
  });

  log(`Indexed ${allChunks.length} chunks from ${KNOWLEDGE_BASE.length} documents`);
  return collection;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeSearch(
  query: string,
  collection: Collection,
  client: OpenAI
): Promise<string> {
  log(`Searching knowledge base: '${query}'`);

  let queryEmbedding: number[];
  try {
    const embeddingResp = await withRetry(
      () => client.embeddings.create({ model: EMBEDDING_MODEL, input: query }),
      "Query embedding"
    );
    queryEmbedding = embeddingResp.data[0].embedding;
  } catch (err) {
    return `Error generating query embedding: ${err}`;
  }

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: TOP_K,
  });

  if (!results.documents?.[0]?.length) {
    return "No relevant documents found.";
  }

  const chunks = results.documents[0];
  const metadatas = results.metadatas?.[0] ?? [];
  const distances = results.distances?.[0] ?? [];

  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const source =
      metadatas[i] && typeof metadatas[i] === "object"
        ? (metadatas[i] as Record<string, string>).title ?? "Unknown"
        : "Unknown";
    const dist = i < distances.length ? ` (distance: ${distances[i].toFixed(3)})` : "";
    parts.push(`--- Source: ${source}${dist} ---\n${chunks[i]}`);
  }

  return parts.join("\n\n");
}

function executeAnswerDirectly(answer: string): string {
  log("Answering directly from context");
  return answer;
}

function executeAskClarification(question: string): string {
  log(`Asking for clarification: '${question}'`);
  return question;
}

// ---------------------------------------------------------------------------
// Self-reflection step
// ---------------------------------------------------------------------------

interface ReflectionResult {
  relevant: boolean;
  reasoning: string;
}

async function reflectOnRetrieval(
  client: OpenAI,
  question: string,
  context: string
): Promise<ReflectionResult> {
  const prompt = `You just retrieved the following context from the knowledge base in \
response to the user's question.

User question: ${question}

Retrieved context:
${context}

Evaluate: Is this context relevant and sufficient to answer the user's question?
Respond with a JSON object:
{"relevant": true/false, "reasoning": "brief explanation"}`;

  try {
    const response = await withRetry(
      () =>
        client.chat.completions.create({
          model: MODEL,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
        }),
      "Reflection"
    );
    const content = response.choices[0].message.content ?? "{}";
    return JSON.parse(content) as ReflectionResult;
  } catch {
    log("Reflection failed after retries", "ERROR");
    return { relevant: true, reasoning: "Reflection unavailable" };
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

async function agentTurn(
  client: OpenAI,
  collection: Collection,
  conversation: ChatCompletionMessageParam[],
  userMessage: string
): Promise<string> {
  conversation.push({ role: "user", content: userMessage });

  let response: OpenAI.Chat.Completions.ChatCompletion;
  try {
    response = await withRetry(
      () =>
        client.chat.completions.create({
          model: MODEL,
          temperature: TEMPERATURE,
          messages: conversation,
          tools: TOOLS,
          tool_choice: "auto",
        }),
      "Chat"
    );
  } catch (err) {
    const errorMsg = `Sorry, I encountered an API error: ${err}`;
    conversation.push({ role: "assistant", content: errorMsg });
    return errorMsg;
  }

  const message = response.choices[0].message;

  // If no tool calls, return the direct text response
  if (!message.tool_calls?.length) {
    const content = message.content ?? "";
    conversation.push({ role: "assistant", content });
    return content;
  }

  // Add assistant message with tool calls
  conversation.push(message);

  // Process tool calls
  for (const toolCall of message.tool_calls) {
    const fnName = toolCall.function.name;
    const fnArgs = JSON.parse(toolCall.function.arguments) as Record<string, string>;

    log(`Tool call: ${fnName}(${JSON.stringify(fnArgs).slice(0, 120)})`);

    let result: string;

    if (fnName === "search_knowledge_base") {
      result = await executeSearch(fnArgs.query, collection, client);

      // Self-reflection: evaluate relevance
      const reflection = await reflectOnRetrieval(client, userMessage, result);
      if (!reflection.relevant) {
        log(`Reflection: context not relevant -- ${reflection.reasoning}`, "WARN");
        result +=
          `\n\n[Note: The retrieved context may not be directly relevant. ` +
          `Reason: ${reflection.reasoning}. ` +
          `Answer honestly if the information is insufficient.]`;
      }
    } else if (fnName === "answer_directly") {
      result = executeAnswerDirectly(fnArgs.answer);
    } else if (fnName === "ask_clarification") {
      result = executeAskClarification(fnArgs.question);
    } else {
      result = `Unknown tool: ${fnName}`;
    }

    conversation.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: result,
    });
  }

  // Get the final response after tool execution
  let finalResponse: OpenAI.Chat.Completions.ChatCompletion;
  try {
    finalResponse = await withRetry(
      () =>
        client.chat.completions.create({
          model: MODEL,
          temperature: TEMPERATURE,
          messages: conversation,
        }),
      "Final response"
    );
  } catch (err) {
    const errorMsg = `Sorry, I encountered an API error: ${err}`;
    conversation.push({ role: "assistant", content: errorMsg });
    return errorMsg;
  }

  const finalContent = finalResponse.choices[0].message.content ?? "";
  conversation.push({ role: "assistant", content: finalContent });
  return finalContent;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = validateEnv();
  const client = new OpenAI({ apiKey });

  const collection = await buildVectorStore(client);

  const conversation: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  console.log("\n=== Agentic RAG Chat ===");
  console.log("Ask questions about Reader API docs, billing, or getting started.");
  console.log("Type 'quit' or 'exit' to end the session.\n");

  while (true) {
    let userInput: string;
    try {
      userInput = (await prompt("You: ")).trim();
    } catch {
      console.log("\nGoodbye!");
      break;
    }

    if (!userInput) continue;
    if (userInput.toLowerCase() === "quit" || userInput.toLowerCase() === "exit") {
      console.log("Goodbye!");
      break;
    }

    const answer = await agentTurn(client, collection, conversation, userInput);
    console.log(`\nAssistant: ${answer}\n`);
  }

  rl.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
