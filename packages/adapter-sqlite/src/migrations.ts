import type { DatabaseSync } from "node:sqlite";

// Versions are the one-based positions in this list. Append new migrations only.
const migrations = [
  `
    CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id TEXT PRIMARY KEY NOT NULL, subject_id TEXT NOT NULL, tenant_id TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0, lease_id TEXT, lease_until INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ai_chat_turns (
      session_id TEXT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, run_id TEXT NOT NULL, user_text TEXT NOT NULL, assistant_text TEXT NOT NULL,
      tools TEXT NOT NULL, tool_ids TEXT NOT NULL,
      PRIMARY KEY (session_id, position)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ai_chat_turns_by_run ON ai_chat_turns(session_id, run_id);
    CREATE TABLE IF NOT EXISTS ai_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT REFERENCES ai_chat_sessions(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'rejected', 'cancelled', 'timed_out')),
      started_at INTEGER NOT NULL, finished_at INTEGER, error_code TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ai_runs_by_session ON ai_runs(session_id, started_at);
    CREATE TABLE IF NOT EXISTS ai_run_events (
      run_id TEXT NOT NULL REFERENCES ai_runs(run_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('model_call', 'tool_attempt')),
      tool_id TEXT, tool_name TEXT, invocation_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'rejected', 'cancelled', 'timed_out')),
      occurred_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, error_code TEXT,
      PRIMARY KEY (run_id, sequence),
      UNIQUE (invocation_id)
    ) STRICT;
  `,
  "CREATE INDEX IF NOT EXISTS ai_chat_sessions_by_owner ON ai_chat_sessions(subject_id, tenant_id)",
];

/** Run in an immediate transaction to serialize concurrent file opens. */
export function applySqliteMigrations(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS ai_schema_migrations (version INTEGER PRIMARY KEY CHECK (version > 0)) STRICT",
  );
  const { version } = db
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM ai_schema_migrations",
    )
    .get() as { version: number };
  if (version > migrations.length) {
    throw new Error(
      `NestJS AI Middleware SQLite schema version ${version} requires a newer adapter.`,
    );
  }
  const record = db.prepare(
    "INSERT INTO ai_schema_migrations (version) VALUES (?)",
  );
  for (const [index, sql] of migrations.entries()) {
    const nextVersion = index + 1;
    if (nextVersion <= version) continue;
    db.exec(sql);
    record.run(nextVersion);
  }
}
