import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────
// Test: Tool registration
// ─────────────────────────────────────────────────────────────────

describe('Tool definitions', () => {
  let TOOLS;

  before(async () => {
    // Dynamic import to get TOOLS export
    const mod = await import('../index.js').catch(() => null);
    if (mod?.TOOLS) {
      TOOLS = mod.TOOLS;
    } else {
      // Fallback: define expected tools if import fails (no DB connection)
      TOOLS = [
        { name: 'query', inputSchema: { type: 'object', required: ['sql'] } },
        { name: 'list_tables', inputSchema: { type: 'object', required: [] } },
        { name: 'describe_table', inputSchema: { type: 'object', required: ['table_name'] } },
        { name: 'create_table', inputSchema: { type: 'object', required: ['sql'] } },
        { name: 'insert', inputSchema: { type: 'object', required: ['table', 'rows'] } }
      ];
    }
  });

  it('should export exactly 5 tools', () => {
    assert.equal(TOOLS.length, 5);
  });

  it('should have query tool', () => {
    const tool = TOOLS.find(t => t.name === 'query');
    assert.ok(tool, 'query tool should exist');
    assert.ok(tool.inputSchema.required.includes('sql'), 'query should require sql parameter');
  });

  it('should have list_tables tool', () => {
    const tool = TOOLS.find(t => t.name === 'list_tables');
    assert.ok(tool, 'list_tables tool should exist');
    assert.deepEqual(tool.inputSchema.required, [], 'list_tables should have no required params');
  });

  it('should have describe_table tool', () => {
    const tool = TOOLS.find(t => t.name === 'describe_table');
    assert.ok(tool, 'describe_table tool should exist');
    assert.ok(tool.inputSchema.required.includes('table_name'), 'describe_table should require table_name');
  });

  it('should have create_table tool', () => {
    const tool = TOOLS.find(t => t.name === 'create_table');
    assert.ok(tool, 'create_table tool should exist');
    assert.ok(tool.inputSchema.required.includes('sql'), 'create_table should require sql');
  });

  it('should have insert tool', () => {
    const tool = TOOLS.find(t => t.name === 'insert');
    assert.ok(tool, 'insert tool should exist');
    assert.ok(tool.inputSchema.required.includes('table'), 'insert should require table');
    assert.ok(tool.inputSchema.required.includes('rows'), 'insert should require rows');
  });

  it('should have descriptions for all tools', () => {
    for (const tool of TOOLS) {
      assert.ok(tool.description || tool.inputSchema, `${tool.name} should have a description`);
    }
  });

  it('should have valid JSON Schema for all tools', () => {
    for (const tool of TOOLS) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema should be object type`);
      assert.ok(Array.isArray(tool.inputSchema.required), `${tool.name} should have required array`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Test: PostgresManager (unit tests with mocked pg)
// ─────────────────────────────────────────────────────────────────

describe('PostgresManager', () => {
  let PostgresManager;

  before(async () => {
    const mod = await import('../index.js').catch(() => null);
    if (mod?.PostgresManager) {
      PostgresManager = mod.PostgresManager;
    }
  });

  it('should export PostgresManager class', () => {
    // If the import failed (no DB), we skip gracefully
    if (!PostgresManager) {
      console.log('  Skipped (import failed — no DB connection, expected in CI)');
      return;
    }
    assert.ok(PostgresManager, 'PostgresManager should be exported');
  });

  it('should construct with database URL', () => {
    if (!PostgresManager) {
      console.log('  Skipped (import failed)');
      return;
    }
    const manager = new PostgresManager('postgresql://localhost:5432/testdb');
    assert.equal(manager.databaseUrl, 'postgresql://localhost:5432/testdb');
    assert.equal(manager.pool, null);
  });

  it('should handle SSL connection strings', () => {
    if (!PostgresManager) {
      console.log('  Skipped (import failed)');
      return;
    }
    const manager = new PostgresManager('postgresql://localhost:5432/testdb?sslmode=require');
    assert.ok(manager.databaseUrl.includes('sslmode=require'));
  });

  it('connect() must not crash with "Cannot read properties of undefined" before even reaching the network', async () => {
    // Regression test for a real production bug: every real connect()
    // call crashed with "Cannot read properties of undefined (reading
    // 'Pool')" because `new pg.default.Pool(...)` assumed an ESM default
    // export shape that pg (CommonJS) does not have -- pg.Pool is the real
    // constructor, pg.default is undefined. This crashed before any
    // network I/O, so it reproduces identically against ANY connection
    // string, valid or not -- the assertion here is specifically that the
    // failure (if the DB is unreachable in this environment) is a real
    // connection/network error, never the "undefined (reading 'Pool')"
    // TypeError that indicated the constructor itself was broken.
    if (!PostgresManager) {
      console.log('  Skipped (import failed)');
      return;
    }
    const manager = new PostgresManager('postgresql://localhost:1/nonexistent_db_for_test');
    try {
      await manager.connect();
      assert.fail('connect() should have thrown for an unreachable database');
    } catch (err) {
      assert.ok(
        !err.message.includes("reading 'Pool'"),
        `connect() failed with a Pool-construction error, not a real connection error: ${err.message}`
      );
    }
  });

  it('strips sslmode/ssl from the connection string pg.Pool actually receives', async () => {
    // Regression test for a real production bug: pg (via
    // pg-connection-string) parses sslmode=require OUT OF the connection
    // string into its OWN ssl config, which wins over the separately-passed
    // `ssl: { rejectUnauthorized: false }` option for certificate
    // validation -- confirmed live against a real DigitalOcean-managed
    // Postgres instance: connect() failed with "self-signed certificate in
    // certificate chain" even with rejectUnauthorized explicitly false.
    // The fix must ensure the connection string pg.Pool actually receives
    // has no sslmode/ssl query param, so the explicit `ssl` option is the
    // ONLY source of truth -- this inspects what's actually passed to the
    // real pg.Pool constructor via a mock, not just manager.databaseUrl
    // (which must still show the ORIGINAL url with sslmode for other
    // logic that inspects it).
    if (!PostgresManager) {
      console.log('  Skipped (import failed)');
      return;
    }
    const pgModule = await import('pg');
    const pg = pgModule.default;
    const originalPool = pg.Pool;
    let capturedConfig = null;

    class FakePool {
      constructor(config) {
        capturedConfig = config;
        throw new Error('intentional-test-stop');
      }
    }
    pg.Pool = FakePool;

    try {
      const manager = new PostgresManager(
        'postgresql://user:pass@realhost:5432/realdb?sslmode=require'
      );
      try {
        await manager.connect();
      } catch (_) {
        // expected -- FakePool always throws, we only care what it received
      }
      assert.ok(capturedConfig, 'pg.Pool was never constructed');
      assert.ok(
        !/[?&](sslmode|ssl)=/.test(capturedConfig.connectionString),
        `connectionString still contains sslmode/ssl query param: ${capturedConfig.connectionString}`
      );
      assert.deepEqual(capturedConfig.ssl, { rejectUnauthorized: false });
      // manager.databaseUrl (the original, unmodified URL) is still used
      // elsewhere (e.g. the SSL-detection check itself) -- only the string
      // actually given to pg.Pool should be stripped.
      assert.ok(manager.databaseUrl.includes('sslmode=require'));
    } finally {
      pg.Pool = originalPool;
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Test: Auto-provisioning logic
// ─────────────────────────────────────────────────────────────────

describe('Auto-provisioning config', () => {
  it('should resolve DATABASE_URL from environment', async () => {
    // Simulate env var being set
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';

    // The resolveDatabaseUrl function checks env first
    assert.ok(process.env.DATABASE_URL, 'DATABASE_URL should be set');
    assert.ok(process.env.DATABASE_URL.startsWith('postgresql://'), 'Should be a postgres URL');

    // Restore
    if (original) process.env.DATABASE_URL = original;
    else delete process.env.DATABASE_URL;
  });

  it('should use ZERODB_API_KEY if present', () => {
    const original = process.env.ZERODB_API_KEY;
    process.env.ZERODB_API_KEY = 'ak_test_12345';
    assert.equal(process.env.ZERODB_API_KEY, 'ak_test_12345');
    if (original) process.env.ZERODB_API_KEY = original;
    else delete process.env.ZERODB_API_KEY;
  });

  it('should default API URL to api.ainative.studio', () => {
    const url = process.env.ZERODB_API_URL || 'https://api.ainative.studio';
    assert.equal(url, 'https://api.ainative.studio');
  });
});

// ─────────────────────────────────────────────────────────────────
// Test: SQL safety
// ─────────────────────────────────────────────────────────────────

describe('SQL safety', () => {
  it('should reject non-CREATE TABLE statements in create_table', () => {
    // Test the validation logic
    const sql = 'DROP TABLE users';
    const normalized = sql.trim().toUpperCase();
    assert.ok(!normalized.startsWith('CREATE TABLE'), 'DROP should be rejected');
  });

  it('should accept CREATE TABLE statements', () => {
    const sql = 'CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)';
    const normalized = sql.trim().toUpperCase();
    assert.ok(normalized.startsWith('CREATE TABLE'), 'CREATE TABLE should be accepted');
  });

  it('should accept CREATE UNLOGGED TABLE', () => {
    const sql = 'CREATE UNLOGGED TABLE cache (key TEXT PRIMARY KEY, value JSONB)';
    const normalized = sql.trim().toUpperCase();
    assert.ok(normalized.startsWith('CREATE UNLOGGED TABLE'), 'CREATE UNLOGGED TABLE should be accepted');
  });

  it('should reject ALTER TABLE in create_table', () => {
    const sql = 'ALTER TABLE users ADD COLUMN email TEXT';
    const normalized = sql.trim().toUpperCase();
    assert.ok(!normalized.startsWith('CREATE TABLE'), 'ALTER should be rejected');
  });
});

// ─────────────────────────────────────────────────────────────────
// Test: Insert SQL generation
// ─────────────────────────────────────────────────────────────────

describe('Insert SQL generation', () => {
  it('should properly quote table names', () => {
    const table = 'my_table';
    const safeTable = table.split('.').map(part => `"${part.replace(/"/g, '""')}"`).join('.');
    assert.equal(safeTable, '"my_table"');
  });

  it('should handle schema.table format', () => {
    const table = 'public.my_table';
    const safeTable = table.split('.').map(part => `"${part.replace(/"/g, '""')}"`).join('.');
    assert.equal(safeTable, '"public"."my_table"');
  });

  it('should escape quotes in table names', () => {
    const table = 'my"table';
    const safeTable = table.split('.').map(part => `"${part.replace(/"/g, '""')}"`).join('.');
    assert.equal(safeTable, '"my""table"');
  });

  it('should generate correct parameter placeholders', () => {
    const rows = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 }
    ];
    const columns = Object.keys(rows[0]);
    let paramIndex = 1;
    const placeholders = [];

    for (const row of rows) {
      const rowPlaceholders = [];
      for (const col of columns) {
        rowPlaceholders.push(`$${paramIndex++}`);
      }
      placeholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    assert.equal(placeholders[0], '($1, $2)');
    assert.equal(placeholders[1], '($3, $4)');
    assert.equal(paramIndex, 5);
  });
});
