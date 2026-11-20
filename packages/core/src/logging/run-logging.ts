import type { AiCaller } from "../contracts/ai-execution-context.js";
import { withSignal } from "../executor/with-signal.js";
import type { AiLogDetail, AiLogger } from "../contracts/ai-logger.js";

export async function writeRunLog(
  logger: AiLogger | undefined,
  runId: string,
  sessionId: string | undefined,
  caller: AiCaller,
  detail: AiLogDetail,
): Promise<void> {
  if (!logger) return;
  try {
    await withSignal(AbortSignal.timeout(100), () =>
      logger.log({
        runId,
        ...(sessionId ? { sessionId } : {}),
        subjectId: caller.subjectId,
        ...(caller.tenantId !== undefined ? { tenantId: caller.tenantId } : {}),
        at: new Date().toISOString(),
        ...detail,
      }),
    );
  } catch {
    // The host owns its logging sink and can monitor its availability independently.
  }
}
