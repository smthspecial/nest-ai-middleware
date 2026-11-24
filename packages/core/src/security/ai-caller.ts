import type { AiCaller } from "../contracts/ai-execution-context.js";

export function snapshotAiCaller(
  caller: AiCaller | undefined,
): AiCaller | undefined {
  const { subjectId, tenantId } = caller ?? {};
  if (
    typeof subjectId !== "string" ||
    !subjectId.trim() ||
    (tenantId !== undefined && typeof tenantId !== "string")
  ) {
    return;
  }
  return Object.freeze({
    subjectId,
    ...(tenantId === undefined ? {} : { tenantId }),
  });
}
