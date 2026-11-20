import type { ContextId } from "@nestjs/core";

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
