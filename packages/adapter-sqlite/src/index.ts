import { readAiEnv, readAiIntegerEnv } from "nestjs-ai-middleware";
import { DatabaseSync } from "node:sqlite";
import type {
  AiCaller,
  AiConversationListQuery,
  AiConversationSession,
  AiConversationSummary,
  AiConversationTurnQuery,
  AiConversationTurnRecord,
  AiDatabaseAdapter,
  AiRunEventRecord,
  AiRunOutcome,
  AiRunPage,
} from "nestjs-ai-middleware";
import { applySqliteMigrations } from "./migrations.js";

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
  status: AiRunPage["status"];
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
  | {
      kind: "model_call";
      input_tokens: number | null;
      output_tokens: number | null;
    }
  | {
      kind: "tool_attempt";
      invocation_id: string;
      tool_id: string | null;
      tool_name: string | null;
    }
);

function projectEvent(runId: string, row: RunEventRow): AiRunEventRecord {
  const common = {
    runId,
    sequence: row.sequence,
    outcome: row.outcome,
    occurredAt: row.occurred_at,
    durationMs: row.duration_ms,
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
  };
  if (row.kind === "tool_attempt") {
    return {
      ...common,
      kind: "tool_attempt",
      invocationId: row.invocation_id,
      ...(row.tool_id && row.tool_name
        ? { tool: { id: row.tool_id, name: row.tool_name } }
        : {}),
    };
  }
  const usage = {
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
  };
  return {
    ...common,
    kind: "model_call",
    ...(Object.keys(usage).length ? { usage } : {}),
  };
}

export class SqliteDatabaseAdapter implements AiDatabaseAdapter {
  private readonly eventPageSize = readAiIntegerEnv(
    "RUN_EVENT_PAGE_SIZE",
    50,
    2_147_483_646,
  );
  private readonly previewChars = readAiIntegerEnv(
    "CONVERSATION_PREVIEW_CHARS",
    120,
  );
  private readonly db: DatabaseSync;

  constructor(filename = readAiEnv("SQLITE_FILENAME")) {
    if (
      typeof filename !== "string" ||
      !filename.trim() ||
      filename.includes("\0")
    ) {
      throw new TypeError(
        "Pass a nonempty SQLite filename or set NEST_AI_SQLITE_FILENAME.",
      );
    }
    const migrationTimeout = readAiIntegerEnv(
      "SQLITE_MIGRATION_TIMEOUT_MS",
      30_000,
    );
    const busyTimeout = readAiIntegerEnv("SQLITE_BUSY_TIMEOUT_MS", 100);
    this.db = new DatabaseSync(filename, { timeout: migrationTimeout });
    try {
      this.transaction(() => applySqliteMigrations(this.db));
      this.db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  beginConversation(
    {
      session,
      runId,
      create,
      leaseUntil,
    }: Parameters<AiDatabaseAdapter["beginConversation"]>[0],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const key = [
      session.id,
      session.caller.subjectId,
      session.caller.tenantId ?? null,
    ] as const;
    return this.transaction(() => {
      if (create)
        this.db
          .prepare(
            "INSERT INTO ai_chat_sessions(id, subject_id, tenant_id) VALUES (?, ?, ?)",
          )
          .run(...key);
      if (!this.owns(session)) return { status: "unavailable" } as const;
      const { changes } = this.db
        .prepare(
          `
        UPDATE ai_chat_sessions SET lease_id = ?, lease_until = ?
        WHERE id = ? AND subject_id = ? AND tenant_id IS ? AND (lease_id IS NULL OR lease_until <= ?)
      `,
        )
        .run(runId, leaseUntil, ...key, Date.now());
      if (!changes) return { status: "busy" } as const;
      return { status: "ready" } as const;
    });
  }

  finishConversation(
    {
      session,
      runId,
      turn,
      discardIfEmpty,
    }: Parameters<AiDatabaseAdapter["finishConversation"]>[0],
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted();
    const key = [
      session.id,
      session.caller.subjectId,
      session.caller.tenantId ?? null,
      runId,
    ] as const;
    this.transaction(() => {
      const row = this.db
        .prepare(
          `
        SELECT turn_count FROM ai_chat_sessions WHERE id = ? AND subject_id = ? AND tenant_id IS ? AND lease_id = ?
      `,
        )
        .get(...key);
      if (!row) {
        if (turn) throw new Error("Conversation lease is unavailable.");
        return;
      }
      const position = Number(row.turn_count);
      if (discardIfEmpty && position === 0) {
        this.db
          .prepare("DELETE FROM ai_chat_sessions WHERE id = ?")
          .run(session.id);
        return;
      }
      if (turn) {
        this.db
          .prepare("INSERT INTO ai_chat_turns VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(
            session.id,
            position + 1,
            turn.id,
            turn.user,
            turn.assistant,
            JSON.stringify(turn.tools),
            JSON.stringify(turn.toolIds),
          );
      }
      this.db
        .prepare(
          "UPDATE ai_chat_sessions SET turn_count = ?, lease_id = NULL, lease_until = NULL WHERE id = ?",
        )
        .run(position + (turn ? 1 : 0), session.id);
    });
  }

  listConversationTurns(
    session: AiConversationSession,
    query: AiConversationTurnQuery,
    signal: AbortSignal,
  ): AiConversationTurnRecord[] | undefined {
    signal.throwIfAborted();
    if (!this.owns(session)) return;
    const descending = query.order === "descending";
    const before = descending ? query.before : undefined;
    const rows = this.db
      .prepare(
        `
      SELECT position, run_id, user_text, assistant_text, tools, tool_ids FROM ai_chat_turns
      WHERE session_id = ? AND position > ? ${before !== undefined ? "AND position < ?" : ""}
      ORDER BY position ${descending ? "DESC" : "ASC"} LIMIT ?
    `,
      )
      .all(
        session.id,
        query.after,
        ...(before !== undefined ? [before] : []),
        query.limit,
      ) as unknown as StoredRow[];
    return rows.map((row) => ({
      position: row.position,
      id: row.run_id,
      user: row.user_text,
      assistant: row.assistant_text,
      tools: JSON.parse(row.tools),
      toolIds: JSON.parse(row.tool_ids),
    }));
  }

  listConversations(
    caller: AiCaller,
    { before, limit }: AiConversationListQuery,
    signal: AbortSignal,
  ): AiConversationSummary[] {
    signal.throwIfAborted();
    return this.db
      .prepare(
        `
      WITH owned AS (
        SELECT s.id AS sessionId, substr(first_turn.user_text, 1, ?) AS preview,
               COALESCE(r.started_at, 0) AS updatedAt
        FROM ai_chat_sessions s
        JOIN ai_chat_turns first_turn ON first_turn.session_id = s.id AND first_turn.position = 1
        JOIN ai_chat_turns last_turn ON last_turn.session_id = s.id AND last_turn.position = s.turn_count
        LEFT JOIN ai_runs r ON r.run_id = last_turn.run_id AND r.session_id = s.id
        WHERE s.subject_id = ? AND s.tenant_id IS ? AND s.turn_count > 0
      )
      SELECT sessionId, preview, updatedAt FROM owned
      ${before ? "WHERE (updatedAt, sessionId) < (?, ?)" : ""}
      ORDER BY updatedAt DESC, sessionId DESC LIMIT ?
    `,
      )
      .all(
        this.previewChars,
        caller.subjectId,
        caller.tenantId ?? null,
        ...(before ? [before.updatedAt, before.sessionId] : []),
        limit,
      ) as unknown as AiConversationSummary[];
  }

  startRun(runId: string, startedAt: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.db
      .prepare(
        "INSERT INTO ai_runs (run_id, status, started_at) VALUES (?, 'running', ?)",
      )
      .run(runId, startedAt);
  }

  attachRunSession(
    runId: string,
    sessionId: string,
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted();
    this.db
      .prepare(
        "UPDATE ai_runs SET session_id = ? WHERE run_id = ? AND status = 'running'",
      )
      .run(sessionId, runId);
  }

  appendRunEvent(event: AiRunEventRecord, signal: AbortSignal): void {
    signal.throwIfAborted();
    const tool = event.kind === "tool_attempt" ? event.tool : undefined;
    const usage = event.kind === "model_call" ? event.usage : undefined;
    const invocationId =
      event.kind === "tool_attempt" ? event.invocationId : null;
    this.db
      .prepare(
        `
      INSERT INTO ai_run_events (
        run_id, sequence, kind, tool_id, tool_name, invocation_id, outcome,
        occurred_at, duration_ms, input_tokens, output_tokens, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        event.runId,
        event.sequence,
        event.kind,
        tool?.id ?? null,
        tool?.name ?? null,
        invocationId,
        event.outcome,
        event.occurredAt,
        event.durationMs,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        event.errorCode ?? null,
      );
  }

  finishRun(
    runId: string,
    result: Parameters<AiDatabaseAdapter["finishRun"]>[1],
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted();
    this.db
      .prepare(
        `
      UPDATE ai_runs SET status = ?, error_code = ?, finished_at = ? WHERE run_id = ? AND status = 'running'
    `,
      )
      .run(result.outcome, result.errorCode ?? null, result.finishedAt, runId);
  }

  readRun(
    runId: string,
    caller: AiCaller,
    after: number,
    signal: AbortSignal,
  ): AiRunPage | undefined {
    signal.throwIfAborted();
    const row = this.db
      .prepare(
        `
      SELECT r.session_id, r.status, r.started_at, r.finished_at, r.error_code, t.assistant_text AS output
      FROM ai_runs r
      JOIN ai_chat_sessions s ON s.id = r.session_id
      LEFT JOIN ai_chat_turns t ON t.session_id = s.id AND t.run_id = r.run_id
      WHERE r.run_id = ? AND s.subject_id = ? AND s.tenant_id IS ?
    `,
      )
      .get(runId, caller.subjectId, caller.tenantId ?? null) as unknown as
      RunRow | undefined;
    if (!row) return;
    const rows = this.db
      .prepare(
        `
      SELECT sequence, kind, tool_id, tool_name, invocation_id, outcome,
             occurred_at, duration_ms, input_tokens, output_tokens, error_code
      FROM ai_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
    `,
      )
      .all(runId, after, this.eventPageSize + 1) as unknown as RunEventRow[];
    const page = rows.slice(0, this.eventPageSize);
    return {
      runId,
      sessionId: row.session_id,
      status: row.status,
      startedAt: row.started_at,
      ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
      ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
      ...(row.output !== null ? { output: row.output } : {}),
      events: page.map((event) => projectEvent(runId, event)),
      ...(rows.length > this.eventPageSize
        ? { nextAfter: page[page.length - 1].sequence }
        : {}),
    };
  }

  private owns(session: AiConversationSession): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM ai_chat_sessions WHERE id = ? AND subject_id = ? AND tenant_id IS ?",
      )
      .get(
        session.id,
        session.caller.subjectId,
        session.caller.tenantId ?? null,
      );
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
