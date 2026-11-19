import { DatabaseSync } from 'node:sqlite';
import type {
  AiCaller, AiConversationSession, AiConversationTurnQuery, AiConversationTurnRecord,
  AiDatabaseAdapter, AiRunEventRecord, AiRunOutcome, AiRunPage,
} from 'nestjs-ai-middleware';

interface StoredRow {
  position: number;
  run_id: string;
  user_text: string;
  assistant_text: string;
  tools: string;
  tool_ids: string;
}

interface RunRow {
  session_id: string;
  status: AiRunPage['status'];
  started_at: number;
  finished_at: number | null;
  error_code: string | null;
  output: string | null;
}

type RunEventRow = {
  outcome: AiRunOutcome;
  sequence: number;
  occurred_at: number;
  duration_ms: number;
  error_code: string | null;
} & (
  | { kind: 'model_call'; input_tokens: number | null; output_tokens: number | null }
  | { kind: 'tool_attempt'; invocation_id: string; tool_id: string | null; tool_name: string | null }
);

const pageSize = 50;

function projectEvent(runId: string, row: RunEventRow): AiRunEventRecord {
  const common = {
    runId, sequence: row.sequence, outcome: row.outcome,
    occurredAt: row.occurred_at, durationMs: row.duration_ms,
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
  };
  if (row.kind === 'tool_attempt') {
    return {
      ...common, kind: 'tool_attempt', invocationId: row.invocation_id,
      ...(row.tool_id && row.tool_name ? { tool: { id: row.tool_id, name: row.tool_name } } : {}),
    };
  }
  const usage = {
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
  };
  return { ...common, kind: 'model_call', ...(Object.keys(usage).length ? { usage } : {}) };
}

export class SqliteDatabaseAdapter implements AiDatabaseAdapter {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (typeof filename !== 'string' || !filename.trim() || filename.includes('\0')) {
      throw new TypeError('A non-empty SQLite filename is required.');
    }
    const db = new DatabaseSync(filename, { timeout: 100 });
    try {
      db.exec(`
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
      `);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  beginConversation({ session, runId, create, leaseUntil }: Parameters<AiDatabaseAdapter['beginConversation']>[0], signal: AbortSignal) {
    signal.throwIfAborted();
    const key = [session.id, session.caller.subjectId, session.caller.tenantId ?? null] as const;
    return this.transaction(() => {
      if (create) this.db.prepare('INSERT INTO ai_chat_sessions(id, subject_id, tenant_id) VALUES (?, ?, ?)').run(...key);
      if (!this.owns(session)) return { status: 'unavailable' } as const;
      const { changes } = this.db.prepare(`
        UPDATE ai_chat_sessions SET lease_id = ?, lease_until = ?
        WHERE id = ? AND subject_id = ? AND tenant_id IS ? AND (lease_id IS NULL OR lease_until <= ?)
      `).run(runId, leaseUntil, ...key, Date.now());
      if (!changes) return { status: 'busy' } as const;
      return { status: 'ready' } as const;
    });
  }

  finishConversation({ session, runId, turn, discardIfEmpty }: Parameters<AiDatabaseAdapter['finishConversation']>[0], signal: AbortSignal): void {
    signal.throwIfAborted();
    const key = [session.id, session.caller.subjectId, session.caller.tenantId ?? null, runId] as const;
    this.transaction(() => {
      const row = this.db.prepare(`
        SELECT turn_count FROM ai_chat_sessions WHERE id = ? AND subject_id = ? AND tenant_id IS ? AND lease_id = ?
      `).get(...key);
      if (!row) {
        if (turn) throw new Error('Conversation lease is unavailable.');
        return;
      }
      const position = Number(row.turn_count);
      if (discardIfEmpty && position === 0) {
        this.db.prepare('DELETE FROM ai_chat_sessions WHERE id = ?').run(session.id);
        return;
      }
      if (turn) {
        this.db.prepare('INSERT INTO ai_chat_turns VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(session.id, position + 1, turn.id, turn.user, turn.assistant, JSON.stringify(turn.tools), JSON.stringify(turn.toolIds));
      }
      this.db.prepare('UPDATE ai_chat_sessions SET turn_count = ?, lease_id = NULL, lease_until = NULL WHERE id = ?')
        .run(position + (turn ? 1 : 0), session.id);
    });
  }

  listConversationTurns(session: AiConversationSession, query: AiConversationTurnQuery, signal: AbortSignal): AiConversationTurnRecord[] | undefined {
    signal.throwIfAborted();
    if (!this.owns(session)) return;
    const descending = query.order === 'descending';
    const before = descending ? query.before : undefined;
    const rows = this.db.prepare(`
      SELECT position, run_id, user_text, assistant_text, tools, tool_ids FROM ai_chat_turns
      WHERE session_id = ? AND position > ? ${before !== undefined ? 'AND position < ?' : ''}
      ORDER BY position ${descending ? 'DESC' : 'ASC'} LIMIT ?
    `).all(session.id, query.after, ...(before !== undefined ? [before] : []), query.limit) as unknown as StoredRow[];
    return rows.map(row => ({
      position: row.position, id: row.run_id, user: row.user_text, assistant: row.assistant_text,
      tools: JSON.parse(row.tools), toolIds: JSON.parse(row.tool_ids),
    }));
  }

  startRun(runId: string, startedAt: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.db.prepare("INSERT INTO ai_runs (run_id, status, started_at) VALUES (?, 'running', ?)").run(runId, startedAt);
  }

  attachRunSession(runId: string, sessionId: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.db.prepare("UPDATE ai_runs SET session_id = ? WHERE run_id = ? AND status = 'running'").run(sessionId, runId);
  }

  appendRunEvent(event: AiRunEventRecord, signal: AbortSignal): void {
    signal.throwIfAborted();
    const tool = event.kind === 'tool_attempt' ? event.tool : undefined;
    const usage = event.kind === 'model_call' ? event.usage : undefined;
    const invocationId = event.kind === 'tool_attempt' ? event.invocationId : null;
    this.db.prepare(`
      INSERT INTO ai_run_events (
        run_id, sequence, kind, tool_id, tool_name, invocation_id, outcome,
        occurred_at, duration_ms, input_tokens, output_tokens, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.runId, event.sequence, event.kind, tool?.id ?? null, tool?.name ?? null, invocationId,
      event.outcome, event.occurredAt, event.durationMs, usage?.inputTokens ?? null,
      usage?.outputTokens ?? null, event.errorCode ?? null,
    );
  }

  finishRun(runId: string, result: Parameters<AiDatabaseAdapter['finishRun']>[1], signal: AbortSignal): void {
    signal.throwIfAborted();
    this.db.prepare(`
      UPDATE ai_runs SET status = ?, error_code = ?, finished_at = ? WHERE run_id = ? AND status = 'running'
    `).run(result.outcome, result.errorCode ?? null, result.finishedAt, runId);
  }

  readRun(runId: string, caller: AiCaller, after: number, signal: AbortSignal): AiRunPage | undefined {
    signal.throwIfAborted();
    const row = this.db.prepare(`
      SELECT r.session_id, r.status, r.started_at, r.finished_at, r.error_code, t.assistant_text AS output
      FROM ai_runs r
      JOIN ai_chat_sessions s ON s.id = r.session_id
      LEFT JOIN ai_chat_turns t ON t.session_id = s.id AND t.run_id = r.run_id
      WHERE r.run_id = ? AND s.subject_id = ? AND s.tenant_id IS ?
    `).get(runId, caller.subjectId, caller.tenantId ?? null) as unknown as RunRow | undefined;
    if (!row) return;
    const rows = this.db.prepare(`
      SELECT sequence, kind, tool_id, tool_name, invocation_id, outcome,
             occurred_at, duration_ms, input_tokens, output_tokens, error_code
      FROM ai_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
    `).all(runId, after, pageSize + 1) as unknown as RunEventRow[];
    const page = rows.slice(0, pageSize);
    return {
      runId, sessionId: row.session_id, status: row.status, startedAt: row.started_at,
      ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
      ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
      ...(row.output !== null ? { output: row.output } : {}),
      events: page.map(event => projectEvent(runId, event)),
      ...(rows.length > pageSize ? { nextAfter: page[page.length - 1].sequence } : {}),
    };
  }

  private owns(session: AiConversationSession): boolean {
    return !!this.db.prepare('SELECT 1 FROM ai_chat_sessions WHERE id = ? AND subject_id = ? AND tenant_id IS ?')
      .get(session.id, session.caller.subjectId, session.caller.tenantId ?? null);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
