#!/usr/bin/env node

/**
 * AINative Postgres MCP Server
 *
 * Zero-config PostgreSQL MCP server with auto-provisioning.
 * Drop-in replacement for @modelcontextprotocol/server-postgres that
 * auto-provisions a managed Postgres instance via ZeroDB on first run.
 *
 * Tools:
 *   query          — Execute read-only SQL queries
 *   describe_table — Get table schema (columns, types, constraints)
 *   list_tables    — List all tables in the database
 *   create_table   — Create a new table with SQL DDL
 *   insert         — Insert rows into a table
 *
 * On startup:
 *   1. Check for DATABASE_URL env var
 *   2. If missing, auto-provision via ZeroDB Postgres API
 *   3. Connect using pg (node-postgres)
 *   4. Enable pgvector extension automatically
 *
 * Usage:
 *   npx ainative-postgres-mcp                              # Auto-provisions on first run
 *   DATABASE_URL=postgres://... npx ainative-postgres-mcp   # Use existing database
 *
 * Refs #3947
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import pg from 'pg';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('./package.json');

dotenv.config();

const SERVER_NAME = 'ainative-postgres-mcp';
const ZERODB_API_URL = process.env.ZERODB_API_URL || 'https://api.ainative.studio';

// ─────────────────────────────────────────────────────────────────
// Auto-provisioning: get or create a managed Postgres instance
// ─────────────────────────────────────────────────────────────────

async function httpPost(url, body, headers = {}) {
  const https = await import('https');
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.default.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(responseData)); }
          catch { resolve(responseData); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function httpGet(url, headers = {}) {
  const https = await import('https');
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.default.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function loadSavedConfig() {
  const { existsSync, readFileSync } = await import('fs');
  const { join } = await import('path');
  const os = await import('os');

  const configPath = join(os.default.homedir(), '.ainative', 'postgres-config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.database_url) return config;
    } catch (_) {}
  }
  return null;
}

async function saveConfig(config) {
  const { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } = await import('fs');
  const { join } = await import('path');
  const os = await import('os');

  // Save to ~/.ainative/postgres-config.json
  const ainativeDir = join(os.default.homedir(), '.ainative');
  if (!existsSync(ainativeDir)) mkdirSync(ainativeDir, { recursive: true });
  const configPath = join(ainativeDir, 'postgres-config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  // Append to .env in cwd
  const envPath = join(process.cwd(), '.env');
  const envBlock = `\n# PostgreSQL (auto-provisioned by ainative-postgres-mcp)\nDATABASE_URL=${config.database_url}\nZERODB_API_KEY=${config.api_key}\nZERODB_PROJECT_ID=${config.project_id}\n`;
  if (existsSync(envPath)) {
    if (!readFileSync(envPath, 'utf-8').includes('DATABASE_URL')) {
      appendFileSync(envPath, envBlock);
    }
  } else {
    writeFileSync(envPath, envBlock.trimStart());
  }

  // Write .mcp.json
  const mcpPath = join(process.cwd(), '.mcp.json');
  const mcpEntry = {
    'ainative-postgres': {
      command: 'npx',
      args: ['-y', 'ainative-postgres-mcp'],
      env: {
        DATABASE_URL: config.database_url,
        ZERODB_API_KEY: config.api_key,
        ZERODB_PROJECT_ID: config.project_id
      }
    }
  };
  let existing = {};
  if (existsSync(mcpPath)) { try { existing = JSON.parse(readFileSync(mcpPath, 'utf-8')); } catch (_) {} }
  writeFileSync(mcpPath, JSON.stringify({
    ...existing,
    mcpServers: { ...(existing.mcpServers || {}), ...mcpEntry }
  }, null, 2) + '\n');
}

async function autoProvision() {
  console.error('\n  No DATABASE_URL found — auto-provisioning a managed PostgreSQL instance...\n');

  // Step 1: Get API key via instant-db
  let apiKey, projectId;
  const existingKey = process.env.ZERODB_API_KEY;
  const existingProject = process.env.ZERODB_PROJECT_ID;

  if (existingKey && existingProject) {
    apiKey = existingKey;
    projectId = existingProject;
    console.error('  Using existing ZeroDB credentials');
  } else {
    console.error('  Step 1/2: Creating free ZeroDB account...');
    const creds = await httpPost(`${ZERODB_API_URL}/api/v1/public/instant-db`, {
      agree_terms: true
    });
    apiKey = creds.api_key;
    projectId = creds.project_id;
    console.error(`  Account created: ${projectId}`);
    if (creds.claim_url) {
      console.error(`\n  *** Claim your account: ${creds.claim_url} ***\n`);
    }
  }

  // Step 2: Provision Postgres instance
  console.error('  Step 2/2: Provisioning PostgreSQL instance...');
  const authHeaders = {
    'X-API-Key': apiKey,
    'X-Project-ID': projectId
  };

  const pgResult = await httpPost(
    `${ZERODB_API_URL}/api/v1/zerodb/postgres/provision`,
    { enable_pgvector: true },
    authHeaders
  );

  const databaseUrl = pgResult.connection_string || pgResult.database_url || pgResult.dsn;
  if (!databaseUrl) {
    throw new Error('Provisioning succeeded but no connection string returned');
  }

  const config = {
    database_url: databaseUrl,
    api_key: apiKey,
    project_id: projectId,
    provisioned_at: new Date().toISOString()
  };

  await saveConfig(config);

  console.error('  PostgreSQL provisioned successfully!');
  console.error(`  Connection saved to ~/.ainative/postgres-config.json`);
  console.error(`  Also saved to .env and .mcp.json\n`);

  return databaseUrl;
}

async function resolveDatabaseUrl() {
  // 1. Check env var
  if (process.env.DATABASE_URL) {
    console.error('  Using DATABASE_URL from environment');
    return process.env.DATABASE_URL;
  }

  // 2. Check saved config
  const saved = await loadSavedConfig();
  if (saved?.database_url) {
    console.error('  Using saved config from ~/.ainative/postgres-config.json');
    return saved.database_url;
  }

  // 3. Scan .mcp.json for credentials
  const { existsSync, readFileSync } = await import('fs');
  const { join, dirname } = await import('path');

  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const mcpPath = join(dir, '.mcp.json');
    if (existsSync(mcpPath)) {
      try {
        const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8'));
        const servers = mcp.mcpServers || {};
        const pgServer = servers['ainative-postgres']
          || servers['postgres']
          || servers['postgres-mcp']
          || Object.values(servers).find(s => (s.args || []).join(' ').includes('postgres'));
        const env = pgServer?.env;
        if (env?.DATABASE_URL) {
          console.error(`  Loaded DATABASE_URL from ${mcpPath}`);
          return env.DATABASE_URL;
        }
      } catch (_) {}
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 4. Auto-provision
  return await autoProvision();
}

// ─────────────────────────────────────────────────────────────────
// Postgres Client Manager
// ─────────────────────────────────────────────────────────────────

class PostgresManager {
  constructor(databaseUrl) {
    this.databaseUrl = databaseUrl;
    this.pool = null;
  }

  async connect() {
    this.pool = new pg.default.Pool({
      connectionString: this.databaseUrl,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: this.databaseUrl.includes('sslmode=require') || this.databaseUrl.includes('ssl=true')
        ? { rejectUnauthorized: false }
        : undefined
    });

    // Test connection
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  }

  async enablePgvector() {
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      return true;
    } catch (err) {
      // pgvector may not be available — non-fatal
      console.error(`  pgvector extension: ${err.message.includes('could not') ? 'not available' : err.message}`);
      return false;
    }
  }

  async query(sql) {
    const client = await this.pool.connect();
    try {
      // Execute in a read-only transaction for safety
      await client.query('BEGIN TRANSACTION READ ONLY');
      const result = await client.query(sql);
      await client.query('COMMIT');
      return {
        rows: result.rows,
        rowCount: result.rowCount,
        fields: result.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID }))
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async execute(sql, params = []) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, params);
      return {
        rows: result.rows,
        rowCount: result.rowCount,
        command: result.command
      };
    } catch (err) {
      throw err;
    } finally {
      client.release();
    }
  }

  async listTables() {
    const result = await this.pool.query(`
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `);
    return result.rows;
  }

  async describeTable(tableName) {
    // Parse schema.table if provided
    let schema = 'public';
    let table = tableName;
    if (tableName.includes('.')) {
      [schema, table] = tableName.split('.');
    }

    const columnsResult = await this.pool.query(`
      SELECT
        c.column_name,
        c.data_type,
        c.character_maximum_length,
        c.is_nullable,
        c.column_default,
        c.udt_name
      FROM information_schema.columns c
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position
    `, [schema, table]);

    const constraintsResult = await this.pool.query(`
      SELECT
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = $1 AND tc.table_name = $2
      ORDER BY tc.constraint_type, kcu.column_name
    `, [schema, table]);

    const indexesResult = await this.pool.query(`
      SELECT
        indexname,
        indexdef
      FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2
      ORDER BY indexname
    `, [schema, table]);

    return {
      table: tableName,
      schema: schema,
      columns: columnsResult.rows,
      constraints: constraintsResult.rows,
      indexes: indexesResult.rows
    };
  }

  async createTable(sql) {
    // Validate it's a CREATE TABLE statement
    const normalized = sql.trim().toUpperCase();
    if (!normalized.startsWith('CREATE TABLE') && !normalized.startsWith('CREATE UNLOGGED TABLE')) {
      throw new Error('SQL must be a CREATE TABLE statement');
    }
    return await this.execute(sql);
  }

  async insert(table, rows) {
    if (!rows || rows.length === 0) {
      throw new Error('No rows provided');
    }

    const columns = Object.keys(rows[0]);
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const row of rows) {
      const rowPlaceholders = [];
      for (const col of columns) {
        values.push(row[col] !== undefined ? row[col] : null);
        rowPlaceholders.push(`$${paramIndex++}`);
      }
      placeholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    // Sanitize table name — allow schema.table format
    const safeTable = table.split('.').map(part => `"${part.replace(/"/g, '""')}"`).join('.');
    const safeColumns = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');

    const sql = `INSERT INTO ${safeTable} (${safeColumns}) VALUES ${placeholders.join(', ')} RETURNING *`;
    return await this.execute(sql, values);
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'query',
    description: 'Execute a read-only SQL query against the connected PostgreSQL database. All queries run inside a READ ONLY transaction for safety. Use this for SELECT, EXPLAIN, and other read operations.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL query to execute (read-only)'
        }
      },
      required: ['sql']
    }
  },
  {
    name: 'list_tables',
    description: 'List all tables in the connected PostgreSQL database, including schema, table name, and type (BASE TABLE or VIEW).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'describe_table',
    description: 'Get the full schema of a table including columns (name, type, nullable, default), constraints (primary key, foreign key, unique), and indexes. Supports schema.table format.',
    inputSchema: {
      type: 'object',
      properties: {
        table_name: {
          type: 'string',
          description: 'The table name to describe. Use "schema.table" for non-public schemas.'
        }
      },
      required: ['table_name']
    }
  },
  {
    name: 'create_table',
    description: 'Create a new table in the database using a SQL CREATE TABLE statement. Supports all PostgreSQL column types including pgvector vector columns.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The CREATE TABLE SQL statement'
        }
      },
      required: ['sql']
    }
  },
  {
    name: 'insert',
    description: 'Insert one or more rows into a table. Rows are provided as an array of objects where keys are column names. Returns the inserted rows.',
    inputSchema: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          description: 'The table name to insert into. Use "schema.table" for non-public schemas.'
        },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            description: 'A row object where keys are column names and values are the data to insert'
          },
          description: 'Array of row objects to insert'
        }
      },
      required: ['table', 'rows']
    }
  }
];

// ─────────────────────────────────────────────────────────────────
// Tool execution router
// ─────────────────────────────────────────────────────────────────

async function executeTool(name, args, manager) {
  switch (name) {
    case 'query':
      return await manager.query(args.sql);
    case 'list_tables':
      return await manager.listTables();
    case 'describe_table':
      return await manager.describeTable(args.table_name);
    case 'create_table':
      return await manager.createTable(args.sql);
    case 'insert':
      return await manager.insert(args.table, args.rows);
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Main server
// ─────────────────────────────────────────────────────────────────

async function main() {
  console.error('\n');
  console.error('  ██████╗  ██████╗ ███████╗████████╗ ██████╗ ██████╗ ███████╗███████╗');
  console.error('  ██╔══██╗██╔═══██╗██╔════╝╚══██╔══╝██╔════╝ ██╔══██╗██╔════╝██╔════╝');
  console.error('  ██████╔╝██║   ██║███████╗   ██║   ██║  ███╗██████╔╝█████╗  ███████╗');
  console.error('  ██╔═══╝ ██║   ██║╚════██║   ██║   ██║   ██║██╔══██╗██╔══╝  ╚════██║');
  console.error('  ██║     ╚██████╔╝███████║   ██║   ╚██████╔╝██║  ██║███████╗███████║');
  console.error('  ╚═╝      ╚═════╝ ╚══════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝');
  console.error('\n  AINative Postgres — Zero-Config Database for AI Agents');
  console.error('\n==========================================================');
  console.error(`  Postgres MCP Server v${PKG_VERSION}`);
  console.error('  Drop-in replacement for @modelcontextprotocol/server-postgres');
  console.error('  Managed PostgreSQL with pgvector + auto-provisioning');
  console.error('==========================================================\n');

  // Resolve database URL (env > saved config > .mcp.json > auto-provision)
  let databaseUrl;
  try {
    databaseUrl = await resolveDatabaseUrl();
  } catch (err) {
    console.error(`  Failed to resolve database: ${err.message}`);
    console.error('  Set DATABASE_URL or run: npx zerodb-cli init');
    console.error('  Or sign up: https://ainative.studio\n');
    process.exit(1);
  }

  // Connect to Postgres
  const manager = new PostgresManager(databaseUrl);
  try {
    await manager.connect();
    console.error('  Connected to PostgreSQL');
  } catch (err) {
    console.error(`  Connection failed: ${err.message}`);
    console.error('  Check your DATABASE_URL and try again.\n');
    process.exit(1);
  }

  // Enable pgvector
  const hasVector = await manager.enablePgvector();
  if (hasVector) {
    console.error('  pgvector extension: enabled');
  }

  // Show table count
  try {
    const tables = await manager.listTables();
    console.error(`  Tables: ${tables.length} found`);
  } catch (_) {}

  console.error(`  Tools: ${TOOLS.length} available (query, list_tables, describe_table, create_table, insert)\n`);

  // Create MCP server
  const server = new Server(
    { name: SERVER_NAME, version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = TOOLS.find(t => t.name === name);

    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true
      };
    }

    try {
      const result = await executeTool(name, args || {}, manager);

      if (result === null) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Tool ${name} not implemented` }) }],
          isError: true
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      console.error(`  [${SERVER_NAME}] Tool ${name} error:`, err.message);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: err.message,
            tool: name,
            hint: err.message.includes('ECONNREFUSED') || err.message.includes('timeout')
              ? 'Database connection failed. Check DATABASE_URL or re-provision with: npx ainative-postgres-mcp'
              : undefined
          })
        }],
        isError: true
      };
    }
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`  MCP Server connected and ready (${TOOLS.length} tools)\n`);
}

// Only start server when run directly (not imported for testing)
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('ainative-postgres-mcp/index.js') ||
  process.argv[1].includes('ainative-postgres-mcp')
) && !process.argv[1].includes('test');

if (isMainModule) {
  // Graceful shutdown
  process.on('SIGINT', () => { console.error('\n  Shutting down...'); process.exit(0); });
  process.on('SIGTERM', () => { console.error('\n  Shutting down...'); process.exit(0); });

  main().catch(err => {
    console.error(`[${SERVER_NAME}] Fatal error:`, err.message);
    console.error('\n  Set DATABASE_URL or run: npx zerodb-cli init');
    console.error('  Or sign up: https://ainative.studio\n');
    process.exit(1);
  });
}

// Export for testing
export { PostgresManager, TOOLS, resolveDatabaseUrl, autoProvision };
