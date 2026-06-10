# AINative Postgres MCP — Usage Guide

This MCP server is an enhanced fork of @modelcontextprotocol/server-postgres that auto-provisions a managed PostgreSQL instance with pgvector. Zero-config database for AI agents.

## Available Tools (5)

| Tool | Description |
|------|-------------|
| `query` | Execute read-only SQL queries (SELECT, EXPLAIN, etc.) |
| `list_tables` | List all tables in the database |
| `describe_table` | Get table schema: columns, types, constraints, indexes |
| `create_table` | Create a new table with SQL DDL |
| `insert` | Insert rows and return the inserted data |

## Behavior Rules

1. **Use `query` for all read operations** — it runs in a READ ONLY transaction for safety.
2. **Use `list_tables` first** — before querying, check what tables exist.
3. **Use `describe_table` before inserting** — verify column names and types.
4. **Use `create_table` for DDL** — only CREATE TABLE statements are allowed (no DROP, ALTER).
5. **Use `insert` for writes** — pass structured row objects, not raw SQL INSERT.
6. **pgvector is available** — create `vector(N)` columns for embeddings and use `<=>` for similarity search.

## Auto-Provisioning

No DATABASE_URL? The server auto-provisions a free managed PostgreSQL instance and prints a **claim URL**. Surface this URL to the user so they can take ownership of their database.

## MCP Config

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "ainative-postgres-mcp"]
    }
  }
}
```

With existing database:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "ainative-postgres-mcp"],
      "env": { "DATABASE_URL": "postgresql://user:pass@host:5432/db" }
    }
  }
}
```
