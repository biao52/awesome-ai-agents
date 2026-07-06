/**
 * Dependency Audit Agent -- Reads dependency files (package.json, requirements.txt,
 * Cargo.toml, go.mod) and checks for known vulnerabilities using the OSV API.
 *
 * Uses OpenAI GPT for summarizing findings and providing actionable recommendations.
 */

import "dotenv/config";
import OpenAI from "openai";
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-4o-mini";
const OSV_API_URL = "https://api.osv.dev/v1/query";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

const SUPPORTED_FILES: Record<string, string> = {
  "package.json": "npm",
  "requirements.txt": "PyPI",
  "Cargo.toml": "crates.io",
  "go.mod": "Go",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Dependency {
  name: string;
  version: string;
}

interface Finding {
  package: string;
  version: string;
  vulnId: string;
  summary: string;
  severity: string;
  fixedVersion: string;
  references: string[];
}

interface OsvVuln {
  id?: string;
  summary?: string;
  severity?: Array<{ type?: string; score?: string }>;
  affected?: Array<{
    ecosystem_specific?: Record<string, unknown>;
    ranges?: Array<{
      events?: Array<Record<string, string>>;
    }>;
  }>;
  database_specific?: Record<string, unknown>;
  references?: Array<{ url?: string }>;
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
// Dependency file parsing
// ---------------------------------------------------------------------------

function findDependencyFiles(
  directory: string
): Array<{ path: string; ecosystem: string }> {
  const found: Array<{ path: string; ecosystem: string }> = [];
  const dirPath = resolve(directory);

  for (const [filename, ecosystem] of Object.entries(SUPPORTED_FILES)) {
    const filePath = join(dirPath, filename);
    if (existsSync(filePath)) {
      found.push({ path: filePath, ecosystem });
    }
  }

  return found;
}

function parsePackageJson(filePath: string): Dependency[] {
  const data = JSON.parse(readFileSync(filePath, "utf-8"));
  const deps: Dependency[] = [];

  for (const section of ["dependencies", "devDependencies"] as const) {
    const sectionDeps = data[section] || {};
    for (const [name, versionSpec] of Object.entries(sectionDeps)) {
      let version = String(versionSpec).replace(/^[\^~>=<\s]+/, "");
      version = version.split(" ")[0].split(",")[0].trim();
      if (version) {
        deps.push({ name, version });
      }
    }
  }

  return deps;
}

function parseRequirementsTxt(filePath: string): Dependency[] {
  const content = readFileSync(filePath, "utf-8");
  const deps: Dependency[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;

    const match = line.match(/^([a-zA-Z0-9_.-]+)\s*[><=~!]+\s*([\d.]+)/);
    if (match) {
      deps.push({ name: match[1], version: match[2] });
    } else {
      const pkgMatch = line.match(/^([a-zA-Z0-9_.-]+)/);
      if (pkgMatch) {
        deps.push({ name: pkgMatch[1], version: "" });
      }
    }
  }

  return deps;
}

function parseCargoToml(filePath: string): Dependency[] {
  const content = readFileSync(filePath, "utf-8");
  const deps: Dependency[] = [];
  let inDepsSection = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("[")) {
      inDepsSection =
        line === "[dependencies]" || line === "[dev-dependencies]";
      continue;
    }

    if (inDepsSection && line.includes("=")) {
      const parts = line.split("=");
      const name = parts[0].trim();
      const value = parts.slice(1).join("=").trim().replace(/"/g, "");

      const versionMatch = value.match(/version\s*=\s*([^\s,}]+)/);
      let version: string;
      if (versionMatch) {
        version = versionMatch[1];
      } else {
        version = value.replace(/^[\^~>=<\s]+/, "");
      }

      if (name && version) {
        deps.push({ name, version });
      }
    }
  }

  return deps;
}

function parseGoMod(filePath: string): Dependency[] {
  const content = readFileSync(filePath, "utf-8");
  const deps: Dependency[] = [];
  let inRequire = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("require (")) {
      inRequire = true;
      continue;
    }
    if (line === ")" && inRequire) {
      inRequire = false;
      continue;
    }

    if (inRequire || line.startsWith("require ")) {
      const parts = line.replace("require ", "").trim().split(/\s+/);
      if (parts.length >= 2) {
        deps.push({ name: parts[0], version: parts[1].replace(/^v/, "") });
      }
    }
  }

  return deps;
}

function parseDependencyFile(
  filePath: string,
  ecosystem: string
): Dependency[] {
  const parsers: Record<string, (path: string) => Dependency[]> = {
    npm: parsePackageJson,
    PyPI: parseRequirementsTxt,
    "crates.io": parseCargoToml,
    Go: parseGoMod,
  };

  const parser = parsers[ecosystem];
  if (!parser) {
    log("⚠️", `No parser for ecosystem: ${ecosystem}`);
    return [];
  }

  try {
    return parser(filePath);
  } catch (e) {
    log("❌", `Error parsing ${filePath}: ${e}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// OSV vulnerability lookup
// ---------------------------------------------------------------------------

function extractSeverity(vuln: OsvVuln): string {
  const dbSpecific = vuln.database_specific || {};
  if ("severity" in dbSpecific) {
    return String(dbSpecific.severity).toUpperCase();
  }

  const severityList = vuln.severity || [];
  for (const sev of severityList) {
    if (sev.type === "CVSS_V3") {
      return "HIGH";
    }
  }

  for (const affected of vuln.affected || []) {
    const ecoSpecific = affected.ecosystem_specific || {};
    if ("severity" in ecoSpecific) {
      return String(ecoSpecific.severity).toUpperCase();
    }
  }

  return "UNKNOWN";
}

function extractFixedVersion(vuln: OsvVuln): string {
  for (const affected of vuln.affected || []) {
    for (const range of affected.ranges || []) {
      for (const event of range.events || []) {
        if ("fixed" in event) {
          return event.fixed;
        }
      }
    }
  }
  return "No fix available";
}

async function queryOsv(
  packageName: string,
  version: string,
  ecosystem: string
): Promise<OsvVuln[]> {
  const payload: Record<string, unknown> = {
    package: { name: packageName, ecosystem },
  };
  if (version) {
    payload.version = version;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(OSV_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        if (attempt < MAX_RETRIES && response.status >= 500) {
          await new Promise((r) =>
            setTimeout(r, Math.pow(2, attempt) * 1000)
          );
          continue;
        }
        return [];
      }

      const data = (await response.json()) as { vulns?: OsvVuln[] };
      return data.vulns || [];
    } catch {
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      } else {
        log("⚠️", `Timeout querying OSV for ${packageName}. Skipping.`);
        return [];
      }
    }
  }

  return [];
}

async function checkAllDependencies(
  deps: Dependency[],
  ecosystem: string
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const batchSize = 5;

  for (let i = 0; i < deps.length; i += batchSize) {
    const batch = deps.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((dep) => queryOsv(dep.name, dep.version, ecosystem))
    );

    for (let j = 0; j < batch.length; j++) {
      const dep = batch[j];
      const vulns = results[j];

      for (const vuln of vulns) {
        findings.push({
          package: dep.name,
          version: dep.version,
          vulnId: vuln.id || "Unknown",
          summary: vuln.summary || "No description available",
          severity: extractSeverity(vuln),
          fixedVersion: extractFixedVersion(vuln),
          references: (vuln.references || [])
            .slice(0, 3)
            .map((r) => r.url || ""),
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// LLM summary
// ---------------------------------------------------------------------------

async function generateSummary(
  findings: Finding[],
  totalDeps: number,
  ecosystem: string,
  model: string
): Promise<string> {
  const client = new OpenAI();
  const vulnPackages = new Set(findings.map((f) => f.package)).size;

  const response = await client.chat.completions.create({
    model,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "You are a security engineer summarizing dependency audit results. " +
          "Be concise and actionable. Focus on what the developer should do next. " +
          "Group findings by severity. Mention specific version upgrades when available.",
      },
      {
        role: "user",
        content:
          `Summarize these dependency audit findings for a ${ecosystem} project.\n` +
          `Total dependencies scanned: ${totalDeps}\n` +
          `Vulnerable packages found: ${vulnPackages}\n` +
          `Total vulnerabilities: ${findings.length}\n\n` +
          `Findings:\n${JSON.stringify(findings, null, 2)}\n\n` +
          "Provide:\n" +
          "1. A brief overview (2-3 sentences)\n" +
          "2. Priority actions (what to fix first)\n" +
          "3. Specific upgrade commands for the ecosystem\n" +
          "Keep it under 300 words.",
      },
    ],
  });

  return response.choices[0]?.message?.content || "No summary generated.";
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printFindings(findings: Finding[]): void {
  if (findings.length === 0) return;

  const severityEmoji: Record<string, string> = {
    CRITICAL: "🔴",
    HIGH: "🟠",
    MODERATE: "🟡",
    LOW: "🟢",
    UNKNOWN: "⚪",
  };

  const bySeverity: Record<string, Finding[]> = {};
  for (const finding of findings) {
    if (!bySeverity[finding.severity]) {
      bySeverity[finding.severity] = [];
    }
    bySeverity[finding.severity].push(finding);
  }

  for (const severity of ["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"]) {
    const group = bySeverity[severity];
    if (!group || group.length === 0) continue;

    const emoji = severityEmoji[severity] || "⚪";
    console.log(`\n${emoji} ${severity} (${group.length})`);
    console.log("─".repeat(50));

    for (const finding of group) {
      console.log(`  ${finding.package}@${finding.version}`);
      console.log(`    ID: ${finding.vulnId}`);
      console.log(`    ${finding.summary.slice(0, 120)}`);
      if (finding.fixedVersion !== "No fix available") {
        console.log(`    Fix: upgrade to ${finding.fixedVersion}`);
      } else {
        console.log(`    Fix: ${finding.fixedVersion}`);
      }
      if (finding.references.length > 0) {
        console.log(`    Ref: ${finding.references[0]}`);
      }
      console.log();
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL || DEFAULT_MODEL;
  const args = process.argv.slice(2);

  let targetFile: string | null = null;
  let targetDir = ".";

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--file" || args[i] === "-f") && i + 1 < args.length) {
      targetFile = args[i + 1];
      i++;
    } else if (
      (args[i] === "--dir" || args[i] === "-d") &&
      i + 1 < args.length
    ) {
      targetDir = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [OPTIONS]");
      console.log();
      console.log("Options:");
      console.log("  --file, -f PATH   Audit a specific dependency file");
      console.log(
        "  --dir, -d DIR     Scan a directory for dependency files (default: current dir)"
      );
      console.log("  --help, -h        Show this help message");
      console.log();
      console.log(
        "Supported files: package.json, requirements.txt, Cargo.toml, go.mod"
      );
      console.log();
      console.log("Examples:");
      console.log(
        "  npx tsx index.ts                      # Auto-detect in current directory"
      );
      console.log(
        "  npx tsx index.ts --file package.json   # Audit a specific file"
      );
      console.log("  npx tsx index.ts --dir /path/to/project");
      process.exit(0);
    } else {
      console.error(`❌ Unknown argument: ${args[i]}`);
      console.error("   Use --help for usage information.");
      process.exit(1);
    }
  }

  log("🚀", "Starting dependency audit agent...");
  log("🤖", `Model: ${model}`);
  console.log();

  // Find dependency files
  let filesToAudit: Array<{ path: string; ecosystem: string }>;

  if (targetFile) {
    const absPath = resolve(targetFile);
    if (!existsSync(absPath)) {
      console.error(`❌ File not found: ${targetFile}`);
      process.exit(1);
    }

    const filename = basename(absPath);
    const ecosystem = SUPPORTED_FILES[filename];
    if (!ecosystem) {
      console.error(`❌ Unsupported file type: ${filename}`);
      console.error(
        `   Supported: ${Object.keys(SUPPORTED_FILES).join(", ")}`
      );
      process.exit(1);
    }

    filesToAudit = [{ path: absPath, ecosystem }];
  } else {
    filesToAudit = findDependencyFiles(targetDir);
  }

  if (filesToAudit.length === 0) {
    console.error("❌ No dependency files found.");
    console.error(
      `   Supported: ${Object.keys(SUPPORTED_FILES).join(", ")}`
    );
    console.error(`   Searched in: ${resolve(targetDir)}`);
    process.exit(1);
  }

  log("📁", `Found ${filesToAudit.length} dependency file(s)`);

  const allFindings: Finding[] = [];
  let totalDeps = 0;

  for (const { path: filePath, ecosystem } of filesToAudit) {
    const filename = basename(filePath);
    log("📦", `Parsing ${filename} (${ecosystem})...`);

    const deps = parseDependencyFile(filePath, ecosystem);
    if (deps.length === 0) {
      log("⚠️", `No dependencies found in ${filename}`);
      continue;
    }

    totalDeps += deps.length;
    log("🔍", `Checking ${deps.length} dependencies against OSV database...`);

    const findings = await checkAllDependencies(deps, ecosystem);
    allFindings.push(...findings);

    if (findings.length > 0) {
      log("⚠️", `Found ${findings.length} vulnerability/ies in ${filename}`);
    } else {
      log("✅", `No known vulnerabilities in ${filename}`);
    }
  }

  // Print results
  console.log();
  console.log("=".repeat(60));
  log("📊", "Audit Results");
  console.log("=".repeat(60));
  console.log(`  Dependencies scanned: ${totalDeps}`);
  console.log(`  Vulnerabilities found: ${allFindings.length}`);
  const vulnPackages = new Set(allFindings.map((f) => f.package)).size;
  console.log(`  Vulnerable packages:  ${vulnPackages}`);

  if (allFindings.length > 0) {
    printFindings(allFindings);

    console.log();
    log("🤖", "Generating recommendations...");
    try {
      const ecosystemName = filesToAudit[0]?.ecosystem || "unknown";
      const summary = await generateSummary(
        allFindings,
        totalDeps,
        ecosystemName,
        model
      );
      console.log();
      console.log("💡 Recommendations");
      console.log("─".repeat(50));
      console.log(summary);
    } catch (e) {
      log("⚠️", `Could not generate summary: ${e}`);
    }
  } else {
    console.log();
    log("🎉", "All clear! No known vulnerabilities detected.");
  }

  console.log();
  log("✅", "Audit complete!");
}

main().catch(console.error);
