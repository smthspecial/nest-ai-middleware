interface AiLogContext {
  readonly runId: string;
  readonly sessionId?: string;
  readonly subjectId: string;
  readonly tenantId?: string;
  readonly at: string;
}

export type AiLogDetail =
  | { stage: "input"; message: string }
  | {
      stage: "reasoning";
      event: "tool";
      toolId?: string;
      invocationId: string;
      outcome: "succeeded" | "rejected";
      code?: string;
    }
  | { stage: "reasoning"; event: "run_rejected"; code: string }
  | {
      stage: "reasoning";
      event: "bookkeeping_error";
      code: "STORE_UNAVAILABLE";
    }
  | { stage: "output"; message: string; toolIds: readonly string[] };

export type AiLogEvent = AiLogContext & AiLogDetail;

export interface AiLogger {
  log(event: AiLogEvent): void | Promise<void>;
}
