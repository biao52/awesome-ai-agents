/**
 * Secret Scanner Agent -- Scans a codebase for leaked credentials, API keys,
 * tokens, and other secrets using regex pattern matching and LLM verification.
 *
 * Phase 1 uses regex to find candidates. Phase 2 sends suspicious findings
 * to Claude for confirmation and severity rating.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { resolve, relative, extname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_RETRIES = 3;
const MAX_FILE_SIZE = 512_000;
const CONTEXT_LINES = 2;

const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv",
  ".mypy_cache", ".pytest_cache", "dist", "build", ".next",
  ".nuxt", "target", "vendor", ".tox", "eggs", ".eggs",
  "coverage", ".coverage", ".nyc_output",
]);

const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv",
  ".zip", ".tar", ".gz", ".bz2", ".rar", ".7z",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".pyc", ".pyo", ".class", ".o", ".so", ".dylib", ".dll",
  ".exe", ".bin", ".dat", ".db", ".sqlite",
  ".lock", ".sum",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SecretPattern {
  name: string;
  pattern: RegExp;
  description: string;
}

interface Finding {
  file: string;
  line: number;
  patternName: string;
  description: string;
  matchedValue: string;
  context: string;
  rawLine: string;
  isReal?: boolean;
  severity?: string;
  reasoning?: string;
  recommendation?: string;
}

// ---------------------------------------------------------------------------
// Secret patterns
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "AWS Access Key",
    pattern: /(?:^|['"\\s=:])?(AKIA[0-9A-Z]{16})(?:['"\s]|$)/gi,
    description: "AWS IAM access key ID",
  },
  {
    name: "AWS Secret Key",
    pattern: /(?:aws_secret_access_key|aws_secret|secret_key)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    description: "AWS secret access key",
  },
  {
    name: "OpenAI API Key",
    pattern: /(?:^|['"\\s=:])?sk-[A-Za-z0-9_-]{20,}/gi,
    description: "OpenAI API key (sk-...)",
  },
  {
    name: "Anthropic API Key",
    pattern: /(?:^|['"\\s=:])?sk-ant-[A-Za-z0-9_-]{20,}/gi,
    description: "Anthropic API key (sk-ant-...)",
  },
  {
    name: "GitHub Token",
    pattern: /(?:^|['"\\s=:])?(?:ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghu_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghr_[A-Za-z0-9]{36})/gi,
    description: "GitHub personal access token or OAuth token",
  },
  {
    name: "Slack Token",
    pattern: /(?:^|['"\\s=:])?xox[bprs]-[A-Za-z0-9-]{10,}/gi,
    description: "Slack API token",
  },
  {
    name: "Stripe Key",
    pattern: /(?:^|['"\\s=:])?(?:sk_live_|rk_live_|pk_live_)[A-Za-z0-9]{20,}/gi,
    description: "Stripe live API key",
  },
  {
    name: "Generic API Key",
    pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[=:]\s*['"]([A-Za-z0-9_\-]{20,})['"]/gi,
    description: "Generic API key in config",
  },
  {
    name: "Private Key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    description: "Private key file content",
  },
  {
    name: "Password in Config",
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"]([^'"]{8,})['"]/gi,
    description: "Hardcoded password in configuration",
  },
  {
    name: "Database URL",
    pattern: /(?:mysql|postgres|postgresql|mongodb|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi,
    description: "Database connection string with credentials",
  },
  {
    name: "JWT Token",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    description: "JSON Web Token",
  },
  {
    name: "Google API Key",
    pattern: /(?:^|['"\\s=:])?AIza[0-9A-Za-z_-]{35}/g,
    description: "Google API key",
  },
  {
    name: "SendGrid Key",
    pattern: /(?:^|['"\\s=:])?SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
    description: "SendGrid API key",
  },
];

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    console.error(
      "   Get your Anthropic key at: https://console.anthropic.com/settings/keys"
    );
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function shouldScanFile(filePath: string, fileName: string): boolean {
  if (fileName.startsWith(".") && fileName !== ".env") return false;
  if (SKIP_EXTENSIONS.has(extname(fileName).toLowerCase())) return false;

  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return false;
  } catch {
    return false;
  }

  return true;
}

function collectFiles(directory: string): string[] {
  const root = resolve(directory);
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (stat.isFile() && shouldScanFile(fullPath, entry)) {
          files.push(fullPath);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  }

  walk(root);
  return files;
}

// ---------------------------------------------------------------------------
// Secret masking and context
// ---------------------------------------------------------------------------

function maskSecret(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return value.slice(0, 4) + "*".repeat(value.length - 8) + value.slice(-4);
}

function getContext(lines: string[], lineNum: number): string {
  const start = Math.max(0, lineNum - CONTEXT_LINES - 1);
  const end = Math.min(lines.length, lineNum + CONTEXT_LINES);
  const contextLines: string[] = [];

  for (let i = start; i < end; i++) {
    const marker = i === lineNum - 1 ? " >> " : "    ";
    contextLines.push(`${marker}${i + 1}: ${lines[i]}`);
  }

  return contextLines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 1: Regex scanning
// ---------------------------------------------------------------------------

function scanFileRegex(filePath: string, rootDir: string): Finding[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  // Skip .env.example files
  const fileName = filePath.split("/").pop() || "";
  if (fileName.endsWith(".example")) return [];

  const lines = content.split("\n");
  const relativePath = relative(rootDir, filePath);
  const findings: Finding[] = [];

  for (const pattern of SECRET_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      // Reset regex lastIndex for global patterns
      pattern.pattern.lastIndex = 0;
      const match = pattern.pattern.exec(lines[i]);
      if (match) {
        const secretValue = match[0].trim().replace(/^['":=\s]+|['"\s]+$/g, "");
        findings.push({
          file: relativePath,
          line: i + 1,
          patternName: pattern.name,
          description: pattern.description,
          matchedValue: maskSecret(secretValue),
          context: getContext(lines, i + 1),
          rawLine: lines[i],
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Phase 2: LLM verification
// ---------------------------------------------------------------------------

async function verifyWithLlm(
  findings: Finding[],
  model: string
): Promise<Finding[]> {
  if (findings.length === 0) return [];

  const client = new Anthropic();

  let findingsText = "";
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    findingsText += `
Finding #${i + 1}:
  File: ${f.file}
  Line: ${f.line}
  Pattern: ${f.patternName}
  Context:
${f.context}
---
`;
  }

  const prompt = `Analyze these potential secret/credential leaks found in a codebase.
For each finding, determine:
1. Is this a REAL secret or a false positive? (e.g., example values, test fixtures, env var references without values)
2. Severity: CRITICAL (production credentials), HIGH (valid-looking keys), MEDIUM (potentially sensitive), LOW (likely false positive)
3. A brief recommendation

Respond with a JSON array where each element has:
{
  "finding_number": <int>,
  "is_real": <bool>,
  "severity": "<CRITICAL|HIGH|MEDIUM|LOW>",
  "reasoning": "<brief explanation>",
  "recommendation": "<what to do>"
}

Findings to analyze:
${findingsText}

Return ONLY the JSON array.`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        temperature: 0.1,
        messages: [{ role: "user", content: prompt }],
      });

      let text = "";
      for (const block of response.content) {
        if (block.type === "text") text += block.text;
      }

      text = text.trim();
      if (text.startsWith("```")) {
        text = text.split("\n").slice(1).join("\n");
        if (text.endsWith("```")) text = text.slice(0, -3);
        text = text.trim();
      }

      const verifications = JSON.parse(text) as Array<{
        finding_number: number;
        is_real: boolean;
        severity: string;
        reasoning: string;
        recommendation: string;
      }>;

      const verified: Finding[] = [];
      for (const v of verifications) {
        const idx = v.finding_number - 1;
        if (idx >= 0 && idx < findings.length) {
          verified.push({
            ...findings[idx],
            isReal: v.is_real,
            severity: v.severity,
            reasoning: v.reasoning,
            recommendation: v.recommendation,
          });
        }
      }

      return verified;
    } catch (e) {
      const errorStr = String(e);
      if (
        attempt < MAX_RETRIES &&
        (errorStr.toLowerCase().includes("rate") ||
          errorStr.toLowerCase().includes("overloaded"))
      ) {
        const waitTime = Math.pow(2, attempt);
        log(
          "⏳",
          `API error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${waitTime}s...`
        );
        await new Promise((r) => setTimeout(r, waitTime * 1000));
      } else if (attempt >= MAX_RETRIES) {
        log("⚠️", `Could not verify findings with LLM: ${e}`);
        return findings.map((f) => ({
          ...f,
          isReal: true,
          severity: "MEDIUM",
          reasoning: "Not verified by LLM",
          recommendation: "Review manually",
        }));
      }
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printResults(findings: Finding[]): void {
  const severityEmoji: Record<string, string> = {
    CRITICAL: "🔴",
    HIGH: "🟠",
    MEDIUM: "🟡",
    LOW: "🟢",
  };

  const realFindings = findings.filter((f) => f.isReal !== false);
  const falsePositives = findings.filter((f) => f.isReal === false);

  if (realFindings.length === 0) {
    log(
      "🎉",
      "No real secrets detected! All candidates were false positives."
    );
    if (falsePositives.length > 0) {
      console.log(
        `   (${falsePositives.length} false positive(s) filtered out)`
      );
    }
    return;
  }

  const bySeverity: Record<string, Finding[]> = {};
  for (const f of realFindings) {
    const sev = f.severity || "MEDIUM";
    if (!bySeverity[sev]) bySeverity[sev] = [];
    bySeverity[sev].push(f);
  }

  for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
    const group = bySeverity[severity];
    if (!group || group.length === 0) continue;

    const emoji = severityEmoji[severity] || "⚪";
    console.log(`\n${emoji} ${severity} (${group.length})`);
    console.log("─".repeat(60));

    for (const f of group) {
      console.log(`  ${f.file}:${f.line}`);
      console.log(`    Type: ${f.patternName}`);
      console.log(`    Value: ${f.matchedValue}`);
      if (f.reasoning) console.log(`    Analysis: ${f.reasoning}`);
      if (f.recommendation) console.log(`    Action: ${f.recommendation}`);
      console.log();
    }
  }

  if (falsePositives.length > 0) {
    console.log(
      `  (${falsePositives.length} false positive(s) filtered out)`
    );
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let targetDir = ".";
  let skipLlm = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--dir" || args[i] === "-d") && i + 1 < args.length) {
      targetDir = args[i + 1];
      i++;
    } else if (args[i] === "--no-llm") {
      skipLlm = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [OPTIONS]");
      console.log();
      console.log("Options:");
      console.log(
        "  --dir, -d DIR   Directory to scan (default: current directory)"
      );
      console.log("  --no-llm        Skip LLM verification (regex only)");
      console.log("  --help, -h      Show this help message");
      console.log();
      console.log("Examples:");
      console.log(
        "  npx tsx index.ts                     # Scan current directory"
      );
      console.log("  npx tsx index.ts --dir /path/to/project");
      console.log("  npx tsx index.ts --dir ./src --no-llm");
      process.exit(0);
    } else {
      console.error(`❌ Unknown argument: ${args[i]}`);
      console.error("   Use --help for usage information.");
      process.exit(1);
    }
  }

  log("🚀", "Starting secret scanner agent...");
  log("🤖", `Model: ${model}`);
  log("📁", `Scanning: ${resolve(targetDir)}`);
  console.log();

  // Phase 1: Collect and scan files
  log("🔍", "Phase 1: Collecting files...");
  const files = collectFiles(targetDir);
  log("📄", `Found ${files.length} files to scan`);

  log("🔍", "Phase 1: Scanning with regex patterns...");
  const rootDir = resolve(targetDir);
  const allCandidates: Finding[] = [];

  for (const filePath of files) {
    const candidates = scanFileRegex(filePath, rootDir);
    allCandidates.push(...candidates);
  }

  log("🔎", `Found ${allCandidates.length} candidate(s) from regex scan`);

  if (allCandidates.length === 0) {
    console.log();
    log("🎉", "No potential secrets detected. Your codebase looks clean!");
    log("✅", "Scan complete!");
    return;
  }

  // Phase 2: LLM verification
  let verified: Finding[];

  if (skipLlm) {
    log("⏭️", "Skipping LLM verification (--no-llm flag)");
    verified = allCandidates.map((f) => ({
      ...f,
      isReal: true,
      severity: "MEDIUM",
      reasoning: "Not verified (regex match only)",
      recommendation: "Review manually",
    }));
  } else {
    console.log();
    log(
      "🤖",
      `Phase 2: Verifying ${allCandidates.length} candidate(s) with Claude...`
    );

    verified = [];
    const batchSize = 20;
    for (let i = 0; i < allCandidates.length; i += batchSize) {
      const batch = allCandidates.slice(i, i + batchSize);
      const batchVerified = await verifyWithLlm(batch, model);
      verified.push(...batchVerified);
    }
  }

  // Print results
  console.log();
  console.log("=".repeat(60));
  log("📊", "Scan Results");
  console.log("=".repeat(60));

  const realCount = verified.filter((f) => f.isReal !== false).length;
  console.log(`  Files scanned:      ${files.length}`);
  console.log(`  Regex candidates:   ${allCandidates.length}`);
  console.log(`  Confirmed secrets:  ${realCount}`);

  printResults(verified);

  console.log();
  log("✅", "Scan complete!");

  if (realCount > 0) {
    const critical = verified.filter(
      (f) => f.isReal && f.severity === "CRITICAL"
    ).length;
    if (critical > 0) {
      log(
        "⚠️",
        `${critical} CRITICAL finding(s) require immediate attention!`
      );
    }
    process.exit(1);
  }
}

main().catch(console.error);
