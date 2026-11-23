import type { AiRunOutcome } from "../contracts/ai-database.js";
import type { AiExecutionContext } from "../contracts/ai-execution-context.js";
import type { AiLogDetail } from "../contracts/ai-logger.js";
import type {
  AiModel,
  AiModelRequest,
  AiModelResponse,
} from "../contracts/ai-model.js";
import type { JsonValue } from "../contracts/json.types.js";
import { withSignal } from "../executor/with-signal.js";
import type { AiRunBookkeeping } from "../logging/ai-run-bookkeeping.js";
import { AiModelError } from "../model/ai-model-error.js";
import { AiSecurityError } from "../security/prompt-security.js";
import type { AiPromptSecurity } from "../security/prompt-security.js";

const rejectedCodes = new Set([
  "SECURITY_REJECTED",
  "SESSION_UNAVAILABLE",
  "SESSION_BUSY",
  "DENIED",
  "TOOL_UNAVAILABLE",
  "INVALID_ARGUMENTS",
  "ATTACHMENT_NOT_FOUND",
  "ATTACHMENT_NOT_CONFIGURED",
  "ATTACHMENT_STORAGE_NOT_CONFIGURED",
]);
const timeoutCodes = new Set(["MODEL_TIMEOUT", "TOOL_TIMEOUT"]);

export class AiRunContext {
  constructor(
    private readonly request: AiExecutionContext,
    readonly invocation: AiExecutionContext & { abortSignal: AbortSignal },
    private readonly security: AiPromptSecurity,
    readonly record: Awaited<ReturnType<AiRunBookkeeping["start"]>>,
    readonly log: (detail: AiLogDetail) => Promise<void>,
  ) {}

  failureOutcome(code: string): AiRunOutcome {
    if (rejectedCodes.has(code)) return "rejected";
    if (this.request.abortSignal?.aborted) return "cancelled";
    if (timeoutCodes.has(code)) return "timed_out";
    return "failed";
  }

  screenInput(content: JsonValue): void {
    this.security.assertInputAllowed(content, this.invocation.abortSignal);
  }

  screenOutput(content: JsonValue): void {
    this.security.assertOutputAllowed(content, this.invocation.abortSignal);
  }

  async callModel(
    model: AiModel,
    request: Omit<AiModelRequest, "abortSignal">,
  ): Promise<AiModelResponse> {
    const { abortSignal } = this.invocation;
    const startedAt = performance.now();
    const response = await withSignal(abortSignal, () =>
      model.generate({ ...request, abortSignal }),
    ).catch(async (error: unknown) => {
      const failure =
        error instanceof AiModelError || error instanceof AiSecurityError
          ? error
          : new AiModelError(
              abortSignal.aborted ? "MODEL_TIMEOUT" : "MODEL_UNAVAILABLE",
            );
      await this.record?.append({
        kind: "model_call",
        outcome: this.failureOutcome(failure.code),
        durationMs: performance.now() - startedAt,
        errorCode: failure.code,
      });
      throw failure;
    });

    await this.record?.append({
      kind: "model_call",
      outcome: "succeeded",
      durationMs: performance.now() - startedAt,
      usage: response?.usage,
    });
    return response;
  }
}
