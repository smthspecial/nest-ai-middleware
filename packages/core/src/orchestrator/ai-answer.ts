import { randomUUID } from "node:crypto";
import type {
  AiMessage,
  AiModel,
  AiToolCall,
  AiToolResult,
} from "../contracts/ai-model.js";
import type { AiRunOptions, AiRunResult } from "../contracts/ai-run.js";
import type { JsonObject } from "../contracts/json.types.js";
import { AiToolError, snapshot } from "../executor/ai-tool-executor.js";
import type { AiToolExecutor } from "../executor/ai-tool-executor.js";
import { AiModelError } from "../model/ai-model-error.js";
import { AiSecurityError } from "../security/prompt-security.js";
import type { AiRunContext } from "./ai-run-context.js";

const MAX_MODEL_ROUNDS = 10;
const MAX_TOOL_CALLS = 20;
const MAX_ANSWER_BYTES = 32_768;

type ValidatedToolCall = AiToolCall & { arguments: JsonObject };

export function assertAnswerText(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > MAX_ANSWER_BYTES
  ) {
    throw new AiModelError("MODEL_PROTOCOL_ERROR");
  }
}

export async function generateAnswer({
  messages,
  model,
  executor,
  run,
  runOptions,
}: {
  messages: AiMessage[];
  model: AiModel;
  executor: AiToolExecutor;
  run: AiRunContext;
  runOptions: AiRunOptions;
}): Promise<Pick<AiRunResult, "message" | "tools" | "toolIds">> {
  const tools = model.capabilities.toolCalling
    ? await executor.discover(run.invocation, run.invocation.abortSignal)
    : [];
  const availableToolIds = new Map(tools.map(({ name, id }) => [name, id]));
  const seenCallIds = new Set<string>();
  const usedTools: { name: string; id: string }[] = [];

  for (let round = 1; round <= MAX_MODEL_ROUNDS; round++) {
    const response = await run.callModel(model, {
      messages: structuredClone(messages),
      tools: structuredClone(tools),
    });

    if (response?.kind === "final") {
      assertAnswerText(response.message);

      return {
        message: response.message,
        tools: Object.freeze(usedTools.map(({ name }) => name)),
        toolIds: Object.freeze(usedTools.map(({ id }) => id)),
      };
    }

    if (response?.kind !== "tool-calls" || round === MAX_MODEL_ROUNDS) {
      break;
    }

    const calls = validateToolCalls(response.toolCalls, seenCallIds);
    screenToolRequest(response.message, calls, run);

    messages.push({
      role: "assistant",
      toolCalls: calls,
      ...(response.message ? { content: response.message } : {}),
      ...(response.continuation === undefined
        ? {}
        : { continuation: snapshot(response.continuation) }),
    });

    for (const call of calls) {
      const toolId = availableToolIds.get(call.name);
      const result = await invokeTool(executor, call, toolId, run, runOptions);
      if (result.ok && toolId) {
        usedTools.push({ name: call.name, id: toolId });
      }

      messages.push({
        role: "tool",
        callId: call.id,
        name: call.name,
        result,
      });
    }
  }

  throw new AiModelError("MODEL_PROTOCOL_ERROR");
}

function validateToolCalls(
  calls: readonly AiToolCall[],
  seenCallIds: Set<string>,
): ValidatedToolCall[] {
  if (
    !Array.isArray(calls) ||
    !calls.length ||
    seenCallIds.size + calls.length > MAX_TOOL_CALLS
  ) {
    throw new AiModelError("MODEL_PROTOCOL_ERROR");
  }

  return calls.map((call: AiToolCall) => {
    if (
      !call ||
      typeof call.id !== "string" ||
      !call.id ||
      call.id.length > 128 ||
      typeof call.name !== "string" ||
      call.name.length > 64 ||
      seenCallIds.has(call.id)
    ) {
      throw new AiModelError("MODEL_PROTOCOL_ERROR");
    }
    const args = snapshot(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new AiModelError("MODEL_PROTOCOL_ERROR");
    }
    seenCallIds.add(call.id);
    return { id: call.id, name: call.name, arguments: args };
  });
}

function screenToolRequest(
  message: string | undefined,
  calls: readonly ValidatedToolCall[],
  run: AiRunContext,
): void {
  if (message !== undefined) {
    assertAnswerText(message);
    run.screenOutput(message);
  }

  // Screen the entire batch before any tool can run.
  for (const call of calls) {
    run.screenOutput(call.arguments);
  }
}

async function invokeTool(
  executor: AiToolExecutor,
  { name, arguments: input }: AiToolCall,
  toolId: string | undefined,
  run: AiRunContext,
  runOptions: AiRunOptions,
): Promise<AiToolResult> {
  run.invocation.abortSignal.throwIfAborted();
  const invocationId = randomUUID();
  const startedAt = performance.now();
  let result: AiToolResult;
  let securityError: AiSecurityError | undefined;

  try {
    if (!toolId) throw new AiToolError("TOOL_UNAVAILABLE");
    const data = await executor.execute(name, input, run.invocation);
    result = { ok: true, data };
  } catch (error) {
    if (error instanceof AiSecurityError) securityError = error;
    const code =
      error instanceof AiSecurityError || error instanceof AiToolError
        ? error.code
        : "TOOL_FAILED";
    result = { ok: false, code };
  }

  await run.record?.append({
    kind: "tool_attempt",
    invocationId,
    ...(toolId ? { tool: { id: toolId, name } } : {}),
    durationMs: performance.now() - startedAt,
    outcome: result.ok ? "succeeded" : run.failureOutcome(result.code),
    ...(!result.ok ? { errorCode: result.code } : {}),
  });

  if (securityError) throw securityError;

  await run.log({
    stage: "reasoning",
    event: "tool",
    invocationId,
    ...(toolId ? { toolId } : {}),
    outcome: result.ok ? "succeeded" : "rejected",
    ...(!result.ok ? { code: result.code } : {}),
  });

  if (result.ok && toolId) {
    runOptions.onToolResult?.({
      name,
      toolId,
      invocationId,
      data: result.data,
    });
  }

  return result;
}
