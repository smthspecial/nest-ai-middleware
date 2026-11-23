import { randomUUID } from "node:crypto";
import type { AiRuntimeLimits } from "../config/runtime-limits.js";
import type {
  AiMessage,
  AiModel,
  AiModelResponse,
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

type ValidatedToolCall = AiToolCall & { arguments: JsonObject };
type ToolCallResponse = Extract<AiModelResponse, { kind: "tool-calls" }>;
type ModelAnswer = Pick<AiRunResult, "message" | "tools" | "toolIds">;
type UsedTool = { name: string; id: string };

interface ModelLoopOptions {
  messages: AiMessage[];
  model: AiModel;
  executor: AiToolExecutor;
  run: AiRunContext;
  runOptions: AiRunOptions;
  limits: AiRuntimeLimits;
}

interface ToolCallState {
  availableToolIds: ReadonlyMap<string, string>;
  seenCallIds: Set<string>;
  usedTools: UsedTool[];
}

const chatResponseInstructions = [
  "Use an available tool when the request needs fresh application data or asks you to perform an application action.",
  "Answer directly when the conversation already gives you enough information.",
  "For requests outside the application's domain, use its fallback or briefly explain what you can help with.",
].join(" ");

export function assertAnswerText(
  value: unknown,
  maxAnswerBytes: number,
): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maxAnswerBytes) {
    throw new AiModelError("MODEL_PROTOCOL_ERROR");
  }
}

export async function runModelLoop(
  options: ModelLoopOptions,
): Promise<ModelAnswer> {
  const { messages, model, executor, run, limits } = options;
  messages.unshift({ role: "system", content: chatResponseInstructions });
  const tools = await executor.discover(
    run.invocation,
    run.invocation.abortSignal,
  );
  const toolState: ToolCallState = {
    availableToolIds: new Map(tools.map(({ name, id }) => [name, id])),
    seenCallIds: new Set(),
    usedTools: [],
  };

  for (let round = 1; round <= limits.maxModelRounds; round++) {
    const response = await run.callModel(model, {
      messages: structuredClone(messages),
      tools: structuredClone(tools),
    });

    if (response?.kind === "final") {
      return finalizeAnswer(
        response.message,
        toolState.usedTools,
        limits.maxAnswerBytes,
      );
    }

    if (response?.kind !== "tool-calls" || round === limits.maxModelRounds) {
      break;
    }

    await runToolRound(response, options, toolState);
  }

  throw new AiModelError("MODEL_PROTOCOL_ERROR");
}

function finalizeAnswer(
  message: string,
  usedTools: readonly UsedTool[],
  maxAnswerBytes: number,
): ModelAnswer {
  assertAnswerText(message, maxAnswerBytes);
  return {
    message,
    tools: Object.freeze(usedTools.map(({ name }) => name)),
    toolIds: Object.freeze(usedTools.map(({ id }) => id)),
  };
}

async function runToolRound(
  response: ToolCallResponse,
  { messages, executor, run, runOptions, limits }: ModelLoopOptions,
  { availableToolIds, seenCallIds, usedTools }: ToolCallState,
): Promise<void> {
  const calls = validateToolCalls(response.toolCalls, seenCallIds, limits);
  screenToolRequest(response.message, calls, run, limits.maxAnswerBytes);

  const { message, continuation } = response;
  messages.push({
    role: "assistant",
    toolCalls: calls,
    ...(message ? { content: message } : {}),
    ...(continuation === undefined
      ? {}
      : { continuation: snapshot(continuation, limits.maxJsonDepth) }),
  });

  for (const call of calls) {
    const toolId = availableToolIds.get(call.name);
    const result = await invokeTool(executor, call, toolId, run, runOptions);
    if (result.ok && toolId) {
      usedTools.push({ name: call.name, id: toolId });
    }

    messages.push({ role: "tool", callId: call.id, name: call.name, result });
  }
}

function validateToolCalls(
  calls: readonly AiToolCall[],
  seenCallIds: Set<string>,
  { maxToolCalls, maxJsonDepth }: AiRuntimeLimits,
): ValidatedToolCall[] {
  if (
    !Array.isArray(calls) ||
    !calls.length ||
    seenCallIds.size + calls.length > maxToolCalls
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
    const args = snapshot(call.arguments, maxJsonDepth);
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
  maxAnswerBytes: number,
): void {
  if (message !== undefined) {
    assertAnswerText(message, maxAnswerBytes);
    run.screenOutput(message);
  }

  // Screen the entire batch before any tool can run.
  for (const call of calls) {
    run.screenOutput(call.arguments);
  }
}

async function invokeTool(
  executor: AiToolExecutor,
  call: AiToolCall,
  toolId: string | undefined,
  run: AiRunContext,
  runOptions: AiRunOptions,
): Promise<AiToolResult> {
  run.invocation.abortSignal.throwIfAborted();
  const invocationId = randomUUID();
  const startedAt = performance.now();
  const { name } = call;
  const { result, securityError } = await attemptToolCall(
    executor,
    call,
    toolId,
    run.invocation,
  );

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

async function attemptToolCall(
  executor: AiToolExecutor,
  { name, arguments: input }: AiToolCall,
  toolId: string | undefined,
  invocation: AiRunContext["invocation"],
): Promise<{ result: AiToolResult; securityError?: AiSecurityError }> {
  if (!toolId) return { result: { ok: false, code: "TOOL_UNAVAILABLE" } };

  try {
    const data = await executor.execute(name, input, invocation);
    return { result: { ok: true, data } };
  } catch (error) {
    if (error instanceof AiSecurityError) {
      return { result: { ok: false, code: error.code }, securityError: error };
    }
    const code = error instanceof AiToolError ? error.code : "TOOL_FAILED";
    return { result: { ok: false, code } };
  }
}
