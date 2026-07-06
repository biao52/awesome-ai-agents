/**
 * Regex Generator Agent -- Takes a natural language description and generates a
 * tested regular expression with explanation.
 *
 * Uses OpenAI GPT-4o-mini for generation and JavaScript RegExp for validation.
 */

import "dotenv/config";
import OpenAI from "openai";
import { createInterface } from "node:readline/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegexInfo {
  pattern: string;
  flags: string;
  explanation: string;
  examples_match: string[];
  examples_no_match: string[];
}

interface TestResult {
  string: string;
  matches: boolean;
  matchedText?: string;
  groups?: string[];
  allMatches?: string[];
  error?: string;
}

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
// Regex generation via OpenAI
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert at writing regular expressions. Given a natural language description, generate a regex pattern that matches the described text.

You MUST respond with valid JSON in this exact format:
{
  "pattern": "the regex pattern as a string",
  "flags": "any flags to use (e.g., 'i' for case-insensitive, 'g' for global, 'm' for multiline) -- leave empty string if none",
  "explanation": "a clear, line-by-line breakdown of what each part of the regex does",
  "examples_match": ["list of 3-5 example strings that SHOULD match"],
  "examples_no_match": ["list of 3-5 example strings that should NOT match"]
}

Rules:
- The pattern must be valid in both Python (re module) and JavaScript (RegExp)
- Prefer readable patterns over clever ones -- use character classes and named groups where helpful
- Escape special characters properly
- The explanation should be understandable by someone who doesn't know regex well
- Break down the pattern piece by piece in the explanation
- Be precise: "match email addresses" means RFC-compliant-ish emails, not just "anything with @"
- Consider edge cases in your examples (e.g., for emails: subdomains, plus addressing, TLDs)
- Output ONLY the JSON object, no markdown fencing, no extra text`;

async function generateRegex(
  description: string,
  model: string
): Promise<RegexInfo> {
  const client = new OpenAI();

  const userMessage = `Generate a regex pattern for: ${description}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 1024,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("Empty response from API");
      }

      const result = JSON.parse(content) as Record<string, unknown>;

      // Validate required fields
      if (!result.pattern || typeof result.pattern !== "string") {
        throw new Error("Missing or invalid 'pattern' field in response");
      }
      if (!result.explanation || typeof result.explanation !== "string") {
        throw new Error("Missing or invalid 'explanation' field in response");
      }

      return {
        pattern: result.pattern as string,
        flags: (result.flags as string) || "",
        explanation: result.explanation as string,
        examples_match: (result.examples_match as string[]) || [],
        examples_no_match: (result.examples_no_match as string[]) || [],
      };
    } catch (e) {
      const errorStr = String(e);
      const isTransient =
        errorStr.toLowerCase().includes("rate") ||
        errorStr.toLowerCase().includes("overloaded") ||
        errorStr.includes("529") ||
        errorStr.includes("500");

      if (attempt < MAX_RETRIES && (isTransient || e instanceof SyntaxError)) {
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
// Regex testing
// ---------------------------------------------------------------------------

function testRegex(
  pattern: string,
  flagsStr: string,
  testStrings: string[]
): TestResult[] {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flagsStr);
  } catch (e) {
    return testStrings.map((s) => ({
      string: s,
      matches: false,
      error: `Invalid regex: ${e}`,
    }));
  }

  return testStrings.map((testStr) => {
    // Reset lastIndex for global/sticky flags
    regex.lastIndex = 0;
    const match = regex.exec(testStr);

    const result: TestResult = {
      string: testStr,
      matches: match !== null,
    };

    if (match) {
      result.matchedText = match[0];
      const groups = match.slice(1).filter((g) => g !== undefined);
      if (groups.length > 0) {
        result.groups = groups;
      }

      // Find all matches
      if (flagsStr.includes("g")) {
        const allMatches: string[] = [match[0]];
        let nextMatch: RegExpExecArray | null;
        while ((nextMatch = regex.exec(testStr)) !== null) {
          allMatches.push(nextMatch[0]);
          if (nextMatch[0] === "") {
            regex.lastIndex++;
          }
        }
        if (allMatches.length > 1) {
          result.allMatches = allMatches;
        }
      }
    }

    return result;
  });
}

function validatePattern(pattern: string, flagsStr: string): boolean {
  try {
    new RegExp(pattern, flagsStr);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function displayResults(
  regexInfo: RegexInfo,
  testResults: TestResult[] | null
): void {
  console.log();
  console.log("═".repeat(60));
  log("🎯", "Generated Regex");
  console.log("═".repeat(60));
  console.log();

  const { pattern, flags } = regexInfo;

  console.log(`  Pattern:  ${pattern}`);
  if (flags) {
    console.log(`  Flags:    ${flags}`);
  }
  console.log();

  // Python usage
  console.log("  Python usage:");
  if (flags) {
    const flagNames: Record<string, string> = {
      i: "re.IGNORECASE",
      m: "re.MULTILINE",
      s: "re.DOTALL",
    };
    const pyFlags = flags
      .split("")
      .filter((f) => f in flagNames)
      .map((f) => flagNames[f])
      .join(" | ");
    console.log(`    re.search(r"${pattern}", text, ${pyFlags})`);
  } else {
    console.log(`    re.search(r"${pattern}", text)`);
  }
  console.log();

  // JavaScript usage
  console.log("  JavaScript usage:");
  console.log(`    /${pattern}/${flags}`);
  console.log();

  // Explanation
  console.log("─".repeat(60));
  log("📖", "Explanation");
  console.log("─".repeat(60));
  console.log();
  for (const line of regexInfo.explanation.split("\n")) {
    console.log(`  ${line}`);
  }
  console.log();

  // Built-in examples
  if (
    regexInfo.examples_match.length > 0 ||
    regexInfo.examples_no_match.length > 0
  ) {
    console.log("─".repeat(60));
    log("📋", "Examples from AI");
    console.log("─".repeat(60));
    console.log();
    if (regexInfo.examples_match.length > 0) {
      console.log("  Should match:");
      for (const ex of regexInfo.examples_match) {
        console.log(`    ✅ ${ex}`);
      }
    }
    if (regexInfo.examples_no_match.length > 0) {
      console.log("  Should NOT match:");
      for (const ex of regexInfo.examples_no_match) {
        console.log(`    ❌ ${ex}`);
      }
    }
    console.log();
  }

  // User-provided test results
  if (testResults) {
    console.log("─".repeat(60));
    log("🧪", "Test Results");
    console.log("─".repeat(60));
    console.log();
    for (const result of testResults) {
      if (result.error) {
        console.log(`  ⚠️  "${result.string}" -- ${result.error}`);
      } else if (result.matches) {
        let line = `  ✅ "${result.string}" -- matched: "${result.matchedText}"`;
        if (result.groups) {
          line += `  groups: [${result.groups.map((g) => `"${g}"`).join(", ")}]`;
        }
        if (result.allMatches && result.allMatches.length > 1) {
          line += `  (${result.allMatches.length} total matches)`;
        }
        console.log(line);
      } else {
        console.log(`  ❌ "${result.string}" -- no match`);
      }
    }
    console.log();
  }

  console.log("═".repeat(60));
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let description: string | null = null;
  let testStrings: string[] = [];

  // Parse CLI arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--test" && i + 1 < args.length) {
      testStrings = args[i + 1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [DESCRIPTION] [OPTIONS]");
      console.log();
      console.log(
        "Generates a tested regex from a natural language description."
      );
      console.log();
      console.log("Arguments:");
      console.log(
        "  DESCRIPTION    What the regex should match (in quotes)"
      );
      console.log();
      console.log("Options:");
      console.log(
        "  --test STRINGS   Comma-separated test strings to validate against"
      );
      console.log("  --help           Show this help message");
      console.log();
      console.log("Examples:");
      console.log('  npx tsx index.ts "Match email addresses"');
      console.log(
        '  npx tsx index.ts "Match US phone numbers" --test "+1-555-123-4567,not-a-phone,555.123.4567"'
      );
      console.log('  npx tsx index.ts "Match URLs starting with https"');
      console.log();
      console.log(
        "If no description is given, you'll be prompted interactively."
      );
      process.exit(0);
    } else if (!description && !args[i].startsWith("--")) {
      description = args[i];
    } else {
      console.error(`❌ Unknown argument: ${args[i]}`);
      console.error("   Use --help for usage information.");
      process.exit(1);
    }
  }

  log("🚀", "Starting regex generator agent...");
  log("🤖", `Model: ${model}`);
  console.log();

  // Get description interactively if not provided
  if (!description) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      description = (
        await rl.question("📝 What should the regex match? ")
      ).trim();

      if (!description) {
        console.error("❌ No description provided.");
        process.exit(1);
      }

      if (testStrings.length === 0) {
        const testInput = (
          await rl.question(
            "🧪 Test strings (comma-separated, or press Enter to skip): "
          )
        ).trim();
        if (testInput) {
          testStrings = testInput
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
      }
    } catch {
      console.log("\n❌ Cancelled.");
      process.exit(0);
    } finally {
      rl.close();
    }
  }

  log("🔍", `Generating regex for: ${description}`);
  console.log();

  // Generate the regex
  let regexInfo: RegexInfo;
  try {
    regexInfo = await generateRegex(description, model);
  } catch (e) {
    console.error(`\n❌ Error generating regex: ${e}`);
    console.error("   Check your OPENAI_API_KEY and network connection.");
    process.exit(1);
  }

  // Validate the generated pattern
  if (!validatePattern(regexInfo.pattern, regexInfo.flags)) {
    log(
      "⚠️",
      "The generated pattern is invalid in JavaScript. Displaying anyway."
    );
  }

  // Run tests against user-provided strings
  let testResults: TestResult[] | null = null;
  if (testStrings.length > 0) {
    log("🧪", `Testing against ${testStrings.length} string(s)...`);
    testResults = testRegex(regexInfo.pattern, regexInfo.flags, testStrings);
  }

  // Display results
  displayResults(regexInfo, testResults);

  log("✅", "Done!");
}

main().catch(console.error);
