import type { AiCaller } from "./ai-execution-context.js";

export interface AiConversationTurn {
  readonly user: string;
  readonly assistant: string;
}

export interface AiStoredConversationTurn extends AiConversationTurn {
  readonly id: string;
  readonly tools: readonly string[];
  readonly toolIds: readonly string[];
}

export interface AiConversationTurnRecord extends AiStoredConversationTurn {
  readonly position: number;
}

export type AiConversationTurnQuery = {
  readonly after: number;
  readonly limit: number;
} & (
  | { readonly order: "ascending" }
  | { readonly order: "descending"; readonly before?: number }
);

export interface AiConversationSession {
  readonly id: string;
  readonly caller: AiCaller;
}

export interface AiConversationPage {
  readonly turns: readonly AiStoredConversationTurn[];
  readonly nextAfter?: number;
}

export interface AiConversationSummary {
  readonly sessionId: string;
  readonly preview: string;
  /** Start time of the last saved turn's run, or zero when bookkeeping is unavailable. */
  readonly updatedAt: number;
}

export interface AiConversationListQuery {
  readonly before?: Pick<AiConversationSummary, "sessionId" | "updatedAt">;
  readonly limit: number;
}

export interface AiConversationListPage {
  readonly conversations: readonly AiConversationSummary[];
  readonly nextAfter?: string;
}
