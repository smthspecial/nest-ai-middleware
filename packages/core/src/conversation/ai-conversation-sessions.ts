import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AI_MODULE_OPTIONS } from "../config/validate-options.js";
import type { ValidatedAiModuleOptions } from "../config/validate-options.js";
import type { AiCaller } from "../contracts/ai-execution-context.js";
import type { AiDatabaseAdapter } from "../contracts/ai-database.js";
import { AiDatabase } from "../database/ai-database.js";
import { withSignal } from "../executor/with-signal.js";
import { AiConversationError, isAiSessionId } from "./ai-conversation-error.js";
import type {
  AiConversationListPage,
  AiConversationListQuery,
  AiConversationPage,
  AiConversationSession,
  AiConversationTurn,
  AiConversationTurnQuery,
  AiStoredConversationTurn,
} from "../contracts/ai-conversation.js";

@Injectable()
export class AiConversationSessions {
  constructor(
    private readonly database: AiDatabase,
    @Inject(AI_MODULE_OPTIONS)
    private readonly options: ValidatedAiModuleOptions,
  ) {}

  get enabled(): boolean {
    return this.database.adapter !== undefined;
  }

  async begin(
    caller: AiCaller,
    id: string | undefined,
    runId: string,
    signal: AbortSignal,
  ) {
    const store = this.requireStore();
    if (id !== undefined && !isAiSessionId(id))
      throw new AiConversationError("SESSION_UNAVAILABLE");
    const session = { id: id ?? randomUUID(), caller };
    const create = id === undefined;
    const result = await this.fromStore(signal, () =>
      store.beginConversation(
        {
          session,
          runId,
          create,
          leaseUntil: Date.now() + this.options.limits.runLeaseMs,
        },
        signal,
      ),
    );
    if (result.status !== "ready")
      throw new AiConversationError(
        result.status === "busy" ? "SESSION_BUSY" : "SESSION_UNAVAILABLE",
      );
    try {
      const history = create
        ? []
        : await this.loadHistory(store, session, signal);
      return { session, history };
    } catch (error) {
      await this.release(session, runId);
      throw error;
    }
  }

  private async loadHistory(
    store: AiDatabaseAdapter,
    session: AiConversationSession,
    signal: AbortSignal,
  ) {
    const history: AiConversationTurn[] = [];
    const { transcriptPageSize } = this.options.limits;
    let after = 0;
    for (;;) {
      const page = await this.listTurns(
        store,
        session,
        { order: "ascending", after, limit: transcriptPageSize },
        signal,
      );
      for (const { user, assistant } of page) history.push({ user, assistant });
      if (page.length < transcriptPageSize) return history;
      after = page[page.length - 1].position;
    }
  }

  async finish(
    session: AiConversationSession,
    runId: string,
    turn: AiStoredConversationTurn,
    signal: AbortSignal,
  ): Promise<void> {
    const store = this.requireStore();
    await this.fromStore(signal, () =>
      store.finishConversation({ session, runId, turn }, signal),
    );
  }

  async release(session: AiConversationSession, runId: string): Promise<void> {
    const signal = AbortSignal.timeout(
      this.options.limits.sessionReleaseTimeoutMs,
    );
    try {
      await withSignal(signal, () =>
        this.requireStore().finishConversation(
          { session, runId, discardIfEmpty: true },
          signal,
        ),
      );
    } catch {
      // An abandoned lease expires in the store.
    }
  }

  async read(
    id: string,
    caller: AiCaller,
    after = 0,
    signal = AbortSignal.timeout(this.options.limits.storeReadTimeoutMs),
  ): Promise<AiConversationPage> {
    if (!isAiSessionId(id) || !caller.subjectId.trim())
      throw new AiConversationError("SESSION_UNAVAILABLE");
    if (!Number.isSafeInteger(after) || after < 0)
      throw new TypeError("Invalid conversation cursor.");
    const { transcriptPageSize } = this.options.limits;
    const rows = await this.listTurns(
      this.requireStore(),
      { id, caller },
      {
        order: "ascending",
        after,
        limit: transcriptPageSize + 1,
      },
      signal,
    );
    const page = rows.slice(0, transcriptPageSize);
    return {
      turns: page.map(({ position: _position, ...turn }) => turn),
      ...(rows.length > transcriptPageSize
        ? { nextAfter: page[page.length - 1].position }
        : {}),
    };
  }

  async list(
    caller: AiCaller,
    after?: string,
    signal = AbortSignal.timeout(this.options.limits.storeReadTimeoutMs),
  ): Promise<AiConversationListPage> {
    if (!caller.subjectId.trim())
      throw new AiConversationError("SESSION_UNAVAILABLE");
    const store = this.requireStore();
    const list = store.listConversations;
    if (!list) throw new AiConversationError("SESSION_UNAVAILABLE");
    const { conversationPageSize } = this.options.limits;
    const query: AiConversationListQuery = {
      limit: conversationPageSize + 1,
      ...(after === undefined ? {} : { before: this.parseListCursor(after) }),
    };
    const rows = await this.fromStore(signal, () =>
      list.call(store, caller, query, signal),
    );
    const conversations = rows.slice(0, conversationPageSize);
    const last = conversations.at(-1);
    return {
      conversations,
      ...(last && rows.length > conversationPageSize
        ? { nextAfter: `${last.updatedAt}.${last.sessionId}` }
        : {}),
    };
  }

  private parseListCursor(
    after: string,
  ): NonNullable<AiConversationListQuery["before"]> {
    const match = /^(\d{1,16})\.([a-f0-9-]{36})$/.exec(after);
    const updatedAt = Number(match?.[1]);
    const sessionId = match?.[2];
    if (!Number.isSafeInteger(updatedAt) || !isAiSessionId(sessionId))
      throw new TypeError("Invalid conversation cursor.");
    return { sessionId, updatedAt };
  }

  private async listTurns(
    store: AiDatabaseAdapter,
    session: AiConversationSession,
    query: AiConversationTurnQuery,
    signal: AbortSignal,
  ) {
    const rows = await this.fromStore(signal, () =>
      store.listConversationTurns(session, query, signal),
    );
    if (!rows) throw new AiConversationError("SESSION_UNAVAILABLE");
    return rows;
  }

  private requireStore(): AiDatabaseAdapter {
    const adapter = this.database.adapter;
    if (!adapter) throw new AiConversationError("SESSION_UNAVAILABLE");
    return adapter;
  }

  private async fromStore<T>(
    signal: AbortSignal,
    work: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await withSignal(signal, work);
    } catch {
      signal.throwIfAborted();
      throw new AiConversationError("STORE_UNAVAILABLE");
    }
  }
}
