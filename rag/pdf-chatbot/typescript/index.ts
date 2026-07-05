/**
 * PDF Chatbot -- Conversational RAG agent for PDF documents.
 *
 * Upload a PDF and ask questions about it. Uses OpenAI embeddings + ChromaDB
 * for retrieval, GPT-4o-mini for generation, and maintains conversation
 * history for follow-up questions.
 *
 * Usage:
 *   npx tsx index.ts --file document.pdf
 */

import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { config } from "dotenv";
import OpenAI from "openai";
import { ChromaClient, Collection, IncludeEnum } from "chromadb";
import pdf from "pdf-parse";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;
const TOP_K = 3;
const TEMPERATURE = 0.3;
const MAX_HISTORY = 10;

const SYSTEM_PROMPT = `You are a helpful assistant that answers questions about a PDF document.
Use ONLY the provided context chunks to answer. If the context does not
contain enough information to answer, say so honestly.

Rules:
- Cite page numbers when referencing information, e.g. (page 3).
- Be concise and accurate.
- If the user asks a follow-up, use conversation history for continuity
  but still ground answers in the provided context.
- Never fabricate information not present in the context.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageText {
  pageNumber: number; // 1-indexed
  text: string;
}

interface Chunk {
  text: string;
  pageNumber: number;
  chunkIndex: number;
}

interface RetrievedChunk {
  text: string;
  pageNumber: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(emoji: string, message: string): void {
  console.log(`  ${emoji}  ${message}`);
}

function validateEnv(): string {
  config();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your-openai-api-key-here") {
    log("!", "OPENAI_API_KEY is not set.");
    log("!", "Copy .env.example to .env and add your key:");
    log("!", "  cp .env.example .env");
    process.exit(1);
  }
  return apiKey;
}

function getModel(envVar: string, defaultValue: string): string {
  return process.env[envVar] ?? defaultValue;
}

// ---------------------------------------------------------------------------
// PDF extraction
// ---------------------------------------------------------------------------

async function extractPdf(filePath: string): Promise<PageText[]> {
  const absPath = resolve(filePath);

  if (!existsSync(absPath)) {
    log("!", `File not found: ${absPath}`);
    process.exit(1);
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(absPath);
  } catch (err) {
    log("!", `Failed to read PDF: ${err}`);
    process.exit(1);
  }

  // pdf-parse provides per-page text via the pagerender option
  const pages: PageText[] = [];

  // Custom page renderer to capture per-page text
  const options = {
    pagerender: (pageData: {
      getTextContent: () => Promise<{
        items: Array<{ str: string; transform: number[] }>;
      }>;
    }) => {
      return pageData.getTextContent().then((textContent) => {
        return textContent.items.map((item) => item.str).join(" ");
      });
    },
  };

  try {
    const data = await pdf(buffer, options);

    // pdf-parse doesn't give clean per-page access, so we use the
    // numpages count and split the full text heuristically. However,
    // the pagerender above gives us page text via data.text with form
    // feed separators.
    const rawPages = data.text.split("\f");

    for (let i = 0; i < rawPages.length; i++) {
      const cleaned = rawPages[i]
        .split("\n")
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0)
        .join("\n");

      if (cleaned) {
        pages.push({ pageNumber: i + 1, text: cleaned });
      }
    }
  } catch (err) {
    log("!", `Failed to parse PDF: ${err}`);
    process.exit(1);
  }

  if (pages.length === 0) {
    log("!", "PDF contains no extractable text.");
    process.exit(1);
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function chunkPages(
  pages: PageText[],
  chunkSize: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP
): Chunk[] {
  const chunks: Chunk[] = [];
  let idx = 0;

  for (const page of pages) {
    const text = page.text;
    let start = 0;

    while (start < text.length) {
      const end = start + chunkSize;
      const chunkText = text.slice(start, end).trim();

      if (chunkText) {
        chunks.push({
          text: chunkText,
          pageNumber: page.pageNumber,
          chunkIndex: idx,
        });
        idx++;
      }

      start += chunkSize - overlap;
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Embedding + vector store
// ---------------------------------------------------------------------------

async function generateEmbeddings(
  client: OpenAI,
  texts: string[],
  model: string
): Promise<number[][]> {
  const batchSize = 512;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await client.embeddings.create({
      input: batch,
      model,
    });

    for (const item of response.data) {
      allEmbeddings.push(item.embedding);
    }
  }

  return allEmbeddings;
}

async function buildVectorStore(
  openaiClient: OpenAI,
  chunks: Chunk[],
  embeddingModel: string
): Promise<Collection> {
  log("\u{1f9e0}", "Generating embeddings...");

  const texts = chunks.map((c) => c.text);
  const embeddings = await generateEmbeddings(openaiClient, texts, embeddingModel);

  const chroma = new ChromaClient();
  // Delete collection if it already exists (fresh start)
  try {
    await chroma.deleteCollection({ name: "pdf_chunks" });
  } catch {
    // Collection doesn't exist yet -- that's fine
  }

  const collection = await chroma.createCollection({
    name: "pdf_chunks",
    metadata: { "hnsw:space": "cosine" },
  });

  const ids = chunks.map((c) => `chunk_${c.chunkIndex}`);
  const metadatas = chunks.map((c) => ({
    page_number: c.pageNumber,
    chunk_index: c.chunkIndex,
  }));

  await collection.add({
    ids,
    embeddings,
    documents: texts,
    metadatas,
  });

  log("\u2705", `Indexed ${chunks.length} chunks into ChromaDB`);
  return collection;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

async function retrieveChunks(
  openaiClient: OpenAI,
  collection: Collection,
  query: string,
  embeddingModel: string,
  topK: number = TOP_K
): Promise<RetrievedChunk[]> {
  const queryEmbedding = await generateEmbeddings(
    openaiClient,
    [query],
    embeddingModel
  );

  const results = await collection.query({
    queryEmbeddings: queryEmbedding,
    nResults: topK,
    include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances],
  });

  const retrieved: RetrievedChunk[] = [];

  if (results.documents?.[0] && results.metadatas?.[0]) {
    for (let i = 0; i < results.documents[0].length; i++) {
      const doc = results.documents[0][i];
      const meta = results.metadatas[0][i];
      if (doc && meta) {
        retrieved.push({
          text: doc,
          pageNumber: meta.page_number as number,
        });
      }
    }
  }

  return retrieved;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

class ConversationHistory {
  private messages: ChatMessage[] = [];

  addUser(content: string): void {
    this.messages.push({ role: "user", content });
    this.trim();
  }

  addAssistant(content: string): void {
    this.messages.push({ role: "assistant", content });
    this.trim();
  }

  private trim(): void {
    const maxMessages = MAX_HISTORY * 2;
    if (this.messages.length > maxMessages) {
      this.messages = this.messages.slice(-maxMessages);
    }
  }

  toOpenAIMessages(): ChatMessage[] {
    return [...this.messages];
  }
}

function formatContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (chunk, i) =>
        `[Chunk ${i + 1} | Page ${chunk.pageNumber}]\n${chunk.text}`
    )
    .join("\n\n---\n\n");
}

async function askQuestion(
  openaiClient: OpenAI,
  collection: Collection,
  question: string,
  history: ConversationHistory,
  model: string,
  embeddingModel: string
): Promise<string> {
  const chunks = await retrieveChunks(
    openaiClient,
    collection,
    question,
    embeddingModel
  );

  if (chunks.length === 0) {
    return "I couldn't find any relevant information in the document.";
  }

  const context = formatContext(chunks);
  const contextMessage = `Context from the PDF:\n\n${context}\n\nQuestion: ${question}`;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.toOpenAIMessages(),
    { role: "user", content: contextMessage },
  ];

  try {
    const response = await openaiClient.chat.completions.create({
      model,
      messages,
      temperature: TEMPERATURE,
    });

    const answer =
      response.choices[0]?.message?.content ?? "No response generated.";

    history.addUser(question);
    history.addAssistant(answer);

    return answer;
  } catch (err) {
    return `Error calling OpenAI: ${err}`;
  }
}

// ---------------------------------------------------------------------------
// Interactive loop
// ---------------------------------------------------------------------------

async function chatLoop(
  openaiClient: OpenAI,
  collection: Collection,
  model: string,
  embeddingModel: string,
  pdfName: string
): Promise<void> {
  const history = new ConversationHistory();

  console.log();
  console.log("=".repeat(60));
  log("\u{1f4ac}", `Chat with: ${pdfName}`);
  log("\u{1f4a1}", 'Type your questions. Enter "quit" or "exit" to stop.');
  console.log("=".repeat(60));
  console.log();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (): Promise<string | null> =>
    new Promise((resolve) => {
      rl.question("You: ", (answer) => {
        resolve(answer);
      });
      rl.once("close", () => resolve(null));
    });

  while (true) {
    const input = await prompt();

    if (input === null) {
      console.log();
      log("\u{1f44b}", "Goodbye!");
      break;
    }

    const question = input.trim();
    if (!question) continue;

    if (["quit", "exit", "q"].includes(question.toLowerCase())) {
      log("\u{1f44b}", "Goodbye!");
      break;
    }

    log("\u{1f50d}", "Searching document...");
    const answer = await askQuestion(
      openaiClient,
      collection,
      question,
      history,
      model,
      embeddingModel
    );
    console.log(`\nAssistant: ${answer}\n`);
  }

  rl.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf("--file");

  if (fileIndex === -1 || fileIndex + 1 >= args.length) {
    console.error("Usage: npx tsx index.ts --file <path-to-pdf>");
    process.exit(1);
  }

  const filePath = args[fileIndex + 1];

  const apiKey = validateEnv();
  const model = getModel("MODEL", DEFAULT_MODEL);
  const embeddingModel = getModel("EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL);

  log("\u{1f680}", "PDF Chatbot starting...");
  log("\u{1f4c4}", `File: ${filePath}`);
  log("\u{1f916}", `Model: ${model}`);
  log("\u{1f9e9}", `Embeddings: ${embeddingModel}`);

  const openaiClient = new OpenAI({ apiKey });

  log("\u{1f4c4}", "Extracting text from PDF...");
  const pages = await extractPdf(filePath);
  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  log("\u2705", `Extracted ${pages.length} pages (${totalChars.toLocaleString()} characters)`);

  const chunks = chunkPages(pages);
  log(
    "\u2705",
    `Created ${chunks.length} chunks (size=${CHUNK_SIZE}, overlap=${CHUNK_OVERLAP})`
  );

  const collection = await buildVectorStore(openaiClient, chunks, embeddingModel);

  const pdfName = basename(filePath);
  await chatLoop(openaiClient, collection, model, embeddingModel, pdfName);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
