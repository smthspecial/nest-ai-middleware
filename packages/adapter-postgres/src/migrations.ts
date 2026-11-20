import type { PoolClient } from "pg";

// Versions are the one-based positions in this list. Append new migrations only.
const migrations = [
  `
    CREATE TABLE IF NOT EXISTS nest_ai_middleware.chat_sessions (
      id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, tenant_id TEXT,
      turn_count BIGINT NOT NULL DEFAULT 0, lease_id TEXT, lease_until BIGINT
    );
    CREATE TABLE IF NOT EXISTS nest_ai_middleware.chat_turns (
      session_id TEXT NOT NULL REFERENCES nest_ai_middleware.chat_sessions(id) ON DELETE CASCADE,
      position BIGINT NOT NULL, run_id TEXT NOT NULL, user_text TEXT NOT NULL, assistant_text TEXT NOT NULL,
      tools JSONB NOT NULL, tool_ids JSONB NOT NULL, PRIMARY KEY (session_id, position),
      UNIQUE (session_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS nest_ai_middleware.runs (
      run_id TEXT PRIMARY KEY, session_id TEXT REFERENCES nest_ai_middleware.chat_sessions(id) ON DELETE SET NULL,
      status TEXT NOT NULL, started_at BIGINT NOT NULL, finished_at BIGINT, error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_by_session ON nest_ai_middleware.runs(session_id, started_at);
    CREATE TABLE IF NOT EXISTS nest_ai_middleware.run_events (
      run_id TEXT NOT NULL REFERENCES nest_ai_middleware.runs(run_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, payload JSONB NOT NULL, invocation_id TEXT UNIQUE,
      PRIMARY KEY (run_id, sequence)
    );
  `,
  "CREATE INDEX IF NOT EXISTS chat_sessions_by_owner ON nest_ai_middleware.chat_sessions(subject_id, tenant_id)",
];

/** Run in a transaction on a single client. */
export async function applyPostgresMigrations(
  client: PoolClient,
): Promise<void> {
  // Read the migration history from a fresh snapshot after waiting for the lock.
  await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  await client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('nest_ai_middleware'), pg_catalog.hashtext('schema_migrations'))",
  );
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS nest_ai_middleware;
    CREATE TABLE IF NOT EXISTS nest_ai_middleware.schema_migrations (version INTEGER PRIMARY KEY CHECK (version > 0));
  `);
  const {
    rows: [{ version }],
  } = await client.query<{ version: number }>(
    "SELECT COALESCE(MAX(version), 0) AS version FROM nest_ai_middleware.schema_migrations",
  );
  if (version > migrations.length) {
    throw new Error(
      `NestJS AI Middleware PostgreSQL schema version ${version} requires a newer adapter.`,
    );
  }
  for (const [index, sql] of migrations.entries()) {
    const nextVersion = index + 1;
    if (nextVersion <= version) continue;
    await client.query(sql);
    await client.query(
      "INSERT INTO nest_ai_middleware.schema_migrations (version) VALUES ($1)",
      [nextVersion],
    );
  }
}
