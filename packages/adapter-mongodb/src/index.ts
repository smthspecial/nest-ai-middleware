import { readAiEnv, readAiIntegerEnv } from "nestjs-ai-middleware";
import type { ClientSession, Collection, MongoClient } from "mongodb";
import type {
  AiCaller,
  AiConversationListQuery,
  AiConversationSearchMatch,
  AiConversationSearchQuery,
  AiConversationSession,
  AiConversationSummary,
  AiConversationTurnQuery,
  AiConversationTurnRecord,
  AiDatabaseAdapter,
  AiRunEventRecord,
  AiRunOutcome,
  AiRunPage,
} from "nestjs-ai-middleware";
import { applyMongoMigrations } from "./migrations.js";

interface SessionDocument {
  _id: string;
  subjectId: string;
  tenantId: string | null;
  turnCount: number;
  leaseId: string | null;
  leaseUntil: number | null;
}

interface TurnDocument extends AiConversationTurnRecord {
  _id: string;
  sessionId: string;
}

interface RunDocument {
  _id: string;
  sessionId: string | null;
  status: "running" | AiRunOutcome;
  startedAt: number;
  finishedAt?: number;
  errorCode?: string;
}

interface RunEventDocument {
  _id: string;
  runId: string;
  sequence: number;
  invocationId?: string;
  payload: AiRunEventRecord;
}

const majority = { w: "majority" } as const;

function sessionOwner({ id, caller }: AiConversationSession) {
  return {
    _id: id,
    subjectId: caller.subjectId,
    tenantId: caller.tenantId ?? null,
  };
}

export class MongoDatabaseAdapter implements AiDatabaseAdapter {
  private readonly eventPageSize = readAiIntegerEnv(
    "RUN_EVENT_PAGE_SIZE",
    50,
    2_147_483_646,
  );
  private readonly previewChars = readAiIntegerEnv(
    "CONVERSATION_PREVIEW_CHARS",
    120,
  );
  private readonly bookkeepingOptions = {
    timeoutMS: readAiIntegerEnv("MONGODB_BOOKKEEPING_TIMEOUT_MS", 100),
    writeConcern: majority,
  };
  private readonly sessionOptions = {
    timeoutMS: readAiIntegerEnv("MONGODB_SESSION_TIMEOUT_MS", 5000),
    writeConcern: majority,
  };
  private readonly sessions: Collection<SessionDocument>;
  private readonly turns: Collection<TurnDocument>;
  private readonly runs: Collection<RunDocument>;
  private readonly events: Collection<RunEventDocument>;
  private readonly databaseName: string;

  constructor(
    private readonly client: MongoClient,
    databaseName = readAiEnv("MONGODB_DATABASE_NAME"),
  ) {
    if (typeof databaseName !== "string" || !databaseName.trim())
      throw new TypeError(
        "Pass a nonempty MongoDB database name or set NEST_AI_MONGODB_DATABASE_NAME.",
      );
    this.databaseName = databaseName;
    const db = client.db(databaseName, { readPreference: "primary" });
    this.sessions = db.collection("nest_ai_chat_sessions");
    this.turns = db.collection("nest_ai_chat_turns");
    this.runs = db.collection("nest_ai_runs");
    this.events = db.collection("nest_ai_run_events");
  }

  async initialize(): Promise<void> {
    await applyMongoMigrations(
      this.client.db(this.databaseName, {
        readPreference: "primary",
        writeConcern: majority,
      }),
    );
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
    signal.throwIfAborted();
    const owner = sessionOwner(session);
    if (create) {
      await this.sessions.insertOne(
        { ...owner, turnCount: 0, leaseId: runId, leaseUntil },
        this.sessionOptions,
      );
      return { status: "ready" } as const;
    }
    const claim = await this.sessions.updateOne(
      {
        ...owner,
        $or: [{ leaseId: null }, { leaseUntil: { $lte: Date.now() } }],
      },
      { $set: { leaseId: runId, leaseUntil } },
      this.sessionOptions,
    );
    if (claim.matchedCount) return { status: "ready" } as const;
    const exists = await this.sessions.findOne(owner, {
      projection: { _id: 1 },
      signal,
    });
    return { status: exists ? "busy" : "unavailable" } as const;
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
    const lease = { ...sessionOwner(session), leaseId: runId };
    await this.transaction(signal, async (transaction) => {
      const options = { session: transaction };
      const current = await this.sessions.findOne(lease, options);
      if (!current) {
        if (turn) throw new Error("Conversation lease is unavailable.");
        return;
      }
      if (discardIfEmpty && current.turnCount === 0) {
        await this.runs.updateMany(
          { sessionId: session.id },
          { $set: { sessionId: null } },
          options,
        );
        await this.sessions.deleteOne(lease, options);
        return;
      }
      if (turn) {
        await this.turns.insertOne(
          {
            ...turn,
            _id: turn.id,
            sessionId: session.id,
            position: current.turnCount + 1,
          },
          options,
        );
      }
      await this.sessions.updateOne(
        lease,
        {
          $set: {
            leaseId: null,
            leaseUntil: null,
            turnCount: current.turnCount + (turn ? 1 : 0),
          },
        },
        options,
      );
    });
  }

  async listConversationTurns(
    session: AiConversationSession,
    query: AiConversationTurnQuery,
    signal: AbortSignal,
  ): Promise<AiConversationTurnRecord[] | undefined> {
    signal.throwIfAborted();
    if (
      !(await this.sessions.findOne(sessionOwner(session), {
        projection: { _id: 1 },
        signal,
      }))
    )
      return;
    const descending = query.order === "descending";
    const rows = await this.turns
      .find(
        {
          sessionId: session.id,
          position: {
            $gt: query.after,
            ...(descending && query.before !== undefined
              ? { $lt: query.before }
              : {}),
          },
        },
        { signal },
      )
      .sort({ position: descending ? -1 : 1 })
      .limit(query.limit)
      .toArray();
    return rows.map(({ _id, sessionId: _sessionId, ...turn }) => turn);
  }

  async listConversations(
    caller: AiCaller,
    { before, limit }: AiConversationListQuery,
    signal: AbortSignal,
  ): Promise<AiConversationSummary[]> {
    signal.throwIfAborted();
    return this.sessions
      .aggregate<AiConversationSummary>(
        [
          {
            $match: {
              subjectId: caller.subjectId,
              tenantId: caller.tenantId ?? null,
              turnCount: { $gt: 0 },
            },
          },
          {
            $lookup: {
              from: this.turns.collectionName,
              localField: "_id",
              foreignField: "sessionId",
              as: "firstTurn",
              pipeline: [
                { $match: { position: 1 } },
                {
                  $project: {
                    preview: { $substrCP: ["$user", 0, this.previewChars] },
                  },
                },
              ],
            },
          },
          { $unwind: "$firstTurn" },
          {
            $lookup: {
              from: this.turns.collectionName,
              localField: "_id",
              foreignField: "sessionId",
              as: "lastTurn",
              let: { lastPosition: "$turnCount" },
              pipeline: [
                { $match: { $expr: { $eq: ["$position", "$$lastPosition"] } } },
                { $project: { _id: 1 } },
              ],
            },
          },
          { $unwind: "$lastTurn" },
          {
            $lookup: {
              from: this.runs.collectionName,
              localField: "lastTurn._id",
              foreignField: "_id",
              as: "lastRun",
              pipeline: [{ $project: { startedAt: 1 } }],
            },
          },
          {
            $project: {
              _id: 0,
              sessionId: "$_id",
              preview: "$firstTurn.preview",
              updatedAt: { $ifNull: [{ $first: "$lastRun.startedAt" }, 0] },
            },
          },
          ...(before
            ? [
                {
                  $match: {
                    $or: [
                      { updatedAt: { $lt: before.updatedAt } },
                      {
                        updatedAt: before.updatedAt,
                        sessionId: { $lt: before.sessionId },
                      },
                    ],
                  },
                },
              ]
            : []),
          { $sort: { updatedAt: -1, sessionId: -1 } },
          { $limit: limit },
        ],
        { signal },
      )
      .toArray();
  }

  async searchConversationTurns(
    caller: AiCaller,
    { excludeSessionId, keywords, limit }: AiConversationSearchQuery,
    signal: AbortSignal,
  ): Promise<AiConversationSearchMatch[]> {
    signal.throwIfAborted();
    const matches = keywords.map((keyword) => ({
      $cond: [
        {
          $regexMatch: {
            input: { $concat: ["$user", "\n", "$assistant"] },
            regex: keyword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
            options: "i",
          },
        },
        1,
        0,
      ],
    }));
    return this.sessions
      .aggregate<AiConversationSearchMatch>(
        [
          {
            $match: {
              _id: { $ne: excludeSessionId },
              subjectId: caller.subjectId,
              tenantId: caller.tenantId ?? null,
              turnCount: { $gt: 0 },
            },
          },
          {
            $lookup: {
              from: this.turns.collectionName,
              localField: "_id",
              foreignField: "sessionId",
              as: "turn",
              pipeline: [
                { $set: { score: { $sum: matches } } },
                { $match: { score: { $gt: 0 } } },
                {
                  $lookup: {
                    from: this.runs.collectionName,
                    localField: "_id",
                    foreignField: "_id",
                    as: "run",
                    pipeline: [{ $project: { startedAt: 1 } }],
                  },
                },
                {
                  $set: {
                    startedAt: {
                      $ifNull: [{ $first: "$run.startedAt" }, null],
                    },
                  },
                },
                { $sort: { score: -1, startedAt: -1, _id: -1 } },
                { $limit: limit },
                { $project: { score: 1, startedAt: 1, user: 1, assistant: 1 } },
              ],
            },
          },
          { $unwind: "$turn" },
          {
            $sort: {
              "turn.score": -1,
              "turn.startedAt": -1,
              _id: -1,
              "turn._id": -1,
            },
          },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              sessionId: "$_id",
              turnId: "$turn._id",
              startedAt: "$turn.startedAt",
              user: "$turn.user",
              assistant: "$turn.assistant",
            },
          },
        ],
        { signal },
      )
      .toArray();
  }

  async startRun(
    runId: string,
    startedAt: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.runs.insertOne(
      { _id: runId, sessionId: null, status: "running", startedAt },
      this.bookkeepingOptions,
    );
  }

  async attachRunSession(
    runId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.runs.updateOne(
      { _id: runId, status: "running" },
      { $set: { sessionId } },
      this.bookkeepingOptions,
    );
  }

  async appendRunEvent(
    event: AiRunEventRecord,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.events.insertOne(
      {
        _id: `${event.runId}:${event.sequence}`,
        runId: event.runId,
        sequence: event.sequence,
        ...(event.kind === "tool_attempt"
          ? { invocationId: event.invocationId }
          : {}),
        payload: event,
      },
      this.bookkeepingOptions,
    );
  }

  async finishRun(
    runId: string,
    result: Parameters<AiDatabaseAdapter["finishRun"]>[1],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.runs.updateOne(
      { _id: runId, status: "running" },
      {
        $set: {
          status: result.outcome,
          finishedAt: result.finishedAt,
          ...(result.errorCode !== undefined
            ? { errorCode: result.errorCode }
            : {}),
        },
      },
      this.bookkeepingOptions,
    );
  }

  async readRun(
    runId: string,
    caller: AiCaller,
    after: number,
    signal: AbortSignal,
  ): Promise<AiRunPage | undefined> {
    signal.throwIfAborted();
    const run = await this.runs.findOne({ _id: runId }, { signal });
    if (
      !run?.sessionId ||
      !(await this.sessions.findOne(
        sessionOwner({ id: run.sessionId, caller }),
        {
          projection: { _id: 1 },
          signal,
        },
      ))
    )
      return;
    const output = await this.turns.findOne(
      { _id: runId, sessionId: run.sessionId },
      { projection: { assistant: 1 }, signal },
    );
    const rows = await this.events
      .find({ runId, sequence: { $gt: after } }, { signal })
      .sort({ sequence: 1 })
      .limit(this.eventPageSize + 1)
      .toArray();
    const events = rows.slice(0, this.eventPageSize).map((row) => row.payload);
    return {
      runId,
      sessionId: run.sessionId,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
      ...(output ? { output: output.assistant } : {}),
      events,
      ...(rows.length > this.eventPageSize
        ? { nextAfter: events[events.length - 1].sequence }
        : {}),
    };
  }

  private transaction<T>(
    signal: AbortSignal,
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    return this.client.withSession((session) =>
      session.withTransaction(async () => {
        signal.throwIfAborted();
        const result = await work(session);
        signal.throwIfAborted();
        return result;
      }, this.sessionOptions),
    );
  }
}
