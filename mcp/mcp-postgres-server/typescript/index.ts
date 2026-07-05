import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    "ERROR: DATABASE_URL environment variable is required.\n" +
      "Example: DATABASE_URL=postgresql://user:password@localhost:5432/mydb"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// PostgreSQL connection pool
// ---------------------------------------------------------------------------

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  console.error("Unexpected pool error:", err.message);
});

/**
 * Execute a query against the pool with a connection timeout guard.
 */
async function executeQuery(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult> {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// SQL safety helpers
// ---------------------------------------------------------------------------

const BLOCKED_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "CREATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "EXECUTE",
];

/**
 * Returns true when the SQL string is a read-only SELECT statement.
 * This is a conservative check that blocks any statement containing
 * mutation keywords outside of string literals.
 */
function isReadOnlyQuery(sql: string): boolean {
  // Strip string literals so keywords inside quotes are not flagged.
  const stripped = sql.replace(/'[^']*'/g, "");
  const upper = stripped.toUpperCase();

  for (const keyword of BLOCKED_KEYWORDS) {
    // Match keyword as a whole word using word boundaries.
    const regex = new RegExp(`\\b${keyword}\\b`);
    if (regex.test(upper)) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "postgres-server",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: query
// ---------------------------------------------------------------------------

server.tool(
  "query",
  "Execute a read-only SQL query against the database. Only SELECT statements " +
    "are allowed. INSERT, UPDATE, DELETE, DROP, and other mutation statements " +
    "are blocked for safety.",
  {
    sql: z.string().describe("The SQL SELECT query to execute"),
  },
  async ({ sql }) => {
    if (!isReadOnlyQuery(sql)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Only read-only SELECT queries are allowed. " +
              "Use the insert_row tool for inserts, or connect directly " +
              "for other mutation operations.",
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await executeQuery(sql);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                columns: result.fields.map((f) => f.name),
                rows: result.rows,
                rowCount: result.rowCount,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Query error: ${message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: list_tables
// ---------------------------------------------------------------------------

server.tool(
  "list_tables",
  "List all user-created tables in the public schema of the database.",
  {},
  async () => {
    try {
      const result = await executeQuery(
        `SELECT table_name, table_type
         FROM information_schema.tables
         WHERE table_schema = 'public'
         ORDER BY table_name`
      );

      if (result.rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No tables found in the public schema.",
            },
          ],
        };
      }

      const tables = result.rows.map(
        (r: { table_name: string; table_type: string }) =>
          `${r.table_name} (${r.table_type})`
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Tables in public schema:\n\n${tables.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing tables: ${message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: describe_table
// ---------------------------------------------------------------------------

server.tool(
  "describe_table",
  "Describe the columns, data types, and constraints of a specific table.",
  {
    table_name: z
      .string()
      .describe("Name of the table to describe")
      .refine((val) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val), {
        message:
          "Invalid table name. Only alphanumeric characters and underscores are allowed.",
      }),
  },
  async ({ table_name }) => {
    try {
      // Column information
      const colResult = await executeQuery(
        `SELECT
           c.column_name,
           c.data_type,
           c.character_maximum_length,
           c.numeric_precision,
           c.numeric_scale,
           c.is_nullable,
           c.column_default
         FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.table_name = $1
         ORDER BY c.ordinal_position`,
        [table_name]
      );

      if (colResult.rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Table "${table_name}" not found in the public schema.`,
            },
          ],
          isError: true,
        };
      }

      // Constraint information
      const constraintResult = await executeQuery(
        `SELECT
           tc.constraint_name,
           tc.constraint_type,
           kcu.column_name,
           ccu.table_name AS foreign_table,
           ccu.column_name AS foreign_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         LEFT JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
           AND tc.table_schema = ccu.table_schema
         WHERE tc.table_schema = 'public'
           AND tc.table_name = $1
         ORDER BY tc.constraint_type, tc.constraint_name`,
        [table_name]
      );

      // Index information
      const indexResult = await executeQuery(
        `SELECT
           indexname,
           indexdef
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = $1
         ORDER BY indexname`,
        [table_name]
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                table: table_name,
                columns: colResult.rows,
                constraints: constraintResult.rows,
                indexes: indexResult.rows,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Error describing table: ${message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: insert_row
// ---------------------------------------------------------------------------

server.tool(
  "insert_row",
  "Insert a single row into a table. Uses parameterized queries to prevent " +
    "SQL injection. The data object keys must match column names exactly.",
  {
    table: z
      .string()
      .describe("Name of the table to insert into")
      .refine((val) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val), {
        message:
          "Invalid table name. Only alphanumeric characters and underscores are allowed.",
      }),
    data: z
      .record(z.unknown())
      .describe(
        "Object mapping column names to values. " +
          "Keys must be valid column names (alphanumeric and underscores)."
      ),
  },
  async ({ table, data }) => {
    const columns = Object.keys(data);

    // Validate column names to prevent injection through keys.
    for (const col of columns) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Invalid column name "${col}". ` +
                "Only alphanumeric characters and underscores are allowed.",
            },
          ],
          isError: true,
        };
      }
    }

    if (columns.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: data object must contain at least one column.",
          },
        ],
        isError: true,
      };
    }

    const values = Object.values(data);
    const placeholders = columns.map((_, i) => `$${i + 1}`);

    const sql =
      `INSERT INTO ${table} (${columns.join(", ")}) ` +
      `VALUES (${placeholders.join(", ")}) ` +
      `RETURNING *`;

    try {
      const result = await executeQuery(sql, values as unknown[]);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                inserted: result.rows[0],
                rowCount: result.rowCount,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `Insert error: ${message}` },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Resources: expose each table's schema as an MCP resource
// ---------------------------------------------------------------------------

server.resource(
  "table-schema",
  "postgres://tables/{table_name}/schema",
  { description: "Schema information for a specific table" },
  async (uri) => {
    const tableName = uri.pathname.split("/").filter(Boolean)[1];

    if (!tableName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ error: "Invalid table name" }),
          },
        ],
      };
    }

    try {
      const result = await executeQuery(
        `SELECT
           column_name,
           data_type,
           is_nullable,
           column_default
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1
         ORDER BY ordinal_position`,
        [tableName]
      );

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { table: tableName, columns: result.rows },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ error: message }),
          },
        ],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Verify database connectivity before starting the server.
  try {
    await executeQuery("SELECT 1");
    console.error("Connected to PostgreSQL successfully.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to connect to PostgreSQL: ${message}`);
    console.error("Ensure DATABASE_URL is set and the database is running.");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Postgres Server running on stdio transport.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
