/**
 * Data Analyst Agent -- Takes a CSV file and natural language questions, writes
 * Python analysis code, executes it in a sandboxed subprocess, and returns
 * answers with optional chart generation.
 *
 * Uses OpenAI for code generation. Executes generated Python scripts via child_process
 * (data analysis is Python's strength -- pandas + matplotlib).
 */

import "dotenv/config";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, basename, dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_CODE_ATTEMPTS = 3;
const SUBPROCESS_TIMEOUT_MS = 30_000;
const MAX_ITERATIONS = 15;

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
// CSV inspection
// ---------------------------------------------------------------------------

function inspectCsv(filePath: string): string {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (e) {
    console.error(`❌ Could not read CSV: ${e}`);
    process.exit(1);
  }

  const lines = content.trim().split("\n");
  if (lines.length < 2) {
    console.error("❌ CSV file is empty or has only headers.");
    process.exit(1);
  }

  const headers = lines[0].split(",").map((h) => h.trim());
  const dataLines = lines.slice(1);
  const sampleLines = dataLines.slice(0, 5);

  // Infer types
  const colTypes: string[] = headers.map((_, colIdx) => {
    const values = dataLines
      .slice(0, 20)
      .map((line) => {
        const cols = line.split(",");
        return cols[colIdx]?.trim() || "";
      });
    const numericCount = values.filter((v) => {
      const n = Number(v.replace(/,/g, ""));
      return !isNaN(n) && v.trim() !== "";
    }).length;
    return numericCount > values.length * 0.8 ? "numeric" : "string";
  });

  let summary = `CSV File: ${basename(absPath)}\n`;
  summary += `Rows: ${dataLines.length.toLocaleString()}\n`;
  summary += `Columns: ${headers.length}\n\n`;
  summary += "Column Details:\n";
  headers.forEach((name, i) => {
    summary += `  ${i + 1}. ${name} (${colTypes[i]})\n`;
  });
  summary += "\nSample Rows (first 5):\n";
  summary += headers.join(",") + "\n";
  sampleLines.forEach((line) => {
    summary += line + "\n";
  });

  return summary;
}

// ---------------------------------------------------------------------------
// Code execution sandbox
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function executeCode(code: string, csvPath: string): ExecResult {
  const absCsv = resolve(csvPath);
  const outputDir = resolve(dirname(absCsv), "..", "output");
  mkdirSync(outputDir, { recursive: true });

  const preamble = `import warnings
warnings.filterwarnings('ignore')
CSV_PATH = ${JSON.stringify(absCsv)}
OUTPUT_DIR = ${JSON.stringify(outputDir)}
`;
  const fullCode = preamble + code;

  const scriptPath = join(tmpdir(), `analyst_${Date.now()}.py`);
  writeFileSync(scriptPath, fullCode, "utf-8");

  try {
    const stdout = execSync(`python3 "${scriptPath}"`, {
      timeout: SUBPROCESS_TIMEOUT_MS,
      encoding: "utf-8",
      cwd: dirname(absCsv),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: stdout || "", stderr: "", exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number; killed?: boolean };
    if (err.killed) {
      return {
        stdout: "",
        stderr: `Error: Code execution timed out after ${SUBPROCESS_TIMEOUT_MS / 1000} seconds.`,
        exitCode: 1,
      };
    }
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || String(e),
      exitCode: err.status || 1,
    };
  } finally {
    try {
      unlinkSync(scriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Agent with tool calling
// ---------------------------------------------------------------------------

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "run_analysis_code",
      description:
        "Execute Python code to analyze the CSV data. " +
        "The code has access to `CSV_PATH` (path to the CSV file) and `OUTPUT_DIR` (directory to save charts). " +
        "Use pandas to read the CSV and matplotlib/seaborn for charts. " +
        "Print results to stdout. Save any charts to OUTPUT_DIR. " +
        "pandas, matplotlib, and seaborn are available.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "Python code to execute. Use pandas to read CSV_PATH and analyze the data.",
          },
        },
        required: ["code"],
      },
    },
  },
];

function buildSystemPrompt(csvSummary: string): string {
  return `You are a data analyst agent. You analyze CSV data by writing and executing Python code.

You have access to a CSV file with this structure:

${csvSummary}

Your process:
1. Understand the user's question about the data
2. Write Python code using pandas to analyze the CSV
3. Use the run_analysis_code tool to execute your code
4. Interpret the results and provide a clear, natural language answer

Rules:
- Always read the CSV using: pd.read_csv(CSV_PATH)
- Print your analysis results to stdout using print()
- For charts: save to OUTPUT_DIR using plt.savefig(f"{OUTPUT_DIR}/chart_name.png", dpi=150, bbox_inches='tight')
- Use plt.close() after saving charts to free memory
- Handle edge cases: check for NaN values, handle empty results
- If your code fails, read the error message carefully and fix the issue
- Be precise with numbers: use appropriate rounding, include units
- When done, provide a clear summary of your findings in plain English

Available libraries: pandas, matplotlib, seaborn (pre-installed)`;
}

async function runAgent(
  question: string,
  csvPath: string,
  model: string
): Promise<string> {
  const client = new OpenAI();
  const csvSummary = inspectCsv(csvPath);
  const systemPrompt = buildSystemPrompt(csvSummary);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: question },
  ];

  let codeAttempts = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let response;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools,
        temperature: 0.2,
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

      if (fnName === "run_analysis_code") {
        const code = fnArgs.code as string;
        codeAttempts++;
        log("💻", `Running analysis code (attempt ${codeAttempts})...`);

        const result = executeCode(code, csvPath);

        let resultStr: string;
        if (result.exitCode === 0) {
          log("✓", "Code executed successfully");
          let output = result.stdout || "(Code ran successfully but produced no output)";

          // Check for saved charts
          const outputDir = resolve(dirname(resolve(csvPath)), "..", "output");
          if (existsSync(outputDir)) {
            const charts = readdirSync(outputDir).filter((f) =>
              /\.(png|jpg|svg)$/.test(f)
            );
            if (charts.length > 0) {
              output += `\n\nSaved charts: ${charts.join(", ")}`;
              log("📊", `Charts saved: ${charts.join(", ")}`);
            }
          }
          resultStr = output;
        } else {
          const errorMsg = result.stderr || "Unknown error";
          log("⚠️", `Code failed: ${errorMsg.slice(0, 100)}...`);
          resultStr = `Error:\n${errorMsg}`;

          if (codeAttempts >= MAX_CODE_ATTEMPTS) {
            resultStr += `\n\nYou have used ${MAX_CODE_ATTEMPTS} code attempts. Please provide your best answer based on what you know.`;
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: resultStr,
        });
      } else {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Unknown tool: ${fnName}`,
        });
      }
    }
  }

  return "Analysis took too many iterations. Please try a simpler question.";
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function readLine(prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    process.stdout.write(prompt);
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += String(chunk);
      if (input.includes("\n")) {
        process.stdin.pause();
        process.stdin.removeAllListeners("data");
        resolve(input.trim());
      }
    });
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let filePath: string | null = null;
  const questionParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && i + 1 < args.length) {
      filePath = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts --file <CSV_FILE> [QUESTION]");
      console.log();
      console.log("Arguments:");
      console.log("  --file PATH    Path to the CSV file to analyze");
      console.log(
        "  QUESTION       Your question about the data (optional, prompts if not given)"
      );
      console.log();
      console.log("Examples:");
      console.log(
        '  npx tsx index.ts --file ../sample_data/sales.csv "What is the total revenue by region?"'
      );
      console.log(
        '  npx tsx index.ts --file ../sample_data/sales.csv "Show me monthly sales trends"'
      );
      console.log(
        "  npx tsx index.ts --file ../sample_data/sales.csv   # Interactive mode"
      );
      process.exit(0);
    } else {
      questionParts.push(args[i]);
    }
  }

  if (!filePath) {
    // Check for default sample data
    const defaultCsv = join(import.meta.dirname ?? ".", "..", "sample_data", "sales.csv");
    if (existsSync(defaultCsv)) {
      filePath = defaultCsv;
      log("📂", "Using sample_data/sales.csv");
    } else {
      console.error("❌ Please provide a CSV file with --file <path>");
      process.exit(1);
    }
  }

  let question: string | null =
    questionParts.length > 0 ? questionParts.join(" ") : null;

  log("🚀", "Starting data analyst agent...");
  log("🤖", `Model: ${model}`);
  log("📄", `CSV: ${basename(filePath)}`);

  const summary = inspectCsv(filePath);
  console.log();
  log("📊", "Data summary:");
  summary
    .split("\n")
    .slice(0, 8)
    .forEach((line) => console.log(`   ${line}`));
  console.log();

  // One-shot or interactive
  if (question) {
    log("🔍", `Analyzing: ${question}`);
    console.log();
    try {
      const answer = await runAgent(question, filePath, model);
      console.log();
      console.log(answer);
    } catch (e) {
      console.error(`\n❌ Error: ${e}`);
      console.error("   Check your OPENAI_API_KEY and network connection.");
      process.exit(1);
    }
  } else {
    // Interactive mode
    while (true) {
      let q: string;
      try {
        q = await readLine(
          "❓ Ask a question about the data (or 'quit' to exit): "
        );
      } catch {
        console.log("\n👋 Goodbye!");
        break;
      }

      if (!q.trim()) continue;
      if (["quit", "exit", "q"].includes(q.toLowerCase())) {
        console.log("👋 Goodbye!");
        break;
      }

      log("🔍", `Analyzing: ${q}`);
      console.log();

      try {
        const answer = await runAgent(q, filePath, model);
        console.log();
        console.log(answer);
        console.log();
      } catch (e) {
        console.error(`\n❌ Error: ${e}`);
        console.error("   Check your OPENAI_API_KEY and network connection.");
      }
    }
  }
}

main().catch(console.error);
