/**
 * MCP Client Agent -- Connects to multiple MCP servers and routes tool calls.
 *
 * Demonstrates the MCP client pattern: discovering tools from multiple servers,
 * presenting a unified tool list to the LLM, and routing calls to the correct
 * server based on tool name.
 *
 * This example uses simulated MCP servers (in-process tool providers) for
 * portability. The pattern is identical to connecting to real MCP servers
 * over stdio or SSE -- swap the simulated servers for real subprocess-based
 * connections to make it production-ready.
 */

import "dotenv/config";
import OpenAI from "openai";
import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Validation and logging
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const required = ["OPENAI_API_KEY"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("   Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }
}

function log(emoji: string, message: string): void {
  console.log(`${emoji} ${message}`);
}

// ---------------------------------------------------------------------------
// MCP Server interface and types
// ---------------------------------------------------------------------------

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface MCPServer {
  readonly name: string;
  tools(): ToolDefinition[];
  execute(toolName: string, args: Record<string, unknown>): Promise<string>;
}

// ---------------------------------------------------------------------------
// Simulated MCP Server: Database
// ---------------------------------------------------------------------------

interface TableRow {
  [key: string]: string | number;
}

interface TableData {
  columns: string[];
  rows: TableRow[];
}

const TABLES: Record<string, TableData> = {
  users: {
    columns: ["id", "name", "email", "role", "created_at"],
    rows: [
      { id: 1, name: "Alice Chen", email: "alice@example.com", role: "admin", created_at: "2024-01-15" },
      { id: 2, name: "Bob Martinez", email: "bob@example.com", role: "editor", created_at: "2024-02-20" },
      { id: 3, name: "Carol Johnson", email: "carol@example.com", role: "viewer", created_at: "2024-03-10" },
      { id: 4, name: "David Kim", email: "david@example.com", role: "editor", created_at: "2024-04-05" },
      { id: 5, name: "Eve Wilson", email: "eve@example.com", role: "admin", created_at: "2024-05-01" },
    ],
  },
  projects: {
    columns: ["id", "name", "owner_id", "status", "budget"],
    rows: [
      { id: 1, name: "Website Redesign", owner_id: 1, status: "active", budget: 50000 },
      { id: 2, name: "Mobile App", owner_id: 2, status: "active", budget: 120000 },
      { id: 3, name: "Data Pipeline", owner_id: 1, status: "completed", budget: 35000 },
      { id: 4, name: "API Gateway", owner_id: 4, status: "planning", budget: 25000 },
    ],
  },
  tasks: {
    columns: ["id", "project_id", "title", "assignee_id", "status", "priority"],
    rows: [
      { id: 1, project_id: 1, title: "Design homepage mockup", assignee_id: 2, status: "done", priority: "high" },
      { id: 2, project_id: 1, title: "Implement responsive layout", assignee_id: 3, status: "in_progress", priority: "high" },
      { id: 3, project_id: 2, title: "Set up React Native project", assignee_id: 4, status: "done", priority: "medium" },
      { id: 4, project_id: 2, title: "Build authentication flow", assignee_id: 2, status: "in_progress", priority: "high" },
      { id: 5, project_id: 3, title: "Write ETL scripts", assignee_id: 1, status: "done", priority: "medium" },
      { id: 6, project_id: 4, title: "Draft API specification", assignee_id: 4, status: "todo", priority: "low" },
    ],
  },
};

class DatabaseServer implements MCPServer {
  readonly name = "database";

  tools(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "query_db",
          description:
            "Run a SQL-like query against the database. " +
            "Supports SELECT with WHERE, ORDER BY, and LIMIT clauses. " +
            "Tables: users, projects, tasks. " +
            "Example: SELECT * FROM users WHERE role = 'admin'",
          parameters: {
            type: "object",
            properties: {
              sql: {
                type: "string",
                description: "The SQL query to execute (read-only).",
              },
            },
            required: ["sql"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_tables",
          description: "List all available database tables with their column names.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
    ];
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (toolName === "list_tables") {
      return this.listTables();
    }
    if (toolName === "query_db") {
      return this.queryDb(args.sql as string ?? "");
    }
    return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }

  private listTables(): string {
    const result: Record<string, { columns: string[]; row_count: number }> = {};
    for (const [tableName, tableData] of Object.entries(TABLES)) {
      result[tableName] = {
        columns: tableData.columns,
        row_count: tableData.rows.length,
      };
    }
    return JSON.stringify(result, null, 2);
  }

  private queryDb(sql: string): string {
    const sqlLower = sql.trim().toLowerCase();

    if (!sqlLower.startsWith("select")) {
      return JSON.stringify({ error: "Only SELECT queries are supported (read-only)." });
    }

    const tableName = this.extractTableName(sqlLower);
    if (!TABLES[tableName]) {
      const available = Object.keys(TABLES).join(", ");
      return JSON.stringify({ error: `Table '${tableName}' not found. Available: ${available}` });
    }

    let rows = [...TABLES[tableName].rows];
    rows = this.applyWhere(sqlLower, rows);

    const limit = this.extractLimit(sqlLower);
    if (limit !== null) {
      rows = rows.slice(0, limit);
    }

    return JSON.stringify({ table: tableName, rows, count: rows.length }, null, 2);
  }

  private extractTableName(sql: string): string {
    const parts = sql.split("from");
    if (parts.length < 2) return "";
    const afterFrom = parts[1].trim().split(/\s+/)[0];
    return afterFrom.replace(/;$/, "").trim();
  }

  private applyWhere(sql: string, rows: TableRow[]): TableRow[] {
    if (!sql.includes("where")) return rows;

    let whereClause = sql.split("where")[1].trim();
    for (const keyword of ["order by", "limit", "group by"]) {
      if (whereClause.includes(keyword)) {
        whereClause = whereClause.split(keyword)[0].trim();
      }
    }

    let filtered = rows;
    const conditions = whereClause.split(" and ").map((c) => c.trim());

    for (const condition of conditions) {
      if (condition.includes("=")) {
        const eqParts = condition.split("=");
        const col = eqParts[0].trim();
        const val = eqParts[1].trim().replace(/^['"]|['"]$/g, "");
        const valNum = parseInt(val, 10);

        if (!isNaN(valNum) && String(valNum) === val) {
          filtered = filtered.filter((r) => r[col] === valNum);
        } else {
          filtered = filtered.filter((r) => String(r[col] ?? "") === val);
        }
      }
    }

    return filtered;
  }

  private extractLimit(sql: string): number | null {
    if (!sql.includes("limit")) return null;
    const parts = sql.split("limit");
    if (parts.length < 2) return null;
    const num = parseInt(parts[1].trim().split(/\s+/)[0].replace(/;$/, ""), 10);
    return isNaN(num) ? null : num;
  }
}

// ---------------------------------------------------------------------------
// Simulated MCP Server: GitHub
// ---------------------------------------------------------------------------

interface RepoData {
  name: string;
  owner: string;
  description: string;
  stars: number;
  language: string;
  open_issues: number;
}

interface IssueData {
  number: number;
  title: string;
  state: string;
  labels: string[];
  author: string;
}

const REPOS: RepoData[] = [
  { name: "web-platform", owner: "acme-corp", description: "Main web platform monorepo", stars: 342, language: "TypeScript", open_issues: 23 },
  { name: "ml-pipeline", owner: "acme-corp", description: "Machine learning data pipeline", stars: 156, language: "Python", open_issues: 8 },
  { name: "design-system", owner: "acme-corp", description: "Shared UI component library", stars: 89, language: "TypeScript", open_issues: 12 },
  { name: "infra-terraform", owner: "acme-corp", description: "Infrastructure as code configs", stars: 45, language: "HCL", open_issues: 3 },
  { name: "api-gateway", owner: "acme-corp", description: "API gateway and routing service", stars: 201, language: "Go", open_issues: 15 },
];

const ISSUES: Record<string, IssueData[]> = {
  "acme-corp/web-platform": [
    { number: 142, title: "Database connection pool exhaustion under load", state: "open", labels: ["bug", "database", "critical"], author: "alice-chen" },
    { number: 138, title: "Migration 047 fails on PostgreSQL 16", state: "open", labels: ["bug", "database"], author: "bob-martinez" },
    { number: 135, title: "Add dark mode support", state: "open", labels: ["enhancement", "ui"], author: "carol-j" },
    { number: 130, title: "Fix memory leak in WebSocket handler", state: "closed", labels: ["bug", "performance"], author: "david-kim" },
    { number: 127, title: "Upgrade to React 19", state: "open", labels: ["enhancement", "dependencies"], author: "eve-w" },
  ],
  "acme-corp/ml-pipeline": [
    { number: 56, title: "Model training OOM on large datasets", state: "open", labels: ["bug", "performance"], author: "alice-chen" },
    { number: 52, title: "Add support for Parquet input format", state: "open", labels: ["enhancement"], author: "bob-martinez" },
    { number: 48, title: "Fix data validation for null values", state: "closed", labels: ["bug"], author: "carol-j" },
  ],
  "acme-corp/api-gateway": [
    { number: 89, title: "Rate limiter not respecting per-user quotas", state: "open", labels: ["bug", "critical"], author: "david-kim" },
    { number: 85, title: "Add health check endpoint", state: "open", labels: ["enhancement"], author: "eve-w" },
    { number: 80, title: "TLS certificate rotation automation", state: "open", labels: ["enhancement", "security"], author: "alice-chen" },
  ],
};

class GitHubServer implements MCPServer {
  readonly name = "github";

  tools(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "search_repos",
          description:
            "Search for repositories by keyword. " +
            "Returns matching repos with name, description, stars, and language.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query to match against repo names and descriptions.",
              },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_issues",
          description:
            "List issues for a repository. " +
            "Returns issue number, title, state, labels, and author.",
          parameters: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description: "Repository owner (e.g., 'acme-corp').",
              },
              repo: {
                type: "string",
                description: "Repository name (e.g., 'web-platform').",
              },
              state: {
                type: "string",
                enum: ["open", "closed", "all"],
                description: "Filter by issue state (default: 'all').",
              },
            },
            required: ["owner", "repo"],
          },
        },
      },
    ];
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (toolName === "search_repos") {
      return this.searchRepos(args.query as string ?? "");
    }
    if (toolName === "list_issues") {
      return this.listIssues(
        args.owner as string ?? "",
        args.repo as string ?? "",
        (args.state as string) ?? "all",
      );
    }
    return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }

  private searchRepos(query: string): string {
    const queryLower = query.toLowerCase();
    let matches = REPOS.filter(
      (r) =>
        r.name.toLowerCase().includes(queryLower) ||
        r.description.toLowerCase().includes(queryLower),
    );

    if (matches.length === 0) {
      const words = queryLower.split(/\s+/);
      matches = REPOS.filter((r) =>
        words.some(
          (w) =>
            r.name.toLowerCase().includes(w) ||
            r.description.toLowerCase().includes(w),
        ),
      );
    }

    return JSON.stringify({ results: matches, total_count: matches.length }, null, 2);
  }

  private listIssues(owner: string, repo: string, state: string): string {
    const repoKey = `${owner}/${repo}`;
    const issues = ISSUES[repoKey];

    if (!issues) {
      const available = Object.keys(ISSUES).join(", ");
      return JSON.stringify({
        error: `No issues found for '${repoKey}'.`,
        available_repos: available,
      });
    }

    const filtered = state === "all" ? issues : issues.filter((i) => i.state === state);

    return JSON.stringify({ repo: repoKey, issues: filtered, count: filtered.length }, null, 2);
  }
}

// ---------------------------------------------------------------------------
// MCP Client -- discovers tools and routes calls to the correct server
// ---------------------------------------------------------------------------

class MCPClient {
  private servers: MCPServer[] = [];
  private toolToServer: Map<string, MCPServer> = new Map();
  private allTools: ToolDefinition[] = [];

  /** Connect to multiple MCP servers and discover their tools. */
  async connect(servers: MCPServer[]): Promise<void> {
    this.servers = servers;
    this.toolToServer = new Map();
    this.allTools = [];

    for (const server of servers) {
      const serverTools = server.tools();
      const toolNames: string[] = [];

      for (const tool of serverTools) {
        const fnName = tool.function.name;
        this.toolToServer.set(fnName, server);
        this.allTools.push(tool);
        toolNames.push(fnName);
      }

      log("🔌", `Connected to '${server.name}' server -- tools: ${toolNames.join(", ")}`);
    }

    log("📦", `Total tools available: ${this.allTools.length} from ${servers.length} servers`);
  }

  /** Return the unified tool list for the LLM. */
  getTools(): ToolDefinition[] {
    return this.allTools;
  }

  /** Route a tool call to the correct server and return the result. */
  async executeTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const server = this.toolToServer.get(toolName);
    if (!server) {
      return JSON.stringify({ error: `No server found for tool '${toolName}'` });
    }

    log("🔀", `Routing '${toolName}' to '${server.name}' server`);
    return server.execute(toolName, args);
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a helpful assistant with access to tools from multiple backend services.

You have access to tools from these servers:
1. **Database server** -- query a project management database (users, projects, tasks tables)
2. **GitHub server** -- search repositories and browse issues

When the user asks a question that spans multiple data sources, use tools from
both servers to gather the information you need, then synthesize a clear answer.

Important:
- Always explain which data sources you consulted
- When showing data, format it clearly with tables or lists
- If a query returns no results, say so explicitly
- You can call multiple tools in sequence to build a complete picture`;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

async function runAgent(
  openaiClient: OpenAI,
  mcpClient: MCPClient,
  messages: ChatMessage[],
  model: string,
): Promise<string> {
  const tools =
    mcpClient.getTools() as OpenAI.Chat.Completions.ChatCompletionTool[];

  while (true) {
    const response = await openaiClient.chat.completions.create({
      model,
      messages,
      tools,
      temperature: 0.3,
    });

    const choice = response.choices[0];
    const message = choice.message;

    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content ?? "";
    }

    for (const toolCall of message.tool_calls) {
      const fnName = toolCall.function.name;
      const fnArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

      log("🛠️", `Calling tool: ${fnName}(${JSON.stringify(fnArgs)})`);

      let result: string;
      try {
        result = await mcpClient.executeTool(fnName, fnArgs);
      } catch (err) {
        result = JSON.stringify({ error: String(err) });
        log("❌", `Tool error: ${err}`);
      }

      messages.push({
        role: "tool" as const,
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Interactive chat loop
// ---------------------------------------------------------------------------

async function chatLoop(
  openaiClient: OpenAI,
  mcpClient: MCPClient,
  model: string,
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  console.log();
  console.log("=".repeat(60));
  console.log("  MCP Client Agent");
  console.log("  Type your questions. The agent can use tools from multiple");
  console.log("  servers to answer. Type 'quit' or 'exit' to stop.");
  console.log("=".repeat(60));
  console.log();

  console.log("Try asking:");
  console.log("  - What tables are in the database?");
  console.log("  - Show me all open issues in acme-corp/web-platform");
  console.log("  - Find repos related to 'api' and list their open issues");
  console.log("  - Who are the admins in the database, and what issues have they filed?");
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });

  try {
    while (true) {
      let userInput: string;
      try {
        userInput = (await askQuestion("You: ")).trim();
      } catch {
        console.log("\n👋 Goodbye!");
        break;
      }

      if (!userInput) continue;

      if (userInput.toLowerCase() === "quit" || userInput.toLowerCase() === "exit") {
        console.log("👋 Goodbye!");
        break;
      }

      messages.push({ role: "user", content: userInput });

      console.log();
      try {
        const response = await runAgent(openaiClient, mcpClient, messages, model);
        console.log(`\nAssistant: ${response}\n`);
      } catch (err) {
        console.error(`❌ Error: ${err}`);
        messages.pop();
      }
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const model = process.env.MODEL ?? "gpt-4o-mini";

  log("🚀", "Starting MCP Client Agent...");
  log("🤖", `Model: ${model}`);
  console.log();

  const servers: MCPServer[] = [new DatabaseServer(), new GitHubServer()];

  const mcpClient = new MCPClient();
  await mcpClient.connect(servers);

  const openaiClient = new OpenAI();
  await chatLoop(openaiClient, mcpClient, model);
}

main().catch(console.error);
