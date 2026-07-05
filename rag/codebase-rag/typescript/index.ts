/**
 * Codebase RAG -- Index a local codebase and ask questions about it.
 *
 * Uses OpenAI embeddings + ChromaDB for retrieval, Anthropic Claude for answering.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ChromaClient, Collection } from "chromadb";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".rb",
  ".php", ".c", ".cpp", ".h", ".css", ".html", ".md", ".yaml", ".yml",
  ".json", ".toml", ".sh", ".sql",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".next", ".nuxt", "dist", "build",
  ".venv", "venv", "env", ".env", ".tox", ".mypy_cache", ".pytest_cache",
  "coverage", ".turbo", ".cache", "target", "out", ".idea", ".vscode",
]);

const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock",
  "poetry.lock", "Pipfile.lock", "composer.lock", "Gemfile.lock",
]);

const MAX_FILE_SIZE_BYTES = 100_000;
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const CHAT_MODEL = process.env.MODEL ?? "claude-sonnet-4-20250514";
const EMBEDDING_BATCH_SIZE = 64;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CodeChunk {
  text: string;
  file: string;
  language: string;
  startLine: number;
  endLine: number;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const startTime = Date.now();

function log(msg: string): void {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[${elapsed.padStart(6)}s] ${msg}`);
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): { claude: Anthropic; oai: OpenAI } {
  const missing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  if (missing.length > 0) {
    console.error(`Error: Missing required environment variables: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }

  return {
    claude: new Anthropic(),
    oai: new OpenAI(),
  };
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".py": "python", ".js": "javascript", ".ts": "typescript",
  ".tsx": "typescriptreact", ".jsx": "javascriptreact", ".go": "go",
  ".rs": "rust", ".java": "java", ".rb": "ruby", ".php": "php",
  ".c": "c", ".cpp": "cpp", ".h": "c-header", ".css": "css",
  ".html": "html", ".md": "markdown", ".yaml": "yaml", ".yml": "yaml",
  ".json": "json", ".toml": "toml", ".sh": "shell", ".sql": "sql",
};

function detectLanguage(filepath: string): string {
  const ext = path.extname(filepath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? "text";
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function discoverFiles(repoPath: string): string[] {
  const repo = path.resolve(repoPath);
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
    console.error(`Error: '${repoPath}' is not a directory.`);
    process.exit(1);
  }

  const files: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (SKIP_FILES.has(entry.name)) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE_BYTES || stat.size === 0) continue;
      } catch {
        continue;
      }

      files.push(fullPath);
    }
  }

  walk(repo);
  return files.sort();
}

// ---------------------------------------------------------------------------
// Code-aware chunking
// ---------------------------------------------------------------------------

const BOUNDARY_PATTERNS: RegExp[] = [
  // Python
  /^(?:async\s+)?(?:def|class)\s+\w+/gm,
  // JS/TS
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+\w+|^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/gm,
  // Go
  /^func\s+/gm,
  // Rust
  /^(?:pub\s+)?(?:fn|impl|struct|enum)\s+\w+/gm,
  // Java/C/C++
  /^(?:public|private|protected|static|abstract|final|virtual)?\s*(?:class|struct|interface|enum)\s+\w+/gm,
  // Ruby
  /^(?:def|class|module)\s+\w+/gm,
  // PHP
  /^(?:public|private|protected|static)?\s*(?:function|class)\s+\w+/gm,
];

function findBoundaries(content: string): number[] {
  const positions = new Set<number>();
  for (const pattern of BOUNDARY_PATTERNS) {
    // Reset lastIndex for each use since patterns are global
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      positions.add(match.index);
    }
  }
  return [...positions].sort((a, b) => a - b);
}

function offsetToLine(content: string, offset: number): number {
  let count = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") count++;
  }
  return count;
}

function fixedSizeChunk(
  content: string,
  filepath: string,
  language: string,
  baseLine: number,
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  let pos = 0;

  while (pos < content.length) {
    const end = Math.min(pos + CHUNK_SIZE, content.length);
    const text = content.slice(pos, end).trim();

    if (text.length > 0) {
      const startLine = baseLine + content.slice(0, pos).split("\n").length - 1;
      const endLine = startLine + text.split("\n").length - 1;

      chunks.push({ text, file: filepath, language, startLine, endLine });
    }

    pos += CHUNK_SIZE - CHUNK_OVERLAP;
    if (end >= content.length) break;
  }

  return chunks;
}

function chunkCode(content: string, filepath: string): CodeChunk[] {
  const language = detectLanguage(filepath);
  const totalLines = content.split("\n").length;

  if (content.length <= CHUNK_SIZE) {
    return [{
      text: content,
      file: filepath,
      language,
      startLine: 1,
      endLine: totalLines,
    }];
  }

  const boundaries = findBoundaries(content);

  if (boundaries.length >= 2) {
    const chunks: CodeChunk[] = [];
    const points = [...boundaries];
    if (points[0] !== 0) points.unshift(0);
    points.push(content.length);

    for (let i = 0; i < points.length - 1; i++) {
      const startOff = points[i];
      const endOff = points[i + 1];
      const text = content.slice(startOff, endOff).trim();
      if (!text) continue;

      const startLine = offsetToLine(content, startOff);
      const endLine = offsetToLine(content, endOff - 1);

      if (text.length > CHUNK_SIZE * 2) {
        chunks.push(...fixedSizeChunk(text, filepath, language, startLine));
      } else {
        chunks.push({ text, file: filepath, language, startLine, endLine });
      }
    }
    return chunks;
  }

  return fixedSizeChunk(content, filepath, language, 1);
}

// ---------------------------------------------------------------------------
// Indexing pipeline
// ---------------------------------------------------------------------------

function readAndChunk(files: string[]): CodeChunk[] {
  const allChunks: CodeChunk[] = [];
  let skipped = 0;

  for (const filepath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filepath, "utf-8");
    } catch {
      skipped++;
      continue;
    }

    if (!content.trim()) continue;
    allChunks.push(...chunkCode(content, filepath));
  }

  if (skipped > 0) {
    log(`Skipped ${skipped} unreadable files`);
  }

  return allChunks;
}

async function embedChunks(
  oai: OpenAI,
  chunks: CodeChunk[],
): Promise<number[][]> {
  const embeddings: number[][] = [];
  const texts = chunks.map((c) => c.text);
  const totalBatches = Math.ceil(texts.length / EMBEDDING_BATCH_SIZE);

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;
    log(`Embedding batch ${batchNum}/${totalBatches} (${batch.length} chunks)`);

    try {
      const response = await oai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch,
      });
      for (const item of response.data) {
        embeddings.push(item.embedding);
      }
    } catch (e) {
      console.error(`Error: OpenAI embedding API failed: ${e}`);
      process.exit(1);
    }
  }

  return embeddings;
}

async function buildIndex(
  oai: OpenAI,
  repoPath: string,
): Promise<{ collection: Collection; chunkCount: number; fileCount: number }> {
  log(`Scanning ${repoPath} for source files...`);
  const files = discoverFiles(repoPath);
  if (files.length === 0) {
    console.error("Error: No indexable source files found in the repository.");
    process.exit(1);
  }
  log(`Found ${files.length} files`);

  log("Chunking files...");
  const chunks = readAndChunk(files);
  if (chunks.length === 0) {
    console.error("Error: No chunks produced from the source files.");
    process.exit(1);
  }
  log(`Produced ${chunks.length} chunks`);

  log("Generating embeddings...");
  const embeddings = await embedChunks(oai, chunks);

  log("Storing in ChromaDB...");
  const client = new ChromaClient();
  const collection = await client.getOrCreateCollection({
    name: "codebase",
    metadata: { "hnsw:space": "cosine" },
  });

  const ids = chunks.map((_, i) => `chunk-${i}`);
  const documents = chunks.map((c) => c.text);
  const metadatas = chunks.map((c) => ({
    file: c.file,
    language: c.language,
    start_line: c.startLine,
    end_line: c.endLine,
  }));

  // Insert in batches
  const batchSize = 500;
  for (let i = 0; i < ids.length; i += batchSize) {
    await collection.add({
      ids: ids.slice(i, i + batchSize),
      documents: documents.slice(i, i + batchSize),
      embeddings: embeddings.slice(i, i + batchSize),
      metadatas: metadatas.slice(i, i + batchSize),
    });
  }

  log(`Index built: ${chunks.length} chunks from ${files.length} files`);
  return { collection, chunkCount: chunks.length, fileCount: files.length };
}

// ---------------------------------------------------------------------------
// Query pipeline
// ---------------------------------------------------------------------------

async function retrieve(
  oai: OpenAI,
  collection: Collection,
  query: string,
  topK = 10,
): Promise<CodeChunk[]> {
  let queryEmbedding: number[];
  try {
    const response = await oai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: [query],
    });
    queryEmbedding = response.data[0].embedding;
  } catch (e) {
    log(`Embedding error: ${e}`);
    return [];
  }

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: topK,
  });

  const chunks: CodeChunk[] = [];
  if (results.documents?.[0] && results.metadatas?.[0]) {
    for (let i = 0; i < results.documents[0].length; i++) {
      const doc = results.documents[0][i];
      const meta = results.metadatas[0][i];
      if (doc && meta) {
        chunks.push({
          text: doc,
          file: meta.file as string,
          language: meta.language as string,
          startLine: meta.start_line as number,
          endLine: meta.end_line as number,
        });
      }
    }
  }

  return chunks;
}

function buildContext(chunks: CodeChunk[]): string {
  return chunks
    .map((chunk, i) => {
      const header = `--- Source ${i + 1}: ${chunk.file} (lines ${chunk.startLine}-${chunk.endLine}, ${chunk.language}) ---`;
      return `${header}\n${chunk.text}`;
    })
    .join("\n\n");
}

async function ask(
  claude: Anthropic,
  oai: OpenAI,
  collection: Collection,
  question: string,
  repoPath: string,
): Promise<string> {
  const chunks = await retrieve(oai, collection, question);
  if (chunks.length === 0) {
    return "No relevant code found for that question.";
  }

  const context = buildContext(chunks);

  const systemPrompt =
    `You are a code expert analyzing the repository at ${repoPath}. ` +
    "Answer questions based on the provided source code context. " +
    "Be specific -- reference file paths, function names, and line numbers. " +
    "If the context doesn't contain enough information, say so clearly.";

  try {
    const response = await claude.messages.create({
      model: CHAT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `## Retrieved Code Context\n\n${context}\n\n## Question\n\n${question}`,
        },
      ],
    });

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } catch (e) {
    return `Claude API error: ${e}`;
  }
}

// ---------------------------------------------------------------------------
// Interactive loop
// ---------------------------------------------------------------------------

async function interactiveLoop(
  claude: Anthropic,
  oai: OpenAI,
  collection: Collection,
  repoPath: string,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n" + "=".repeat(60));
  console.log("Codebase RAG -- Ask questions about your code");
  console.log("Type 'quit' or 'exit' to stop, 'help' for tips");
  console.log("=".repeat(60) + "\n");

  const prompt = (): void => {
    rl.question("You: ", async (input) => {
      const question = input.trim();

      if (!question) {
        prompt();
        return;
      }

      if (["quit", "exit", "q"].includes(question.toLowerCase())) {
        console.log("Goodbye!");
        rl.close();
        return;
      }

      if (question.toLowerCase() === "help") {
        console.log(
          "\nTips:\n" +
          "  - Ask about specific functions, classes, or modules\n" +
          "  - Ask 'What does X do?' or 'How does Y work?'\n" +
          "  - Ask 'Where is Z implemented?'\n" +
          "  - Ask about architecture, patterns, or dependencies\n",
        );
        prompt();
        return;
      }

      console.log("\nSearching codebase...\n");
      const answer = await ask(claude, oai, collection, question, repoPath);
      console.log(`Assistant: ${answer}\n`);
      prompt();
    });
  };

  prompt();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const repoFlag = process.argv.indexOf("--repo");
  if (repoFlag === -1 || !process.argv[repoFlag + 1]) {
    console.error("Usage: tsx index.ts --repo /path/to/project");
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[repoFlag + 1]);
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    console.error(`Error: '${repoPath}' is not a valid directory.`);
    process.exit(1);
  }

  const { claude, oai } = validateEnv();
  const { collection } = await buildIndex(oai, repoPath);
  await interactiveLoop(claude, oai, collection, repoPath);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
