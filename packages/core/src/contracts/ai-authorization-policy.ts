import type { ContextId } from '@nestjs/core';
import type { JsonObject } from './json.types.js';
import type { AiToolEvent } from './ai-tool-events.js';

export interface AiCaller {
  readonly subjectId: string;
  readonly tenantId?: string;
}

export interface AiExecutionContext {
  readonly caller: AiCaller;
  readonly contextId: ContextId;
  readonly abortSignal?: AbortSignal;
  readonly http?: { readonly request: object; readonly response?: object };
}

export type AiToolOperation = 'get' | 'create' | 'update';

export interface AiToolPolicyInput {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly string[];
  readonly readOnly: boolean;
  readonly operation: AiToolOperation;
}

export interface AiAuthorizationPolicy {
  canDiscover?(input: { context: AiExecutionContext; tool: AiToolPolicyInput }): boolean | Promise<boolean>;
  canExecute(input: {
    context: AiExecutionContext;
    tool: AiToolPolicyInput;
    args: Readonly<JsonObject>;
  }): boolean | Promise<boolean>;
  canObserveToolEvent?(input: {
    readonly subscriber: AiCaller;
    readonly owner: AiCaller;
    readonly event: AiToolEvent;
    readonly signal: AbortSignal;
  }): boolean | Promise<boolean>;
}
