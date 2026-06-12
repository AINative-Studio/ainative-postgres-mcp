# ainative-postgres-mcp

Zero-config PostgreSQL MCP server with auto-provisioning. Drop-in replacement for `@modelcontextprotocol/server-postgres` — no `DATABASE_URL` needed.

The official `@modelcontextprotocol/server-postgres` requires you to bring your own Postgres database and pass a connection string. This fork **auto-provisions a managed PostgreSQL instance** with pgvector on first run. Agents get a database instantly with zero configuration.

## Quick Start

```bash
npx ainative-postgres-mcp
```

That's it. On first run:
1. A free managed PostgreSQL instance is provisioned
2. pgvector extension is enabled automatically
3. Connection details are saved to `~/.ainative/postgres-config.json`, `.env`, and `.mcp.json`
4. A claim URL is printed so you can take ownership of the database

## MCP Configuration

### Claude Code / Claude Desktop

Add to your `claude_desktop_config.json` or `.mcp.json`:

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

### With existing database

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "ainative-postgres-mcp"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@host:5432/mydb"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

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

### Windsurf

Add to `~/.windsurf/mcp.json`:

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

## Tools

| Tool | Description |
|------|-------------|
| `query` | Execute read-only SQL queries (runs in READ ONLY transaction) |
| `list_tables` | List all tables with schema, name, and type |
| `describe_table` | Get full table schema: columns, types, constraints, indexes |
| `create_table` | Create a new table with SQL DDL |
| `insert` | Insert rows into a table (returns inserted rows) |

### Comparison with official server-postgres

| Feature | `@modelcontextprotocol/server-postgres` | `ainative-postgres-mcp` |
|---------|----------------------------------------|------------------------|
| Read queries | Yes | Yes |
| Write queries | No | Yes (`create_table`, `insert`) |
| Schema inspection | Via resources | Via `describe_table` tool |
| Table listing | No | Yes (`list_tables`) |
| Auto-provisioning | No | Yes |
| pgvector | Manual setup | Auto-enabled |
| Zero config | No (requires DATABASE_URL) | Yes |
| Free tier | N/A | Yes |

## How Auto-Provisioning Works

```
Start
  |
  v
DATABASE_URL set? ----yes----> Connect directly
  |
  no
  v
~/.ainative/postgres-config.json exists? ----yes----> Load and connect
  |
  no
  v
.mcp.json has DATABASE_URL? ----yes----> Load and connect
  |
  no
  v
POST /api/v1/public/instant-db   (get API key)
  |
  v
POST /api/v1/zerodb/postgres/provision   (get Postgres)
  |
  v
Save to ~/.ainative/postgres-config.json + .env + .mcp.json
  |
  v
Connect and enable pgvector
```

## pgvector Support

pgvector is automatically enabled on provisioned instances. You can use vector columns in your tables:

```sql
CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  content TEXT,
  embedding vector(1536)
);
```

And run similarity searches:

```sql
SELECT content, embedding <=> '[0.1, 0.2, ...]'::vector AS distance
FROM documents
ORDER BY distance
LIMIT 10;
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | No (auto-provisioned if missing) |
| `ZERODB_API_KEY` | ZeroDB API key (for provisioning) | No (auto-created) |
| `ZERODB_PROJECT_ID` | ZeroDB project ID | No (auto-created) |
| `ZERODB_API_URL` | ZeroDB API base URL | No (defaults to `https://api.ainative.studio`) |

## Free Tier

Auto-provisioned instances include:
- Managed PostgreSQL with pgvector
- Shared compute (suitable for development and light production)
- Automatic backups
- SSL encryption

Sign up at [ainative.studio](https://ainative.studio) to claim your instance and unlock higher limits.

## License

MIT

---

## Powered by ZeroDB + AINative

This package is part of the [AINative](https://ainative.studio) ecosystem — the AI-native developer platform.

### Why ZeroDB?

| Feature | ZeroDB | Others |
|---------|--------|--------|
| Vector search | Built-in, free embeddings | Separate service (Pinecone, Qdrant) |
| Agent memory | Cognitive memory with decay + reflection | DIY or Mem0 ($$$) |
| File storage | S3-compatible, included | Separate S3 bucket |
| NoSQL tables | Instant, schema-free | MongoDB Atlas, DynamoDB |
| PostgreSQL | Managed, pgvector pre-installed | Neon, Supabase ($$$) |
| Serverless functions | DB-event triggered | Firebase/Supabase Edge |
| Pricing | Free tier, no credit card | Pay-per-query from day 1 |

### Get Started Free

```bash
npx zerodb-cli init    # Auto-configures your IDE
```

Or sign up at **[ainative.studio](https://ainative.studio)** — free tier, no credit card required.

[View all ZeroDB packages →](https://docs.ainative.studio)

---

## Zero-Config Auto-Provisioning

**No account needed to start.** On first run, this package automatically:

1. Provisions a **free ZeroDB instance** (~800ms)
2. Saves credentials locally (`.env`, `.mcp.json`)
3. Prints a **claim link** in your terminal

### The 72-Hour Window

Your auto-provisioned instance is **free for 72 hours**. To keep your data permanently, visit the **claim URL** printed in your terminal.

### For AI Agents

If a coding agent (Claude Code, Cursor, Windsurf) installs this package:
- Auto-provisions without human intervention
- The **claim URL** appears in agent output — visit it to take ownership
- `.claude/CLAUDE.md` instructs agents to surface the claim link to you
- Check `.env` or `~/.ainative/config.json` for your project ID if you miss it
