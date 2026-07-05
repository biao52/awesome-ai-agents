/**
 * Customer Support Agent -- A RAG-based support agent with a knowledge base,
 * conversation memory, and escalation logic.
 *
 * Uses OpenAI for chat + embeddings and ChromaDB for vector search.
 */

import "dotenv/config";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { ChromaClient, Collection } from "chromadb";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-4o-mini";
const EMBEDDING_MODEL_DEFAULT = "text-embedding-3-small";
const MAX_ITERATIONS = 10;
const KB_CHUNK_SIZE = 800;
const KB_CHUNK_OVERLAP = 100;

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["OPENAI_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    console.error(
      "   Get your OpenAI key at: https://platform.openai.com/api-keys"
    );
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Knowledge base loading and indexing
// ---------------------------------------------------------------------------

interface KBDocument {
  id: string;
  content: string;
  source: string;
}

function chunkText(
  text: string,
  chunkSize: number = KB_CHUNK_SIZE,
  overlap: number = KB_CHUNK_OVERLAP
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = start + chunkSize;
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end - overlap;
  }
  return chunks;
}

function loadKnowledgeBase(kbDir: string): KBDocument[] {
  if (!existsSync(kbDir)) {
    console.error(`❌ Knowledge base directory not found: ${kbDir}`);
    process.exit(1);
  }

  const mdFiles = readdirSync(kbDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (mdFiles.length === 0) {
    console.error(`❌ No markdown files found in ${kbDir}`);
    process.exit(1);
  }

  const documents: KBDocument[] = [];
  for (const file of mdFiles) {
    const content = readFileSync(join(kbDir, file), "utf-8");
    const chunks = chunkText(content);
    chunks.forEach((chunk, i) => {
      documents.push({
        id: `${file}_${i}`,
        content: chunk,
        source: file,
      });
    });
  }

  return documents;
}

async function buildVectorStore(
  documents: KBDocument[]
): Promise<Collection> {
  const openai = new OpenAI();
  const embeddingModel =
    process.env.EMBEDDING_MODEL || EMBEDDING_MODEL_DEFAULT;

  log("🔗", `Generating embeddings for ${documents.length} chunks...`);

  const texts = documents.map((d) => d.content);
  const response = await openai.embeddings.create({
    model: embeddingModel,
    input: texts,
  });
  const embeddings = response.data.map((item) => item.embedding);

  const chromaClient = new ChromaClient();
  // Delete if exists from previous run
  try {
    await chromaClient.deleteCollection({ name: "knowledge_base" });
  } catch {
    // Collection doesn't exist, fine
  }

  const collection = await chromaClient.createCollection({
    name: "knowledge_base",
    metadata: { "hnsw:space": "cosine" },
  });

  await collection.add({
    ids: documents.map((d) => d.id),
    documents: documents.map((d) => d.content),
    metadatas: documents.map((d) => ({ source: d.source })),
    embeddings,
  });

  return collection;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface SearchResult {
  content: string;
  source: string;
}

async function searchKnowledgeBase(
  query: string,
  collection: Collection,
  nResults: number = 3
): Promise<SearchResult[]> {
  const openai = new OpenAI();
  const embeddingModel =
    process.env.EMBEDDING_MODEL || EMBEDDING_MODEL_DEFAULT;

  const response = await openai.embeddings.create({
    model: embeddingModel,
    input: query,
  });
  const queryEmbedding = response.data[0].embedding;

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults,
  });

  const searchResults: SearchResult[] = [];
  if (results.documents?.[0] && results.metadatas?.[0]) {
    for (let i = 0; i < results.documents[0].length; i++) {
      searchResults.push({
        content: results.documents[0][i] ?? "",
        source: (results.metadatas[0][i]?.source as string) || "unknown",
      });
    }
  }

  return searchResults;
}

interface Ticket {
  ticket_id: string;
  category: string;
  summary: string;
  priority: string;
  status: string;
  message: string;
}

function createEscalationTicket(
  category: string,
  summary: string,
  priority: string = "normal"
): Ticket {
  const ticketId =
    "ESC-" +
    Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join("");
  return {
    ticket_id: ticketId,
    category,
    summary,
    priority,
    status: "open",
    message: `Ticket ${ticketId} created. A support specialist will follow up within 24 hours.`,
  };
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description:
        "Search the company knowledge base for information relevant to the customer's question. " +
        "Returns the most relevant articles/sections. Use this to find answers before responding.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The search query based on the customer's question.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_escalation_ticket",
      description:
        "Escalate an issue to a human support specialist. Use this when: " +
        "1) The knowledge base doesn't have the answer, " +
        "2) The customer explicitly asks to speak to a human, " +
        "3) The issue requires account-specific actions you can't perform.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["billing", "technical", "account", "shipping", "other"],
            description: "The category of the issue.",
          },
          summary: {
            type: "string",
            description:
              "Brief summary of the customer's issue for the support specialist.",
          },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "urgent"],
            description:
              "Priority level. Use 'urgent' only for service outages or security issues.",
          },
        },
        required: ["category", "summary"],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a friendly, helpful customer support agent for a SaaS company. You help customers with questions about products, shipping, returns, pricing, technical issues, and account management.

Your process:
1. When a customer asks a question, ALWAYS search the knowledge base first using the search_knowledge_base tool
2. Answer based on the knowledge base content. Cite which article the info came from (e.g., "According to our Returns Policy...")
3. If the knowledge base doesn't have the answer, be honest and offer to escalate

Rules:
- Be warm, professional, and empathetic
- Keep responses concise but complete (2-4 sentences for simple questions, more for complex ones)
- Always cite your sources when using knowledge base content
- Never make up information. If you don't know, say so and offer to escalate
- If the customer seems frustrated, acknowledge their frustration before providing solutions
- If the customer asks to speak to a human, create an escalation ticket immediately
- For account-specific requests (refunds, password resets, plan changes), create an escalation ticket
- Remember the conversation context -- refer back to earlier messages when relevant

Escalation triggers (always create a ticket):
- Customer explicitly asks for a human/manager/supervisor
- Issue requires accessing the customer's specific account data
- Billing disputes or refund requests for amounts over $100
- Security concerns (compromised account, unauthorized access)
- Bug reports with reproduction steps`;

async function runSupportAgent(
  messages: ChatCompletionMessageParam[],
  collection: Collection,
  model: string
): Promise<string> {
  const client = new OpenAI();

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let response;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools,
        temperature: 0.3,
      });
    } catch (e) {
      const errorStr = String(e).toLowerCase();
      if (errorStr.includes("rate") || errorStr.includes("overloaded")) {
        const wait = Math.pow(2, (iteration % 3) + 1);
        log("⏳", `API rate limit, retrying in ${wait}s...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw e;
    }

    const choice = response.choices[0];
    const message = choice.message;
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content || "";
    }

    for (const toolCall of message.tool_calls) {
      const fnName = toolCall.function.name;
      const fnArgs = JSON.parse(toolCall.function.arguments) as Record<
        string,
        unknown
      >;

      let resultStr: string;

      if (fnName === "search_knowledge_base") {
        const query = fnArgs.query as string;
        log("🔍", `Searching KB: ${query}`);
        const results = await searchKnowledgeBase(query, collection);
        resultStr = JSON.stringify(results, null, 2);
        log("   ", `Found ${results.length} relevant sections`);
      } else if (fnName === "create_escalation_ticket") {
        const category = fnArgs.category as string;
        const summary = fnArgs.summary as string;
        const priority = (fnArgs.priority as string) || "normal";
        log("🎫", `Creating escalation ticket (${category}, ${priority})`);
        const ticket = createEscalationTicket(category, summary, priority);
        resultStr = JSON.stringify(ticket, null, 2);
        log("   ", `Ticket created: ${ticket.ticket_id}`);
      } else {
        resultStr = `Unknown tool: ${fnName}`;
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: resultStr,
      });
    }
  }

  return "I'm having trouble processing your request. Let me connect you with a specialist.";
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function readLine(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    process.stdout.write(prompt);
    let input = "";
    process.stdin.setEncoding("utf8");

    const onData = (chunk: string | Buffer) => {
      input += String(chunk);
      if (input.includes("\n")) {
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        resolve(input.trim());
      }
    };

    process.stdin.on("data", onData);
    process.stdin.on("end", () => reject(new Error("stdin closed")));
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: npx tsx index.ts");
    console.log();
    console.log("Starts an interactive customer support chat session.");
    console.log(
      "The agent answers questions using a built-in knowledge base."
    );
    console.log();
    console.log("Type your question and press Enter. Type 'quit' to exit.");
    process.exit(0);
  }

  log("🚀", "Starting customer support agent...");
  log("🤖", `Model: ${model}`);

  const kbDir = join(import.meta.dirname ?? ".", "..", "knowledge_base");
  const documents = loadKnowledgeBase(kbDir);
  log("📚", `Loaded ${documents.length} chunks from knowledge base`);

  const collection = await buildVectorStore(documents);
  log("✅", "Knowledge base indexed and ready!");
  console.log();
  console.log("=".repeat(50));
  console.log("  Welcome to Customer Support!");
  console.log("  Ask me anything about our products and services.");
  console.log("  Type 'quit' to exit.");
  console.log("=".repeat(50));
  console.log();

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  while (true) {
    let userInput: string;
    try {
      userInput = await readLine("You: ");
    } catch {
      console.log("\n👋 Thanks for contacting us. Have a great day!");
      break;
    }

    if (!userInput.trim()) continue;
    if (["quit", "exit", "q", "bye"].includes(userInput.toLowerCase())) {
      console.log("\n👋 Thanks for contacting us. Have a great day!");
      break;
    }

    messages.push({ role: "user", content: userInput });

    try {
      const response = await runSupportAgent(messages, collection, model);
      console.log(`\nAgent: ${response}\n`);
    } catch (e) {
      console.error(`\n❌ Error: ${e}`);
      console.error("   Please try again or type 'quit' to exit.");
      messages.pop(); // Remove failed user message
    }
  }
}

main().catch(console.error);
