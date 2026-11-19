import type { AiCaller } from './ai-authorization-policy.js';
import type { AiModel } from './ai-model.js';
import type { JsonValue } from './json.types.js';

export const AI_PROMPT_STAGES = ['input', 'history', 'model_output', 'tool_arguments', 'tool_result', 'output'] as const;

export type AiPromptStage = typeof AI_PROMPT_STAGES[number];

export interface AiPromptRule {
  readonly contains: string;
  readonly stages?: readonly AiPromptStage[];
}

export interface AiPromptSecurityPolicy {
  allow(input: {
    readonly stage: AiPromptStage;
    readonly content: JsonValue;
    readonly caller: AiCaller;
    readonly signal: AbortSignal;
  }): boolean | Promise<boolean>;
}

export type AiPromptRejection = 'close' | 'respond';

export interface AiPromptClassifierOptions {
  readonly model: AiModel;
  readonly stages?: readonly AiPromptStage[];
  readonly timeoutMs?: number;
}

export interface AiPromptSecurityOptions extends Partial<AiPromptSecurityPolicy> {
  enabled?: boolean;
  builtInChecks?: boolean;
  rejection?: AiPromptRejection;
  rules?: readonly AiPromptRule[];
  classifier?: AiPromptClassifierOptions;
}
