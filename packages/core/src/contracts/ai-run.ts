import type { AiConversationTurn } from './ai-conversation.js';
import type { JsonValue } from './json.types.js';

export interface AiRunResult {
  readonly message: string;
  readonly tools: readonly string[];
  readonly toolIds: readonly string[];
  readonly runId: string;
  readonly sessionId?: string;
}

export interface AiRunOptions {
  readonly history?: readonly AiConversationTurn[];
  readonly sessionId?: string;
  readonly onToolResult?: (result: { name: string; toolId: string; invocationId: string; data: JsonValue }) => void;
  readonly presentAnswer?: (result: AiRunResult) => string;
}
