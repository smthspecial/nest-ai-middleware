import type { AiCaller } from './ai-authorization-policy.js';

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
  | { readonly order: 'ascending' }
  | { readonly order: 'descending'; readonly before?: number }
);

export interface AiConversationSession {
  readonly id: string;
  readonly caller: AiCaller;
}

export interface AiConversationPage {
  readonly turns: readonly AiStoredConversationTurn[];
  readonly nextAfter?: number;
}

