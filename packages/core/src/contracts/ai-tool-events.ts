import type { AiCaller } from './ai-authorization-policy.js';
import type { AiRunOutcome } from './ai-database.js';

export interface AiToolEvent {
  readonly type: 'ai.tool.completed.v1';
  readonly eventId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly toolId: string;
  readonly outcome: AiRunOutcome;
  readonly occurredAt: number;
  readonly durationMs: number;
  readonly errorCode?: string;
}

export interface AiToolSubscriptionOptions {
  /** Subscription principal established by the host application. */
  readonly caller: AiCaller;
  readonly toolIds: readonly string[];
  readonly outcomes?: readonly AiRunOutcome[];
}

export type AiToolEventHandler = (event: AiToolEvent, signal: AbortSignal) => void | Promise<void>;
