/**
 * API Test Generator -- Reads an OpenAPI/Swagger spec and generates a comprehensive
 * test suite with happy path, edge case, and auth tests.
 *
 * Uses Anthropic Claude to analyze endpoints and generate test code.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import yaml from "js-yaml";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_ENDPOINTS_PER_BATCH = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EndpointParam {
  name: string;
  in: string;
  required: boolean;
  schema: Record<string, unknown>;
  description?: string;
}

interface EndpointInfo {
  path: string;
  method: string;
  summary: string;
  description: string;
  operation_id: string;
  parameters: EndpointParam[];
  request_body: { required: boolean; schema: Record<string, unknown> } | null;
  responses: Record<string, { description: string; schema: Record<string, unknown> }>;
  security: unknown[];
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY"];
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
// OpenAPI spec parsing
// ---------------------------------------------------------------------------

function loadSpec(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, "utf-8");

  // Try JSON first
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    // Not JSON, try YAML
  }

  try {
    const parsed = yaml.load(content);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    console.error("YAML file did not parse to an object.");
    process.exit(1);
  } catch (e) {
    console.error(`Failed to parse spec file: ${e}`);
    process.exit(1);
  }
}

function extractEndpoints(spec: Record<string, unknown>): EndpointInfo[] {
  const endpoints: EndpointInfo[] = [];
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;

  const httpMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

  // Extract security schemes info
  const globalSecurity = (spec.security ?? []) as unknown[];

  for (const [path, methods] of Object.entries(paths)) {
    if (typeof methods !== "object" || methods === null) continue;

    for (const [method, details] of Object.entries(methods)) {
      if (!httpMethods.has(method.toLowerCase())) continue;
      if (typeof details !== "object" || details === null) continue;

      const det = details as Record<string, unknown>;

      const endpoint: EndpointInfo = {
        path,
        method: method.toUpperCase(),
        summary: (det.summary as string) ?? "",
        description: (det.description as string) ?? "",
        operation_id: (det.operationId as string) ?? "",
        parameters: [],
        request_body: null,
        responses: {},
        security: (det.security as unknown[]) ?? globalSecurity,
      };

      // Extract parameters
      const params = [
        ...((methods.parameters ?? []) as Record<string, unknown>[]),
        ...((det.parameters ?? []) as Record<string, unknown>[]),
      ];

      for (const param of params) {
        if (typeof param !== "object" || param === null) continue;
        const p = param as Record<string, unknown>;

        if ("$ref" in p) {
          const refName = (p.$ref as string).split("/").pop() ?? "unknown";
          endpoint.parameters.push({
            name: refName,
            in: "unknown",
            required: false,
            schema: { type: "string" },
          });
        } else {
          endpoint.parameters.push({
            name: (p.name as string) ?? "",
            in: (p.in as string) ?? "query",
            required: (p.required as boolean) ?? false,
            schema: (p.schema as Record<string, unknown>) ?? { type: "string" },
            description: (p.description as string) ?? "",
          });
        }
      }

      // Extract request body
      const requestBody = det.requestBody as Record<string, unknown> | undefined;
      if (requestBody && typeof requestBody === "object") {
        const rbContent = (requestBody.content ?? {}) as Record<string, Record<string, unknown>>;
        const jsonContent = rbContent["application/json"];
        if (jsonContent) {
          endpoint.request_body = {
            required: (requestBody.required as boolean) ?? false,
            schema: (jsonContent.schema as Record<string, unknown>) ?? {},
          };
        }
      }

      // Extract responses
      const responses = (det.responses ?? {}) as Record<string, Record<string, unknown>>;
      for (const [statusCode, response] of Object.entries(responses)) {
        if (typeof response !== "object" || response === null) continue;
        const respContent = (response.content ?? {}) as Record<string, Record<string, unknown>>;
        const jsonResp = respContent["application/json"];
        endpoint.responses[statusCode] = {
          description: (response.description as string) ?? "",
          schema: (jsonResp?.schema as Record<string, unknown>) ?? {},
        };
      }

      endpoints.push(endpoint);
    }
  }

  return endpoints;
}

function getSpecSummary(spec: Record<string, unknown>, endpoints: EndpointInfo[]): string {
  const info = (spec.info ?? {}) as Record<string, unknown>;
  const title = (info.title as string) ?? "Unknown API";
  const version = (info.version as string) ?? "unknown";
  const description = (info.description as string) ?? "";

  const lines: string[] = [
    `API: ${title} v${version}`,
    description ? `Description: ${description}` : "",
    `Total endpoints: ${endpoints.length}`,
    "",
    "Endpoints:",
  ];

  for (const ep of endpoints) {
    const paramsStr = ep.parameters
      .map((p) => `${p.name}(${p.required ? "required" : "optional"})`)
      .join(", ");
    const bodyStr = ep.request_body ? " [has request body]" : "";

    lines.push(`  ${ep.method} ${ep.path} -- ${ep.summary || "No summary"}`);
    if (paramsStr) lines.push(`    Params: ${paramsStr}`);
    if (bodyStr) lines.push(`    ${bodyStr.trim()}`);
  }

  return lines.filter((l) => l !== null).join("\n");
}

// ---------------------------------------------------------------------------
// Test generation via Claude
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert test engineer. You generate comprehensive API test suites
from OpenAPI specifications. Your tests are production-grade and cover:

1. **Happy path tests**: Valid requests that should succeed (2xx responses)
2. **Edge case tests**: Missing required fields, invalid types, boundary values, empty strings
3. **Auth tests**: Requests without credentials, with invalid credentials

Rules:
- Generate complete, runnable test files with no placeholders or TODOs
- Use the exact endpoints, methods, and parameter schemas from the spec
- Include descriptive test names that explain what is being tested
- Add comments explaining the test strategy for each endpoint
- Use environment variables for base URL and API keys (never hardcode)
- Group tests by endpoint
- Include setup/teardown where appropriate
- Handle both JSON request bodies and query parameters correctly
- Test response status codes AND response body structure where schemas are provided
- For edge cases, test each required field being missing individually`;

async function generateTestsForBatch(
  client: Anthropic,
  model: string,
  language: string,
  endpoints: EndpointInfo[],
  specSummary: string,
  batchIndex: number,
): Promise<string> {
  const endpointsJson = JSON.stringify(endpoints, null, 2);

  let frameworkInstructions: string;
  if (language === "python") {
    frameworkInstructions = `Generate Python tests using pytest and httpx.

Structure:
- Use pytest fixtures for base_url and auth headers
- Use httpx.AsyncClient for requests
- Use @pytest.mark.asyncio for async tests
- Group tests in classes by endpoint (e.g., class TestGetUsers, class TestCreateUser)
- Use os.environ.get("BASE_URL", "http://localhost:3000") for the base URL
- Use os.environ.get("API_KEY", "test-key") for auth tokens

Required imports: pytest, httpx, os, json`;
  } else {
    frameworkInstructions = `Generate TypeScript tests using vitest and fetch.

Structure:
- Use describe blocks grouped by endpoint
- Use native fetch for HTTP requests
- Use process.env.BASE_URL || "http://localhost:3000" for the base URL
- Use process.env.API_KEY || "test-key" for auth tokens
- Use expect() assertions from vitest

Required imports: { describe, it, expect } from 'vitest'`;
  }

  const prompt = `Generate a test suite for the following API endpoints.

## API Overview
${specSummary}

## Endpoints to Test (batch ${batchIndex + 1})
${endpointsJson}

## Instructions
${frameworkInstructions}

Generate the complete test file now. Include all happy path, edge case, and auth tests.`;

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });

  let text = "";
  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }

  return extractCodeBlock(text, language);
}

function extractCodeBlock(text: string, language: string): string {
  const langTag = language === "python" ? "python" : "typescript";
  const markers = [`\`\`\`${langTag}`, "```"];

  for (const marker of markers) {
    if (text.includes(marker)) {
      const parts = text.split(marker);
      if (parts.length >= 2) {
        let codePart = parts[1];
        if (codePart.includes("```")) {
          codePart = codePart.split("```")[0];
        }
        return codePart.trim();
      }
    }
  }

  return text.trim();
}

// ---------------------------------------------------------------------------
// Output handling
// ---------------------------------------------------------------------------

function getOutputFilename(language: string, batchIndex: number, totalBatches: number): string {
  if (totalBatches === 1) {
    return language === "python" ? "test_api.py" : "test_api.test.ts";
  }
  return language === "python"
    ? `test_api_part${batchIndex + 1}.py`
    : `test_api_part${batchIndex + 1}.test.ts`;
}

function saveTests(code: string, outputDir: string, filename: string): string {
  mkdirSync(outputDir, { recursive: true });
  const filepath = join(outputDir, filename);
  writeFileSync(filepath, code, "utf-8");
  return filepath;
}

// ---------------------------------------------------------------------------
// Main agent logic
// ---------------------------------------------------------------------------

async function runGenerator(
  specPath: string,
  language: string,
  outputDir: string | null,
  model: string,
): Promise<void> {
  const client = new Anthropic();

  // Step 1: Load and parse spec
  log("📄", `Loading spec: ${specPath}`);
  const spec = loadSpec(specPath);
  const endpoints = extractEndpoints(spec);

  if (endpoints.length === 0) {
    console.error("No endpoints found in the spec. Check that the file is a valid OpenAPI/Swagger spec.");
    process.exit(1);
  }

  log("🔍", `Found ${endpoints.length} endpoints`);
  const specSummary = getSpecSummary(spec, endpoints);
  console.log();
  console.log(specSummary);
  console.log();

  // Step 2: Batch endpoints
  const batches: EndpointInfo[][] = [];
  for (let i = 0; i < endpoints.length; i += MAX_ENDPOINTS_PER_BATCH) {
    batches.push(endpoints.slice(i, i + MAX_ENDPOINTS_PER_BATCH));
  }

  log("🧪", `Generating ${language} tests in ${batches.length} batch(es)...`);
  console.log();

  // Step 3: Generate tests for each batch
  const allResults: Array<{ filename: string; code: string }> = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const endpointNames = batch.map((ep) => `${ep.method} ${ep.path}`);
    const displayNames = endpointNames.slice(0, 5).join(", ");
    const extra = endpointNames.length > 5 ? ` (+${endpointNames.length - 5} more)` : "";
    log("🤖", `Batch ${batchIndex + 1}/${batches.length}: ${displayNames}${extra}`);

    try {
      const code = await generateTestsForBatch(
        client, model, language, batch, specSummary, batchIndex,
      );
      const filename = getOutputFilename(language, batchIndex, batches.length);
      allResults.push({ filename, code });
      log("✅", `Generated: ${filename} (${code.length} chars)`);
    } catch (e) {
      const errorStr = String(e).toLowerCase();
      if (errorStr.includes("rate") || errorStr.includes("overloaded")) {
        log("⏳", `Rate limited on batch ${batchIndex + 1}, retrying in 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const code = await generateTestsForBatch(
            client, model, language, batch, specSummary, batchIndex,
          );
          const filename = getOutputFilename(language, batchIndex, batches.length);
          allResults.push({ filename, code });
          log("✅", `Generated on retry: ${filename}`);
        } catch (retryErr) {
          log("❌", `Failed batch ${batchIndex + 1}: ${retryErr}`);
        }
      } else {
        log("❌", `Failed batch ${batchIndex + 1}: ${e}`);
      }
    }
  }

  // Step 4: Output results
  if (allResults.length === 0) {
    console.error("\nNo tests were generated. Check your API key and try again.");
    process.exit(1);
  }

  console.log();
  if (outputDir) {
    log("💾", `Saving tests to: ${outputDir}`);
    for (const { filename, code } of allResults) {
      const filepath = saveTests(code, outputDir, filename);
      log("📁", `  Saved: ${filepath}`);
    }
  } else {
    for (const { filename, code } of allResults) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`File: ${filename}`);
      console.log("=".repeat(60));
      console.log(code);
      console.log();
    }
  }

  // Summary
  const totalTests = allResults.reduce((sum, { code }) => {
    return sum + (language === "python"
      ? (code.match(/def test_/g) ?? []).length
      : (code.match(/it\(/g) ?? []).length);
  }, 0);

  console.log();
  log("📊", "Summary:");
  log("  ", `Endpoints processed: ${endpoints.length}`);
  log("  ", `Test files generated: ${allResults.length}`);
  log("  ", `Approximate test count: ${totalTests}`);
  log("  ", `Language: ${language}`);
  if (outputDir) {
    log("  ", `Output directory: ${resolve(outputDir)}`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npx tsx index.ts --file <spec-file> [options]");
    console.log();
    console.log("Options:");
    console.log("  --file <path>        Path to OpenAPI/Swagger spec (JSON or YAML)");
    console.log("  --language <lang>    python or typescript (default: python)");
    console.log("  --output <dir>       Directory to save test files (prints to stdout if not set)");
    console.log();
    console.log("Examples:");
    console.log("  npx tsx index.ts --file openapi.json");
    console.log("  npx tsx index.ts --file swagger.yaml --language typescript");
    console.log("  npx tsx index.ts --file api-spec.json --output tests/");
    process.exit(0);
  }

  let specFile: string | null = null;
  let language = "python";
  let outputDir: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && i + 1 < args.length) {
      specFile = args[++i];
    } else if (args[i] === "--language" && i + 1 < args.length) {
      language = args[++i];
    } else if (args[i] === "--output" && i + 1 < args.length) {
      outputDir = args[++i];
    }
  }

  if (!specFile) {
    console.error("Please provide a spec file with --file <path>");
    process.exit(1);
  }

  if (!["python", "typescript"].includes(language)) {
    console.error("Language must be 'python' or 'typescript'");
    process.exit(1);
  }

  const model = process.env.MODEL || DEFAULT_MODEL;

  log("🚀", "Starting API Test Generator...");
  log("🤖", `Model: ${model}`);
  log("📄", `Spec: ${specFile}`);
  log("🔧", `Language: ${language}`);
  if (outputDir) log("💾", `Output: ${outputDir}`);
  console.log();

  try {
    await runGenerator(specFile, language, outputDir, model);
  } catch (e) {
    if (e instanceof Error && e.message.includes("interrupt")) {
      console.log("\nCancelled.");
      process.exit(0);
    }
    console.error(`\nError: ${e}`);
    process.exit(1);
  }

  log("✅", "Done!");
}

main().catch(console.error);
