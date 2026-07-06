/**
 * JSON Transformer Agent -- Transforms JSON data based on natural language
 * instructions using OpenAI.
 *
 * Takes input JSON (from file, stdin, or CLI arg) and a transformation
 * description, then uses an LLM to produce the transformed output.
 */

import "dotenv/config";
import OpenAI from "openai";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_RETRIES = 3;
const MAX_INPUT_SIZE = 200_000;

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
// Input handling -- file or stdin
// ---------------------------------------------------------------------------

function readJsonFromFile(filePath: string): string {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EACCES") {
      console.error(`❌ Permission denied: ${filePath}`);
    } else {
      console.error(`❌ Could not read file: ${err.message}`);
    }
    process.exit(1);
  }

  if (content.length > MAX_INPUT_SIZE) {
    log(
      "⚠️",
      `Input is very large (${content.length.toLocaleString()} chars). Truncating to ${MAX_INPUT_SIZE.toLocaleString()} chars.`
    );
    content = content.slice(0, MAX_INPUT_SIZE);
  }

  return content;
}

async function readJsonFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    console.error("❌ No input JSON provided.");
    console.error(
      "   Use --input FILE, pipe via stdin, or see --help for usage."
    );
    process.exit(1);
  }

  const chunks: string[] = [];
  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolve) => {
    process.stdin.on("data", (chunk) => {
      chunks.push(String(chunk));
    });
    process.stdin.on("end", () => {
      let content = chunks.join("");

      if (!content.trim()) {
        console.error(
          "❌ Empty input. Provide JSON via --input FILE or stdin pipe."
        );
        process.exit(1);
      }

      if (content.length > MAX_INPUT_SIZE) {
        log(
          "⚠️",
          `Input is very large (${content.length.toLocaleString()} chars). Truncating to ${MAX_INPUT_SIZE.toLocaleString()} chars.`
        );
        content = content.slice(0, MAX_INPUT_SIZE);
      }

      resolve(content);
    });
  });
}

function validateJson(raw: string, label: string = "input"): void {
  try {
    JSON.parse(raw);
  } catch (e) {
    console.error(`❌ Invalid JSON in ${label}: ${(e as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// JSON transformation via OpenAI
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a JSON transformation expert. You take input JSON and transform it according to the user's natural language instructions.

Rules:
- Output ONLY valid JSON. No markdown fencing, no explanations, no text before or after.
- Preserve data types unless the transformation explicitly requires changing them.
- If the input is a JSON array, output a JSON array. If it's an object, output an object (unless the transformation changes the structure).
- Handle edge cases gracefully: empty arrays, null values, missing fields.
- If a transformation is ambiguous, choose the most common/sensible interpretation.
- Pretty-print the output JSON with 2-space indentation.
- Never fabricate data. Only transform what's provided in the input.
- If the transformation cannot be applied (e.g., the field doesn't exist), return the input unchanged and add a top-level "_warning" field explaining why.`;

async function transformJson(
  inputJson: string,
  instructions: string,
  model: string
): Promise<string> {
  const client = new OpenAI();

  const userMessage = `Transform the following JSON according to these instructions:

**Instructions:** ${instructions}

**Input JSON:**
\`\`\`json
${inputJson}
\`\`\``;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 16_384,
      });

      let result = response.choices[0].message.content || "";

      // Strip markdown fencing if the model adds it despite instructions
      result = result.trim();
      if (result.startsWith("```json")) {
        result = result.slice(7);
      }
      if (result.startsWith("```")) {
        result = result.slice(3);
      }
      if (result.endsWith("```")) {
        result = result.slice(0, -3);
      }
      result = result.trim();

      return result;
    } catch (e) {
      const errorStr = String(e);
      const isTransient =
        errorStr.toLowerCase().includes("rate") ||
        errorStr.toLowerCase().includes("overloaded") ||
        errorStr.includes("429") ||
        errorStr.includes("500");

      if (attempt < MAX_RETRIES && isTransient) {
        const waitTime = Math.pow(2, attempt);
        log(
          "⏳",
          `API error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${waitTime}s...`
        );
        await new Promise((r) => setTimeout(r, waitTime * 1000));
      } else {
        throw e;
      }
    }
  }

  throw new Error("Unreachable: max retries exceeded");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let inputPath: string | null = null;
  let outputPath: string | null = null;
  let instructions: string | null = null;

  // Parse CLI arguments
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--input" || args[i] === "-i") && i + 1 < args.length) {
      inputPath = args[i + 1];
      i++;
    } else if (
      (args[i] === "--output" || args[i] === "-o") &&
      i + 1 < args.length
    ) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [OPTIONS] INSTRUCTIONS");
      console.log();
      console.log("Arguments:");
      console.log(
        "  INSTRUCTIONS    Natural language description of the transformation"
      );
      console.log();
      console.log("Options:");
      console.log("  --input, -i PATH    Path to the input JSON file");
      console.log("  --output, -o PATH   Path to save the transformed JSON");
      console.log();
      console.log("Examples:");
      console.log(
        '  npx tsx index.ts --input data.json "Flatten nested objects"'
      );
      console.log(
        '  cat data.json | npx tsx index.ts "Add an id field to each object"'
      );
      console.log(
        '  npx tsx index.ts --input data.json --output result.json "Rename firstName to first_name"'
      );
      process.exit(0);
    } else if (!args[i].startsWith("-")) {
      instructions = args[i];
    } else {
      console.error(`❌ Unknown argument: ${args[i]}`);
      console.error("   Use --help for usage information.");
      process.exit(1);
    }
  }

  if (!instructions) {
    console.error("❌ No transformation instructions provided.");
    console.error(
      '   Usage: npx tsx index.ts --input data.json "Your transformation instructions"'
    );
    process.exit(1);
  }

  log("🚀", "Starting JSON transformer agent...");
  log("🤖", `Model: ${model}`);
  console.log();

  // Get input JSON
  let inputJson: string;
  if (inputPath) {
    log("📄", `Reading: ${inputPath}`);
    inputJson = readJsonFromFile(inputPath);
  } else {
    log("📄", "Reading JSON from stdin...");
    inputJson = await readJsonFromStdin();
  }

  // Validate input is valid JSON
  validateJson(inputJson, "input");

  // Show input stats
  try {
    const parsed = JSON.parse(inputJson);
    if (Array.isArray(parsed)) {
      log("📊", `Input: JSON array with ${parsed.length} items`);
    } else if (typeof parsed === "object" && parsed !== null) {
      log("📊", `Input: JSON object with ${Object.keys(parsed).length} keys`);
    } else {
      log("📊", `Input: JSON ${typeof parsed}`);
    }
  } catch {
    // Already validated above
  }

  log("🔄", `Transformation: ${instructions}`);
  console.log();
  log("⚡", "Transforming...");

  let result: string;
  try {
    result = await transformJson(inputJson, instructions, model);
  } catch (e) {
    console.error(`\n❌ Error during transformation: ${e}`);
    console.error("   Check your OPENAI_API_KEY and network connection.");
    process.exit(1);
  }

  // Validate and re-format output
  try {
    const parsedResult = JSON.parse(result);
    result = JSON.stringify(parsedResult, null, 2);
  } catch {
    log("⚠️", "Warning: Output is not valid JSON. Showing raw output.");
  }

  console.log();

  if (outputPath) {
    try {
      writeFileSync(outputPath, result + "\n", "utf-8");
      log("✅", `Transformed JSON saved to: ${outputPath}`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.error(`❌ Could not write file: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log(result);
  }

  console.log();
  log("✅", "Done!");
}

main().catch(console.error);
