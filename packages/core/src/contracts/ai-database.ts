import type {
  AiConversationListQuery,
  AiConversationSession,
  AiConversationSummary,
  AiConversationTurnQuery,
  AiConversationTurnRecord,
  AiStoredConversationTurn,
} from "./ai-conversation.js";
import type { AiCaller } from "./ai-execution-context.js";
import type { AiUsage } from "./ai-model.js";

export interface AiDatabaseOptions {
  readonly adapter: AiDatabaseAdapter;
}

export type AiRunOutcome =
  "succeeded" | "failed" | "rejected" | "cancelled" | "timed_out";

export type AiRunEventDetails = {
  readonly outcome: AiRunOutcome;
  readonly durationMs: number;
  readonly errorCode?: string;
} & (
  | { readonly kind: "model_call"; readonly usage?: AiUsage | undefined }
  | {
      readonly kind: "tool_attempt";
      readonly invocationId: string;
      readonly tool?: { readonly id: string; readonly name: string };
    }
);

export type AiRunEventRecord = AiRunEventDetails & {
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: number;
};

export interface AiRunPage {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: "running" | AiRunOutcome;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly errorCode?: string;
  readonly output?: string;
  readonly events: readonly AiRunEventRecord[];
  readonly nextAfter?: number;
}

type Result<T> = T | Promise<T>;

/** Persists the plugin's conversation and bookkeeping records using one database. */
export interface AiDatabaseAdapter {
  /** Atomically checks ownership and acquires the lease, creating the session if requested. */
  beginConversation(
    input: {
      readonly session: AiConversationSession;
      readonly runId: string;
      readonly create: boolean;
      readonly leaseUntil: number;
    },
    signal: AbortSignal,
  ): Result<{ status: "ready" | "unavailable" | "busy" }>;

  /** Atomically appends a turn or releases the lease held by this run and owner. */
  finishConversation(
    input: {
      readonly session: AiConversationSession;
      readonly runId: string;
    } & (
      | {
          readonly turn: AiStoredConversationTurn;
          readonly discardIfEmpty?: never;
        }
      | { readonly turn?: never; readonly discardIfEmpty: boolean }
    ),
    signal: AbortSignal,
  ): Result<void>;

  /** Returns unmodified turns in the requested order with exclusive position bounds, or undefined if inaccessible. */
  listConversationTurns(
    session: AiConversationSession,
    query: AiConversationTurnQuery,
    signal: AbortSignal,
  ): Result<readonly AiConversationTurnRecord[] | undefined>;

  /** Lists conversations with saved turns for the exact owner, ordered by updatedAt and sessionId descending. */
  listConversations?(
    caller: AiCaller,
    query: AiConversationListQuery,
    signal: AbortSignal,
  ): Result<readonly AiConversationSummary[]>;

  startRun(runId: string, startedAt: number, signal: AbortSignal): Result<void>;
  attachRunSession(
    runId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Result<void>;
  /** Resolve after the event is committed. */
  appendRunEvent(event: AiRunEventRecord, signal: AbortSignal): Result<void>;
  finishRun(
    runId: string,
    result: {
      readonly outcome: AiRunOutcome;
      readonly finishedAt: number;
      readonly errorCode?: string;
    },
    signal: AbortSignal,
  ): Result<void>;

  /** Pages committed events for a run owned by the verified subject and tenant. */
  readRun(
    runId: string,
    caller: AiCaller,
    after: number,
    signal: AbortSignal,
  ): Result<AiRunPage | undefined>;
}
