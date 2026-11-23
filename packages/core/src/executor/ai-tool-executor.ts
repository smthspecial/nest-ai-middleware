import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { AiToolRegistry } from "../config/ai-tool-registry.js";
import type { RegisteredAiTool } from "../config/ai-tool-registry.js";
import { AI_MODULE_OPTIONS } from "../config/validate-options.js";
import type { ValidatedAiModuleOptions } from "../config/validate-options.js";
import type { AiExecutionContext } from "../contracts/ai-execution-context.js";
import type { AiToolDefinition } from "../contracts/ai-model.js";
import type { JsonObject, JsonValue } from "../contracts/json.types.js";
import {
  AiPromptSecurity,
  AiSecurityError,
} from "../security/prompt-security.js";
import { canActivateService } from "./service-guards.js";
import { withSignal } from "./with-signal.js";

export class AiToolError extends Error {
  constructor(
    readonly code:
      | "TOOL_UNAVAILABLE"
      | "INVALID_ARGUMENTS"
      | "DENIED"
      | "TOOL_TIMEOUT"
      | "TOOL_FAILED",
  ) {
    super(code);
  }
}

export function snapshot(value: unknown, maxDepth: number): JsonValue {
  const ancestors = new Set<object>();
  function copy(entry: unknown, depth: number): JsonValue {
    if (depth > maxDepth) throw new TypeError("JSON nesting limit exceeded");
    if (
      entry === null ||
      typeof entry === "boolean" ||
      typeof entry === "string"
    )
      return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (!entry || typeof entry !== "object" || ancestors.has(entry))
      throw new TypeError("Invalid JSON");
    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        const result = Array.from(entry, (item) => copy(item, depth + 1));
        Object.freeze(result);
        return result;
      }
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== null && prototype !== Object.prototype)
        throw new TypeError("Invalid JSON object");
      const result: JsonObject = {};
      for (const key in entry) {
        if (!Object.hasOwn(entry, key)) continue;
        if (key === "__proto__" || key === "prototype" || key === "constructor")
          throw new TypeError("Invalid JSON key");
        const prop = Object.getOwnPropertyDescriptor(entry, key);
        if (!prop || !("value" in prop))
          throw new TypeError("Invalid JSON property");
        result[key] = copy(prop.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(entry);
    }
  }
  return copy(value, 0);
}

function validateToolInput(
  tool: RegisteredAiTool,
  input: unknown,
  maxDepth: number,
): JsonObject {
  const args = snapshotToolInput(input, maxDepth);
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    !tool.validate(args)
  ) {
    throw new AiToolError("INVALID_ARGUMENTS");
  }
  return args;
}

function snapshotToolInput(input: unknown, maxDepth: number): JsonValue {
  try {
    return snapshot(input, maxDepth);
  } catch {
    throw new AiToolError("INVALID_ARGUMENTS");
  }
}

@Injectable()
export class AiToolExecutor {
  constructor(
    @Inject(AI_MODULE_OPTIONS)
    private readonly options: ValidatedAiModuleOptions,
    private readonly registry: AiToolRegistry,
    private readonly security: AiPromptSecurity,
  ) {}

  async discover(
    context: AiExecutionContext,
    signal: AbortSignal,
  ): Promise<(AiToolDefinition & { id: string })[]> {
    if (!context.caller.subjectId.trim()) return [];
    const availableTools: (AiToolDefinition & { id: string })[] = [];
    for (const tool of this.registry.values()) {
      if (await this.guardsAllow(tool, context, signal))
        availableTools.push(structuredClone(tool.definition));
    }
    return availableTools;
  }

  async execute(
    name: string,
    input: unknown,
    context: AiExecutionContext,
  ): Promise<JsonValue> {
    const tool = this.registry.get(name);
    if (!tool) throw new AiToolError("TOOL_UNAVAILABLE");
    if (!context.caller.subjectId.trim()) throw new AiToolError("DENIED");

    const args = validateToolInput(
      tool,
      input,
      this.options.limits.maxJsonDepth,
    );
    const timeout = AbortSignal.timeout(this.options.execution.toolTimeoutMs);
    const signal = AbortSignal.any([
      timeout,
      ...(context.abortSignal ? [context.abortSignal] : []),
    ]);
    const invocation = { ...context, abortSignal: signal };

    try {
      if (!(await this.guardsAllow(tool, invocation, signal))) {
        throw new AiToolError("DENIED");
      }

      this.security.assertOutputAllowed(args, signal);
      const result = await this.invokeServiceMethod(
        tool,
        args,
        context,
        signal,
      );

      this.security.assertInputAllowed(result, signal);
      return result;
    } catch (error) {
      if (error instanceof AiSecurityError) throw error;
      if (signal.aborted) throw new AiToolError("TOOL_TIMEOUT");
      if (error instanceof AiToolError) throw error;
      if (error instanceof BadRequestException)
        throw new AiToolError("INVALID_ARGUMENTS");
      throw new AiToolError("TOOL_FAILED");
    }
  }

  private async guardsAllow(
    tool: RegisteredAiTool,
    context: AiExecutionContext,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      return await withSignal(signal, () =>
        canActivateService(
          tool.guards,
          tool.service,
          tool.method,
          tool.owner,
          context,
          signal,
        ),
      );
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }

  private async invokeServiceMethod(
    tool: RegisteredAiTool,
    args: JsonObject,
    context: AiExecutionContext,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const instance = await withSignal(signal, () =>
      tool.owner.resolve(tool.service, context.contextId, { strict: true }),
    );
    signal.throwIfAborted();
    if (Reflect.get(instance as object, tool.key) !== tool.method)
      throw new AiToolError("TOOL_UNAVAILABLE");
    const result = await withSignal(signal, () =>
      tool.method.call(instance, args),
    );
    return snapshot(result, this.options.limits.maxJsonDepth);
  }
}
