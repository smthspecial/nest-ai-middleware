import { Inject, Injectable } from '@nestjs/common';
import { AiToolRegistry } from '../config/ai-tool-registry.js';
import type { RegisteredAiTool } from '../config/ai-tool-registry.js';
import { AI_MODULE_OPTIONS } from '../config/validate-options.js';
import type { ValidatedAiModuleOptions } from '../config/validate-options.js';
import type { AiExecutionContext } from '../contracts/ai-authorization-policy.js';
import type { AiToolDefinition } from '../contracts/ai-model.js';
import type { JsonObject, JsonValue } from '../contracts/json.types.js';
import { AiPromptSecurity, AiSecurityError } from '../security/prompt-security.js';
import { canActivateService } from './service-guards.js';
import { withSignal } from './with-signal.js';

export class AiToolError extends Error {
  constructor(readonly code: 'TOOL_UNAVAILABLE' | 'INVALID_ARGUMENTS' | 'DENIED' | 'TOOL_TIMEOUT' | 'TOOL_FAILED') {
    super(code);
  }
}

export function snapshot(value: unknown, maxBytes: number): JsonValue {
  let bytes = 0;
  const ancestors = new Set<object>();
  function copy(entry: unknown, depth: number): JsonValue {
    if (++bytes > maxBytes || depth > 24) throw new TypeError('JSON limit exceeded');
    if (entry === null || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (typeof entry === 'string') {
      bytes += Buffer.byteLength(entry);
      if (bytes > maxBytes) throw new TypeError('JSON limit exceeded');
      return entry;
    }
    if (!entry || typeof entry !== 'object' || ancestors.has(entry)) throw new TypeError('Invalid JSON');
    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (entry.length > maxBytes - bytes) throw new TypeError('JSON limit exceeded');
        const result = Array.from(entry, item => copy(item, depth + 1));
        Object.freeze(result);
        return result;
      }
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== null && prototype !== Object.prototype) throw new TypeError('Invalid JSON object');
      const result: JsonObject = {};
      for (const key in entry) {
        if (!Object.hasOwn(entry, key)) continue;
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new TypeError('Invalid JSON key');
        bytes += Buffer.byteLength(key);
        const prop = Object.getOwnPropertyDescriptor(entry, key);
        if (!prop || !('value' in prop)) throw new TypeError('Invalid JSON property');
        result[key] = copy(prop.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(entry);
    }
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new TypeError('JSON limit exceeded');
  return result;
}

@Injectable()
export class AiToolExecutor {
  constructor(
    @Inject(AI_MODULE_OPTIONS) private readonly options: ValidatedAiModuleOptions,
    private readonly registry: AiToolRegistry,
    private readonly security: AiPromptSecurity,
  ) {}

  async discover(context: AiExecutionContext, signal: AbortSignal): Promise<(AiToolDefinition & { id: string })[]> {
    const result: (AiToolDefinition & { id: string })[] = [];
    for (const tool of this.registry.values()) {
      if (await withSignal(signal, () => this.options.authorization.canDiscover?.({ context, tool: tool.policyInput })) === true &&
          await this.guardsAllow(tool, context, signal)) {
        result.push(structuredClone(tool.definition));
        if (result.length === 12) break;
      }
    }
    return result;
  }

  private async guardsAllow(tool: RegisteredAiTool, context: AiExecutionContext, signal: AbortSignal): Promise<boolean> {
    try {
      return await withSignal(signal, () => canActivateService(tool.guards, tool.service, tool.method, tool.owner, context, signal));
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }

  async execute(name: string, input: unknown, context: AiExecutionContext): Promise<JsonValue> {
    const tool = this.registry.get(name);
    if (!tool) throw new AiToolError('TOOL_UNAVAILABLE');
    if (!context.caller.subjectId.trim()) throw new AiToolError('DENIED');
    let args: JsonValue;
    try {
      args = snapshot(input, 16_384);
    } catch {
      throw new AiToolError('INVALID_ARGUMENTS');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args) || !tool.validate(args)) {
      throw new AiToolError('INVALID_ARGUMENTS');
    }
    const signal = AbortSignal.any([AbortSignal.timeout(this.options.execution.toolTimeoutMs), ...(context.abortSignal ? [context.abortSignal] : [])]);
    const invocation = { ...context, abortSignal: signal };
    try {
      if (!await this.guardsAllow(tool, invocation, signal)) throw new AiToolError('DENIED');
      let allowed: boolean;
      try {
        allowed = await withSignal(signal, () => this.options.authorization.canExecute({ context: invocation, tool: tool.policyInput, args }));
      } catch {
        throw new AiToolError('DENIED');
      }
      if (allowed !== true) throw new AiToolError('DENIED');
      await withSignal(signal, () => this.security.assertAllowed('tool_arguments', args, context.caller, signal));
      const instance = await withSignal(signal, () => tool.owner.resolve(tool.service, context.contextId, { strict: true }));
      signal.throwIfAborted();
      if (Reflect.get(instance as object, tool.key) !== tool.method) throw new AiToolError('TOOL_UNAVAILABLE');
      const value = await withSignal(signal, () => tool.method.call(instance, args));
      const result = snapshot(value, 65_536);
      await withSignal(signal, () => this.security.assertAllowed('tool_result', result, context.caller, signal));
      return result;
    } catch (error) {
      if (error instanceof AiSecurityError) throw error;
      if (signal.aborted) throw new AiToolError('TOOL_TIMEOUT');
      if (error instanceof AiToolError) throw error;
      throw new AiToolError('TOOL_FAILED');
    }
  }
}
