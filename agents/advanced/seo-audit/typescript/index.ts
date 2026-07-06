/**
 * SEO Audit Agent - Crawls a website via Reader and produces a comprehensive
 * SEO analysis report with page-by-page scoring, prioritized issues, and
 * actionable recommendations.
 *
 * Uses Reader (api.reader.dev/v1/read) for page reading and OpenAI for qualitative analysis.
 */

import "dotenv/config";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const READER_API_URL = "https://api.reader.dev/v1/read";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_PAGES = 10;
const MAX_CONTENT_LENGTH = 12000;
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["OPENAI_API_KEY", "READER_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`\u274c Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

interface PageAnalysis {
  url: string;
  title: string;
  score: number;
  h1Count: number;
  h2Count: number;
  h3Count: number;
  wordCount: number;
  internalLinks: number;
  externalLinks: number;
  missingAltIndicators: number;
  hasMetaDescription: boolean;
  issues: string[];
  recommendations: string[];
  contentQuality: string;
  keywordDensityNotes: string;
}

interface SEOReport {
  siteUrl: string;
  overallScore: number;
  pagesAnalyzed: number;
  pageAnalyses: PageAnalysis[];
  topIssues: string[];
  quickWins: string[];
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Reader integration
// ---------------------------------------------------------------------------

async function readPage(url: string): Promise<string | null> {
  /**Read a page via Reader and return its markdown content.*/
  try {
    const response = await fetch(READER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.READER_API_KEY}`,
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const respData = await response.json() as { data: { markdown: string } };
    const content = respData.data.markdown || "";
    if (!content || content.trim().length < 50) return null;
    return content;
  } catch (e) {
    log("   ", `Failed to read ${url}: ${e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

function extractLinks(
  markdown: string,
  baseUrl: string
): { internalUrls: string[]; internalCount: number; externalCount: number } {
  /**Extract links from markdown content.*/
  const parsedBase = new URL(baseUrl);
  const baseDomain = parsedBase.hostname.replace(/^www\./, "");

  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  const internalUrls: string[] = [];
  let internalCount = 0;
  let externalCount = 0;
  const seen = new Set<string>();

  let match;
  while ((match = linkPattern.exec(markdown)) !== null) {
    let href = match[2].trim();
    if (
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("javascript:")
    ) {
      continue;
    }

    // Resolve relative URLs
    if (!href.startsWith("http")) {
      try {
        href = new URL(href, baseUrl).href;
      } catch {
        continue;
      }
    }

    let parsedHref: URL;
    try {
      parsedHref = new URL(href);
    } catch {
      continue;
    }

    const linkDomain = parsedHref.hostname.replace(/^www\./, "");

    if (linkDomain === baseDomain) {
      internalCount++;
      const normalized =
        `${parsedHref.protocol}//${parsedHref.hostname}${parsedHref.pathname}`.replace(
          /\/$/,
          ""
        );
      if (!seen.has(normalized) && normalized !== baseUrl.replace(/\/$/, "")) {
        seen.add(normalized);
        internalUrls.push(normalized);
      }
    } else {
      externalCount++;
    }
  }

  return { internalUrls, internalCount, externalCount };
}

// ---------------------------------------------------------------------------
// Code-based SEO checks
// ---------------------------------------------------------------------------

function analyzePageStructure(markdown: string, url: string): PageAnalysis {
  /**Run code-based SEO checks on markdown content.*/
  const analysis: PageAnalysis = {
    url,
    title: "",
    score: 0,
    h1Count: 0,
    h2Count: 0,
    h3Count: 0,
    wordCount: 0,
    internalLinks: 0,
    externalLinks: 0,
    missingAltIndicators: 0,
    hasMetaDescription: false,
    issues: [],
    recommendations: [],
    contentQuality: "",
    keywordDensityNotes: "",
  };

  // Extract title from first H1
  const lines = markdown.split("\n");
  for (const line of lines.slice(0, 10)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ") && !trimmed.startsWith("## ")) {
      analysis.title = trimmed.slice(2).trim();
      break;
    }
  }

  if (!analysis.title) {
    const titleMatch = markdown.slice(0, 500).match(/Title:\s*(.+)/);
    if (titleMatch) {
      analysis.title = titleMatch[1].trim();
    }
  }

  // Count headings
  analysis.h1Count = (markdown.match(/^# [^#]/gm) || []).length;
  analysis.h2Count = (markdown.match(/^## [^#]/gm) || []).length;
  analysis.h3Count = (markdown.match(/^### [^#]/gm) || []).length;

  // Word count
  let textContent = markdown.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1");
  textContent = textContent.replace(/[#*_`[\]()]/g, "");
  analysis.wordCount = textContent.split(/\s+/).filter((w) => w.length > 0).length;

  // Missing alt text
  analysis.missingAltIndicators = (markdown.match(/!\[\]\(/g) || []).length;

  // Meta description
  analysis.hasMetaDescription =
    /(?:description|meta):\s*.+/i.test(markdown.slice(0, 1000));

  // Build issues
  if (analysis.h1Count === 0) {
    analysis.issues.push("Missing H1 tag");
  } else if (analysis.h1Count > 1) {
    analysis.issues.push(
      `Multiple H1 tags (${analysis.h1Count} found, should be 1)`
    );
  }

  if (analysis.h2Count === 0) {
    analysis.issues.push("No H2 headings found (poor content structure)");
  }

  if (analysis.wordCount < 300) {
    analysis.issues.push(
      `Thin content (${analysis.wordCount} words, aim for 300+)`
    );
  }

  if (!analysis.title) {
    analysis.issues.push("No title tag detected");
  } else if (analysis.title.length > 60) {
    analysis.issues.push(
      `Title too long (${analysis.title.length} chars, aim for under 60)`
    );
  } else if (analysis.title.length < 10) {
    analysis.issues.push(
      `Title too short (${analysis.title.length} chars)`
    );
  }

  if (!analysis.hasMetaDescription) {
    analysis.issues.push("No meta description detected");
  }

  if (analysis.missingAltIndicators > 0) {
    analysis.issues.push(
      `${analysis.missingAltIndicators} image(s) missing alt text`
    );
  }

  return analysis;
}

// ---------------------------------------------------------------------------
// LLM-based qualitative analysis
// ---------------------------------------------------------------------------

interface LLMAnalysisResult {
  content_quality: string;
  content_quality_notes: string;
  keyword_density_notes: string;
  score: number;
  additional_issues: string[];
  recommendations: string[];
}

async function analyzeContentQuality(
  client: OpenAI,
  markdown: string,
  url: string,
  model: string
): Promise<LLMAnalysisResult> {
  /**Use LLM to assess content quality, keyword relevance, and SEO factors.*/
  const truncated = markdown.slice(0, MAX_CONTENT_LENGTH);

  const system = `You are an SEO expert. Analyze the given page content and provide a JSON assessment.

Output ONLY valid JSON with these fields:
- "content_quality": string, one of "excellent", "good", "average", "poor"
- "content_quality_notes": string, 1-2 sentences explaining the rating
- "keyword_density_notes": string, observations about keyword usage and focus
- "score": integer 1-100, overall SEO score for this page
- "additional_issues": array of strings, any SEO issues not caught by structural checks
- "recommendations": array of strings, specific actionable improvements (max 5)

Consider: content relevance, readability, keyword usage, heading structure quality,
internal linking strategy, and overall user experience signals.`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `URL: ${url}\n\nPage content (markdown):\n${truncated}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 1024,
    });

    let result = response.choices[0].message.content || "";
    result = result.trim();
    if (result.startsWith("```")) {
      result = result.split("\n").slice(1).join("\n").replace(/```\s*$/, "");
    }

    return JSON.parse(result) as LLMAnalysisResult;
  } catch (e) {
    log("   ", `LLM analysis failed for ${url}: ${e}`);
    return {
      content_quality: "unknown",
      content_quality_notes: "Analysis failed",
      keyword_density_notes: "",
      score: 50,
      additional_issues: [],
      recommendations: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

interface ReportSummary {
  overall_score: number;
  top_issues: string[];
  quick_wins: string[];
  recommendations: string[];
}

async function generateReportSummary(
  client: OpenAI,
  report: SEOReport,
  model: string
): Promise<void> {
  /**Use LLM to generate top issues, quick wins, and overall recommendations.*/
  const pagesSummary = report.pageAnalyses.map((p) => ({
    url: p.url,
    title: p.title,
    score: p.score,
    issues: p.issues,
    word_count: p.wordCount,
    h1_count: p.h1Count,
    h2_count: p.h2Count,
    internal_links: p.internalLinks,
    external_links: p.externalLinks,
  }));

  const system = `You are an SEO consultant producing the executive summary for an SEO audit report.
Given page-by-page analysis data, produce a JSON object with:
- "overall_score": integer 1-100, weighted average considering page importance
- "top_issues": array of 5-8 strings, most impactful SEO issues found (prioritized by severity)
- "quick_wins": array of 3-5 strings, easy fixes that would improve SEO quickly
- "recommendations": array of 5-8 strings, strategic recommendations for long-term SEO improvement

Be specific and actionable. Reference actual pages and data from the analysis.
Output ONLY valid JSON.`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Site: ${report.siteUrl}\n\nPage analyses:\n${JSON.stringify(pagesSummary, null, 2)}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 2048,
    });

    let result = response.choices[0].message.content || "";
    result = result.trim();
    if (result.startsWith("```")) {
      result = result.split("\n").slice(1).join("\n").replace(/```\s*$/, "");
    }

    const summary = JSON.parse(result) as ReportSummary;
    report.overallScore = summary.overall_score || 50;
    report.topIssues = summary.top_issues || [];
    report.quickWins = summary.quick_wins || [];
    report.recommendations = summary.recommendations || [];
  } catch (e) {
    log("\u26a0\ufe0f", `Summary generation failed: ${e}`);
    const scores = report.pageAnalyses
      .map((p) => p.score)
      .filter((s) => s > 0);
    report.overallScore = scores.length
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 50;
    const allIssues: string[] = [];
    for (const p of report.pageAnalyses) {
      allIssues.push(...p.issues);
    }
    report.topIssues = [...new Set(allIssues)].slice(0, 8);
  }
}

function formatReport(report: SEOReport): string {
  /**Format the SEO report as readable markdown.*/
  const lines: string[] = [];

  lines.push(`# SEO Audit Report: ${report.siteUrl}`);
  lines.push("");
  lines.push(`**Overall Score: ${report.overallScore}/100**`);
  lines.push(`**Pages Analyzed: ${report.pagesAnalyzed}**`);
  lines.push("");

  // Top Issues
  lines.push("## Top Issues (Prioritized)");
  lines.push("");
  report.topIssues.forEach((issue, i) => {
    lines.push(`${i + 1}. ${issue}`);
  });
  lines.push("");

  // Quick Wins
  lines.push("## Quick Wins");
  lines.push("");
  report.quickWins.forEach((win, i) => {
    lines.push(`${i + 1}. ${win}`);
  });
  lines.push("");

  // Page-by-Page Analysis
  lines.push("## Page-by-Page Analysis");
  lines.push("");
  for (const page of report.pageAnalyses) {
    lines.push(`### ${page.title || page.url}`);
    lines.push(`**URL:** ${page.url}`);
    lines.push(`**Score:** ${page.score}/100`);
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Word Count | ${page.wordCount} |`);
    lines.push(`| H1 Tags | ${page.h1Count} |`);
    lines.push(`| H2 Tags | ${page.h2Count} |`);
    lines.push(`| H3 Tags | ${page.h3Count} |`);
    lines.push(`| Internal Links | ${page.internalLinks} |`);
    lines.push(`| External Links | ${page.externalLinks} |`);
    lines.push(
      `| Meta Description | ${page.hasMetaDescription ? "Yes" : "No"} |`
    );
    lines.push("");

    if (page.contentQuality) {
      lines.push(`**Content Quality:** ${page.contentQuality}`);
      lines.push("");
    }

    if (page.keywordDensityNotes) {
      lines.push(`**Keyword Notes:** ${page.keywordDensityNotes}`);
      lines.push("");
    }

    if (page.issues.length > 0) {
      lines.push("**Issues:**");
      for (const issue of page.issues) {
        lines.push(`- ${issue}`);
      }
      lines.push("");
    }

    if (page.recommendations.length > 0) {
      lines.push("**Recommendations:**");
      for (const rec of page.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push("");
    }
  }

  // Strategic Recommendations
  lines.push("## Strategic Recommendations");
  lines.push("");
  report.recommendations.forEach((rec, i) => {
    lines.push(`${i + 1}. ${rec}`);
  });
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main audit pipeline
// ---------------------------------------------------------------------------

async function runAudit(siteUrl: string, maxPages: number): Promise<SEOReport> {
  /**Run the full SEO audit pipeline.*/
  const openaiClient = new OpenAI();
  const model = process.env.MODEL || DEFAULT_MODEL;

  // Normalize URL
  if (!siteUrl.startsWith("http")) {
    siteUrl = `https://${siteUrl}`;
  }

  const report: SEOReport = {
    siteUrl,
    overallScore: 0,
    pagesAnalyzed: 0,
    pageAnalyses: [],
    topIssues: [],
    quickWins: [],
    recommendations: [],
  };

  const startTime = Date.now();

  // Phase 1: Read the main page
  log("\ud83c\udf10", `Reading main page: ${siteUrl}`);
  const mainContentResult = await readPage(siteUrl);
  if (!mainContentResult) {
    log("\u274c", "Failed to read the main page. Check the URL and try again.");
    process.exit(1);
  }
  const mainContent: string = mainContentResult;

  log("\u2705", `Main page loaded (${mainContent.length} chars)`);

  // Phase 2: Extract internal links
  log("\ud83d\udd17", "Extracting internal links...");
  const { internalUrls } = extractLinks(mainContent, siteUrl);
  const pagesToCrawl = [siteUrl, ...internalUrls.slice(0, maxPages - 1)];
  log(
    "   ",
    `Found ${internalUrls.length} internal links, will analyze ${pagesToCrawl.length} pages`
  );
  console.log();

  // Phase 3: Read all pages in parallel
  log("\ud83d\udce5", "Reading pages via Reader...");

  const readResults = await Promise.all(
    pagesToCrawl.map(async (url): Promise<[string, string | null]> => {
      if (url === siteUrl) return [url, mainContent];
      const content = await readPage(url);
      return [url, content];
    })
  );

  const pageContents: Array<[string, string]> = [];
  for (const [url, content] of readResults) {
    if (content) {
      pageContents.push([url, content]);
      log("   ", `Loaded: ${url}`);
    } else {
      log("   ", `Skipped: ${url} (no content)`);
    }
  }
  console.log();

  // Phase 4: Structural analysis (code-based, fast)
  log("\ud83d\udd0d", "Running structural SEO checks...");
  const analyses: PageAnalysis[] = [];
  for (const [url, content] of pageContents) {
    const analysis = analyzePageStructure(content, url);
    const linkInfo = extractLinks(content, siteUrl);
    analysis.internalLinks = linkInfo.internalCount;
    analysis.externalLinks = linkInfo.externalCount;
    analyses.push(analysis);
    log("   ", `Checked: ${analysis.title || url}`);
  }
  console.log();

  // Phase 5: LLM qualitative analysis (parallel)
  log("\ud83e\udde0", "Running AI content analysis...");
  const llmResults = await Promise.all(
    pageContents.map(([url, content]) =>
      analyzeContentQuality(openaiClient, content, url, model)
    )
  );

  for (let idx = 0; idx < analyses.length; idx++) {
    const analysis = analyses[idx];
    const llmResult = llmResults[idx];
    analysis.score = llmResult.score || 50;
    analysis.contentQuality = llmResult.content_quality_notes || "";
    analysis.keywordDensityNotes = llmResult.keyword_density_notes || "";
    analysis.issues.push(...(llmResult.additional_issues || []));
    analysis.recommendations = llmResult.recommendations || [];
    log("   ", `Analyzed: ${analysis.title || analysis.url} (score: ${analysis.score})`);
  }
  console.log();

  // Phase 6: Generate executive summary
  log("\ud83d\udcca", "Generating executive summary...");
  report.pageAnalyses = analyses;
  report.pagesAnalyzed = analyses.length;
  await generateReportSummary(openaiClient, report, model);

  const elapsed = (Date.now() - startTime) / 1000;
  log("\u23f1\ufe0f", `Audit completed in ${elapsed.toFixed(1)}s`);

  return report;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const args = process.argv.slice(2);
  let outputFile: string | null = null;
  let maxPages = MAX_PAGES;
  const urlParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && i + 1 < args.length) {
      outputFile = args[i + 1];
      i++;
    } else if (args[i] === "--pages" && i + 1 < args.length) {
      maxPages = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx index.ts [URL] [--output FILE] [--pages N]");
      console.log();
      console.log("Arguments:");
      console.log("  URL             Website URL to audit (prompts if not given)");
      console.log("  --output FILE   Save report to a file");
      console.log("  --pages N       Max pages to crawl (default: 10)");
      console.log();
      console.log("Examples:");
      console.log('  npx tsx index.ts "https://example.com"');
      console.log(
        '  npx tsx index.ts "https://example.com" --output report.md --pages 5'
      );
      process.exit(0);
    } else {
      urlParts.push(args[i]);
    }
  }

  let siteUrl = urlParts.join(" ");
  if (!siteUrl) {
    process.stdout.write("\ud83c\udf10 Enter the website URL to audit: ");
    siteUrl = await new Promise<string>((resolve) => {
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        input += String(chunk);
        if (input.includes("\n")) {
          process.stdin.pause();
          resolve(input.trim());
        }
      });
      process.stdin.resume();
    });
  }

  if (!siteUrl.trim()) {
    console.error("\u274c Please provide a website URL.");
    process.exit(1);
  }

  log("\ud83d\ude80", "Starting SEO audit agent...");
  log("\ud83c\udf10", `Target: ${siteUrl}`);
  log("\ud83d\udcc4", `Max pages: ${maxPages}`);
  console.log();

  try {
    const report = await runAudit(siteUrl, maxPages);
    const formatted = formatReport(report);

    console.log("\n" + "=".repeat(60));
    log("\u2705", "SEO audit complete!\n");
    console.log(formatted);

    if (outputFile) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputFile, formatted, "utf8");
      log("\ud83d\udcbe", `Report saved to ${outputFile}`);
    }
  } catch (e) {
    console.error(`\n\u274c Error: ${e}`);
    process.exit(1);
  }
}

main().catch(console.error);
