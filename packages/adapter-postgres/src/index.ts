import type { Pool, PoolClient } from "pg";
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
import { applyPostgresMigrations } from "./migrations.js";

interface LeaseRow {
  turn_count: string;
  lease_id: string | null;
  lease_until: string | null;
}

interface TurnRow {
  position: string;
  run_id: string;
  user_text: string;
  assistant_text: string;
  tools: string[];
  tool_ids: string[];
}

interface RunRow {
  session_id: string;
  status: "running" | AiRunOutcome;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  output: string | null;
}

const eventPageSize = 50;

function ownerKey({ id, caller }: AiConversationSession) {
  return [id, caller.subjectId, caller.tenantId ?? null];
}

export class PostgresDatabaseAdapter implements AiDatabaseAdapter {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.transaction(undefined, applyPostgresMigrations);
  }

  async beginConversation(
    {
      session,
      runId,
      create,
      leaseUntil,
    }: Parameters<AiDatabaseAdapter["beginConversation"]>[0],
    signal: AbortSignal,
  ) {
    const key = ownerKey(session);
    return this.transaction(signal, async (client) => {
      if (create) {
        await client.query(
          "INSERT INTO nest_ai_middleware.chat_sessions (id, subject_id, tenant_id) VALUES ($1, $2, $3)",
          key,
        );
      }
      const {
        rows: [owner],
      } = await client.query<LeaseRow>(
        `
        SELECT lease_id, lease_until FROM nest_ai_middleware.chat_sessions
        WHERE id = $1 AND subject_id = $2 AND tenant_id IS NOT DISTINCT FROM $3
        FOR UPDATE
      `,
        key,
      );
      if (!owner) return { status: "unavailable" } as const;
      if (owner.lease_id && Number(owner.lease_until) > Date.now())
        return { status: "busy" } as const;
      await client.query(
        "UPDATE nest_ai_middleware.chat_sessions SET lease_id = $1, lease_until = $2 WHERE id = $3",
        [runId, leaseUntil, session.id],
      );
      return { status: "ready" } as const;
    });
  }

  async finishConversation(
    {
      session,
      runId,
      turn,
      discardIfEmpty,
    }: Parameters<AiDatabaseAdapter["finishConversation"]>[0],
    signal: AbortSignal,
  ): Promise<void> {
    await this.transaction(signal, async (client) => {
      const {
        rows: [owner],
      } = await client.query<LeaseRow>(
        `
        SELECT turn_count FROM nest_ai_middleware.chat_sessions
        WHERE id = $1 AND subject_id = $2 AND tenant_id IS NOT DISTINCT FROM $3 AND lease_id = $4
        FOR UPDATE
      `,
        [...ownerKey(session), runId],
      );
      if (!owner) {
        if (turn) throw new Error("Conversation lease is unavailable.");
        return;
      }
      const position = Number(owner.turn_count);
      if (discardIfEmpty && position === 0) {
        await client.query(
          "DELETE FROM nest_ai_middleware.chat_sessions WHERE id = $1",
          [session.id],
        );
        return;
      }
      if (turn) {
        await client.query(
          `
          INSERT INTO nest_ai_middleware.chat_turns (session_id, position, run_id, user_text, assistant_text, tools, tool_ids)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
          [
            session.id,
            position + 1,
            turn.id,
            turn.user,
            turn.assistant,
            JSON.stringify(turn.tools),
            JSON.stringify(turn.toolIds),
          ],
        );
      }
      await client.query(
        "UPDATE nest_ai_middleware.chat_sessions SET turn_count = $1, lease_id = NULL, lease_until = NULL WHERE id = $2",
        [position + (turn ? 1 : 0), session.id],
      );
    });
  }

  async listConversationTurns(
    session: AiConversationSession,
    query: AiConversationTurnQuery,
    signal: AbortSignal,
  ): Promise<AiConversationTurnRecord[] | undefined> {
    return this.withClient(signal, async (client) => {
      const key = ownerKey(session);
      const { rowCount } = await client.query(
        `
        SELECT 1 FROM nest_ai_middleware.chat_sessions WHERE id = $1 AND subject_id = $2 AND tenant_id IS NOT DISTINCT FROM $3
      `,
        key,
      );
      if (!rowCount) return;
      const descending = query.order === "descending";
      const before = descending ? query.before : undefined;
      const { rows } = await client.query<TurnRow>(
        `
        SELECT position, run_id, user_text, assistant_text, tools, tool_ids FROM nest_ai_middleware.chat_turns
        WHERE session_id = $1 AND position > $2 ${before !== undefined ? "AND position < $4" : ""}
        ORDER BY position ${descending ? "DESC" : "ASC"} LIMIT $3
      `,
        [
          session.id,
          query.after,
          query.limit,
          ...(before !== undefined ? [before] : []),
        ],
      );
      return rows.map((row) => ({
        position: Number(row.position),
        id: row.run_id,
        user: row.user_text,
        assistant: row.assistant_text,
        tools: row.tools,
        toolIds: row.tool_ids,
      }));
    });
  }

  async listConversations(
    caller: AiCaller,
    { before, limit }: AiConversationListQuery,
    signal: AbortSignal,
  ): Promise<AiConversationSummary[]> {
    return this.withClient(signal, async (client) => {
      const { rows } = await client.query<{
        id: string;
        preview: string;
        updated_at: string;
      }>(
        `
        WITH owned AS (
          SELECT s.id, left(first_turn.user_text, 120) AS preview, COALESCE(r.started_at, 0) AS updated_at
          FROM nest_ai_middleware.chat_sessions s
          JOIN nest_ai_middleware.chat_turns first_turn ON first_turn.session_id = s.id AND first_turn.position = 1
          JOIN nest_ai_middleware.chat_turns last_turn ON last_turn.session_id = s.id AND last_turn.position = s.turn_count
          LEFT JOIN nest_ai_middleware.runs r ON r.run_id = last_turn.run_id AND r.session_id = s.id
          WHERE s.subject_id = $1 AND s.tenant_id IS NOT DISTINCT FROM $2 AND s.turn_count > 0
        )
        SELECT id, preview, updated_at FROM owned
        ${before ? "WHERE (updated_at, id) < ($4::bigint, $5::text)" : ""}
        ORDER BY updated_at DESC, id DESC LIMIT $3
      `,
        [
          caller.subjectId,
          caller.tenantId ?? null,
          limit,
          ...(before ? [before.updatedAt, before.sessionId] : []),
        ],
      );
      return rows.map((row) => ({
        sessionId: row.id,
        preview: row.preview,
        updatedAt: Number(row.updated_at),
      }));
    });
  }

  async startRun(
    runId: string,
    startedAt: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.write(
      signal,
      "INSERT INTO nest_ai_middleware.runs (run_id, status, started_at) VALUES ($1, 'running', $2)",
      [runId, startedAt],
    );
  }

  async attachRunSession(
    runId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.write(
      signal,
      "UPDATE nest_ai_middleware.runs SET session_id = $1 WHERE run_id = $2 AND status = 'running'",
      [sessionId, runId],
    );
  }

  async appendRunEvent(
    event: AiRunEventRecord,
    signal: AbortSignal,
  ): Promise<void> {
    await this.write(
      signal,
      "INSERT INTO nest_ai_middleware.run_events (run_id, sequence, payload, invocation_id) VALUES ($1, $2, $3, $4)",
      [
        event.runId,
        event.sequence,
        JSON.stringify(event),
        event.kind === "tool_attempt" ? event.invocationId : null,
      ],
    );
  }

  async finishRun(
    runId: string,
    result: Parameters<AiDatabaseAdapter["finishRun"]>[1],
    signal: AbortSignal,
  ): Promise<void> {
    await this.write(
      signal,
      "UPDATE nest_ai_middleware.runs SET status = $1, finished_at = $2, error_code = $3 WHERE run_id = $4 AND status = 'running'",
      [result.outcome, result.finishedAt, result.errorCode ?? null, runId],
    );
  }

  async readRun(
    runId: string,
    caller: AiCaller,
    after: number,
    signal: AbortSignal,
  ): Promise<AiRunPage | undefined> {
    return this.withClient(signal, async (client) => {
      const {
        rows: [run],
      } = await client.query<RunRow>(
        `
        SELECT r.session_id, r.status, r.started_at, r.finished_at, r.error_code, t.assistant_text AS output
        FROM nest_ai_middleware.runs r
        JOIN nest_ai_middleware.chat_sessions s ON s.id = r.session_id
        LEFT JOIN nest_ai_middleware.chat_turns t ON t.session_id = s.id AND t.run_id = r.run_id
        WHERE r.run_id = $1 AND s.subject_id = $2 AND s.tenant_id IS NOT DISTINCT FROM $3
      `,
        [runId, caller.subjectId, caller.tenantId ?? null],
      );
      if (!run) return;
      const { rows } = await client.query<{ payload: AiRunEventRecord }>(
        `
        SELECT payload FROM nest_ai_middleware.run_events WHERE run_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3
      `,
        [runId, after, eventPageSize + 1],
      );
      const events = rows.slice(0, eventPageSize).map((row) => row.payload);
      return {
        runId,
        sessionId: run.session_id,
        status: run.status,
        startedAt: Number(run.started_at),
        ...(run.finished_at !== null
          ? { finishedAt: Number(run.finished_at) }
          : {}),
        ...(run.error_code !== null ? { errorCode: run.error_code } : {}),
        ...(run.output !== null ? { output: run.output } : {}),
        events,
        ...(rows.length > eventPageSize
          ? { nextAfter: events[events.length - 1].sequence }
          : {}),
      };
    });
  }

  private async write(
    signal: AbortSignal,
    query: string,
    values: unknown[],
  ): Promise<void> {
    await this.withClient(signal, (client) => client.query(query, values));
  }

  private async withClient<T>(
    signal: AbortSignal | undefined,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const client = await this.pool.connect();
    try {
      signal?.throwIfAborted();
      return await work(client);
    } finally {
      client.release();
    }
  }

  private async transaction<T>(
    signal: AbortSignal | undefined,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.withClient(signal, async (client) => {
      await client.query("BEGIN");
      try {
        const result = await work(client);
        signal?.throwIfAborted();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }
}
