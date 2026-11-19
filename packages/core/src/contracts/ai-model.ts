import type { JsonObject, JsonValue } from './json.types.js';

export interface AiToolDefinition {
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly useWhen?: readonly string[];
  readonly avoidWhen?: readonly string[];
  readonly tags?: readonly string[];
  readonly examples?: readonly { user: string; arguments: JsonObject }[];
}

export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type AiToolResult =
  | { ok: true; data: JsonValue }
  | { ok: false; code: string };

export type AiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls?: readonly AiToolCall[] }
  | { role: 'tool'; callId: string; name: string; result: AiToolResult };

export interface AiModelRequest {
  readonly messages: readonly AiMessage[];
  readonly tools: readonly AiToolDefinition[];
  readonly abortSignal?: AbortSignal;
  readonly responseSchema?: JsonObject;
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type AiModelResponse = (
  | { kind: 'final'; message: string; structuredOutput?: unknown }
  | { kind: 'tool-calls'; message?: string; toolCalls: readonly AiToolCall[] }
) & { usage?: AiUsage };

export interface AiModel {
  readonly capabilities: {
    readonly toolCalling: boolean;
    readonly structuredOutput?: boolean;
  };
  generate(request: AiModelRequest): Promise<AiModelResponse>;
}

export type AiToolOptions = AiToolDefinition & (
  | { readonly readOnly: true; readonly operation?: 'get' }
  | { readonly readOnly: false; readonly operation: 'create' | 'update' }
);
