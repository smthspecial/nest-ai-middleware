import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AI_MODULE_OPTIONS } from '../config/validate-options.js';
import type { ValidatedAiModuleOptions } from '../config/validate-options.js';
import { AiConversationSessions } from '../conversation/ai-conversation-sessions.js';
import { AiConversationError } from '../conversation/ai-conversation-error.js';
import type { AiConversationSession, AiConversationTurn } from '../contracts/ai-conversation.js';
import type { AiCaller, AiExecutionContext } from '../contracts/ai-authorization-policy.js';
import { AiToolError, AiToolExecutor, snapshot } from '../executor/ai-tool-executor.js';
import { withSignal } from '../executor/with-signal.js';
import type { JsonValue } from '../contracts/json.types.js';
import type { AiLogDetail } from '../contracts/ai-logger.js';
import { AiRunBookkeeping } from '../logging/ai-run-bookkeeping.js';
import { writeRunLog } from '../logging/run-logging.js';
import { AiModelError } from '../model/ai-model-error.js';
import type { AiMessage, AiModelResponse, AiToolResult } from '../contracts/ai-model.js';
import { AiPromptSecurity, AiSecurityError } from '../security/prompt-security.js';
import type { AiPromptStage } from '../contracts/ai-prompt-security.js';
import { AI_REQUEST_LIMITS } from './ai-request-limits.js';
import type { AiRunOptions, AiRunResult } from '../contracts/ai-run.js';

function failureOutcome(code: string, cancelled: boolean) {
  if (code === 'SECURITY_REJECTED' || code === 'SESSION_UNAVAILABLE' || code === 'SESSION_BUSY' ||
      code === 'DENIED' || code === 'TOOL_UNAVAILABLE' || code === 'INVALID_ARGUMENTS') return 'rejected';
  if (cancelled) return 'cancelled';
  if (code === 'MODEL_TIMEOUT' || code === 'TOOL_TIMEOUT') return 'timed_out';
  return 'failed';
}

function conversationMessages(turns: readonly AiConversationTurn[]): { role: 'user' | 'assistant'; content: string }[] {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  let bytes = 2;
  for (const { user, assistant } of turns) {
    if (typeof user !== 'string' || typeof assistant !== 'string' ||
        Buffer.byteLength(user) > AI_REQUEST_LIMITS.historyMessageBytes ||
        Buffer.byteLength(assistant) > AI_REQUEST_LIMITS.historyMessageBytes) {
      throw new TypeError('Conversation messages must be text of up to 3 KiB each.');
    }
    bytes += Buffer.byteLength(JSON.stringify({ user, assistant })) + (messages.length ? 1 : 0);
    if (bytes > AI_REQUEST_LIMITS.historyBytes) throw new TypeError('Conversation context exceeds 24 KiB.');
    messages.push({ role: 'user', content: user }, { role: 'assistant', content: assistant });
  }
  return messages;
}

@Injectable()
export class AiOrchestrator {
  constructor(
    @Inject(AI_MODULE_OPTIONS) private readonly options: ValidatedAiModuleOptions,
    private readonly executor: AiToolExecutor,
    private readonly security: AiPromptSecurity,
    private readonly sessions: AiConversationSessions,
    private readonly bookkeeping: AiRunBookkeeping,
  ) {}

  readConversation(sessionId: string, caller: AiCaller, after = 0, signal?: AbortSignal) {
    return this.sessions.read(sessionId, caller, after, signal);
  }

  async run(message: string, context: AiExecutionContext, runOptions: AiRunOptions = {}): Promise<AiRunResult> {
    if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > AI_REQUEST_LIMITS.messageBytes) {
      throw new TypeError('Expected a non-empty message of up to 16 KiB.');
    }
    if (!context.caller.subjectId.trim()) throw new AiToolError('DENIED');
    if (this.sessions.enabled && runOptions.history?.length) throw new TypeError('Stored conversations load history from the configured store.');
    if (!this.sessions.enabled && runOptions.sessionId !== undefined) throw new AiConversationError('SESSION_UNAVAILABLE');
    const caller = { subjectId: context.caller.subjectId, ...(context.caller.tenantId !== undefined ? { tenantId: context.caller.tenantId } : {}) };
    const runId = randomUUID();
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(context.abortSignal ? [context.abortSignal] : [])]);
    const invocation = { ...context, abortSignal: signal };
    const calls = new Set<string>();
    const usedTools: string[] = [];
    const toolIds: string[] = [];
    let history = conversationMessages(runOptions.history ?? []);
    let session: AiConversationSession | undefined;
    let leased = false;
    const log = (detail: AiLogDetail) => writeRunLog(this.options.logger, runId, session?.id, caller, detail);
    const record = await this.bookkeeping.start(runId, caller, () => {
      void log({ stage: 'reasoning', event: 'bookkeeping_error', code: 'STORE_UNAVAILABLE' });
    });
    const inspect = (stage: AiPromptStage, content: JsonValue) =>
      withSignal(signal, () => this.security.assertAllowed(stage, content, context.caller, signal));
    try {
      await inspect('input', message);
      if (this.sessions.enabled) {
        const stored = await this.sessions.begin(caller, runOptions.sessionId, runId, signal);
        session = stored.session;
        leased = true;
        await record?.attachSession(session.id);
        history = conversationMessages(stored.history);
      }
      if (history.length) await inspect('history', history.map(entry => entry.content));
      await log({ stage: 'input', message });
      const messages: AiMessage[] = [...history, { role: 'user', content: message }];
      const model = this.options.model;
      const tools = model.capabilities.toolCalling ? await this.executor.discover(invocation, signal) : [];
      const exposed = new Map(tools.map(tool => [tool.name, tool.id]));
      for (let round = 0; round < 10; round++) {
        if (Buffer.byteLength(JSON.stringify({ tools, messages })) > 262_144) throw new AiModelError('MODEL_PROTOCOL_ERROR');
        let response: AiModelResponse;
        const modelStartedAt = performance.now();
        try {
          response = await withSignal(signal, () => model.generate({ messages: structuredClone(messages), tools: structuredClone(tools), abortSignal: signal }));
        } catch (error) {
          const failure = error instanceof AiModelError || error instanceof AiSecurityError ? error
            : new AiModelError(signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE');
          await record?.append({
            kind: 'model_call', outcome: failureOutcome(failure.code, context.abortSignal?.aborted === true),
            durationMs: performance.now() - modelStartedAt, errorCode: failure.code,
          });
          throw failure;
        }
        await record?.append({ kind: 'model_call', outcome: 'succeeded', durationMs: performance.now() - modelStartedAt, usage: response?.usage });
        if (response?.kind === 'final' && typeof response.message === 'string' && Buffer.byteLength(response.message) <= 32_768) {
          await inspect('output', response.message);
          const reply: AiRunResult = {
            message: response.message, tools: Object.freeze([...usedTools]), toolIds: Object.freeze([...toolIds]),
            runId, ...(session ? { sessionId: session.id } : {}),
          };
          const presented = runOptions.presentAnswer ? runOptions.presentAnswer(Object.freeze(reply)) : reply.message;
          if (typeof presented !== 'string' || Buffer.byteLength(presented) > 32_768) throw new AiModelError('MODEL_PROTOCOL_ERROR');
          if (presented !== reply.message) await inspect('output', presented);
          if (session) {
            await this.sessions.finish(session, runId, { id: runId, user: message, assistant: presented, tools: reply.tools, toolIds: reply.toolIds }, signal);
            leased = false;
          }
          await record?.finish('succeeded');
          await log({ stage: 'output', message: presented, toolIds: reply.toolIds });
          return { ...reply, message: presented };
        }
        if (response?.kind !== 'tool-calls' || !Array.isArray(response.toolCalls) ||
            !response.toolCalls.length || round === 9 || calls.size + response.toolCalls.length > 20) {
          throw new AiModelError('MODEL_PROTOCOL_ERROR');
        }
        const batch = response.toolCalls.map(call => {
          if (!call || typeof call.id !== 'string' || !call.id || call.id.length > 128 ||
              typeof call.name !== 'string' || call.name.length > 64 || calls.has(call.id)) {
            throw new AiModelError('MODEL_PROTOCOL_ERROR');
          }
          const args = snapshot(call.arguments, 16_384);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AiModelError('MODEL_PROTOCOL_ERROR');
          calls.add(call.id);
          return { id: call.id, name: call.name, arguments: args };
        });
        if (response.message !== undefined) {
          if (typeof response.message !== 'string' || Buffer.byteLength(response.message) > 32_768) {
            throw new AiModelError('MODEL_PROTOCOL_ERROR');
          }
          await inspect('model_output', response.message);
        }
        for (const call of batch) await inspect('model_output', call.arguments);
        messages.push({ role: 'assistant', toolCalls: batch });
        for (const call of batch) {
          signal.throwIfAborted();
          const toolId = exposed.get(call.name);
          const invocationId = randomUUID();
          const toolStartedAt = performance.now();
          let result: AiToolResult;
          let securityError: AiSecurityError | undefined;
          try {
            if (!toolId) throw new AiToolError('TOOL_UNAVAILABLE');
            const data = await this.executor.execute(call.name, call.arguments, invocation);
            usedTools.push(call.name);
            toolIds.push(toolId);
            result = { ok: true, data };
          } catch (error) {
            if (error instanceof AiSecurityError) securityError = error;
            result = { ok: false, code: error instanceof AiSecurityError || error instanceof AiToolError ? error.code : 'TOOL_FAILED' };
          }
          await record?.append({
            kind: 'tool_attempt', invocationId, ...(toolId ? { tool: { id: toolId, name: call.name } } : {}),
            durationMs: performance.now() - toolStartedAt,
            outcome: result.ok ? 'succeeded' : failureOutcome(result.code, context.abortSignal?.aborted === true),
            ...(!result.ok ? { errorCode: result.code } : {}),
          });
          await log({
            stage: 'reasoning', event: 'tool', ...(toolId ? { toolId } : {}), invocationId,
            outcome: result.ok ? 'succeeded' : 'rejected', ...(!result.ok ? { code: result.code } : {}),
          });
          if (securityError) throw securityError;
          if (result.ok && toolId) runOptions.onToolResult?.({ name: call.name, toolId, invocationId, data: result.data });
          messages.push({ role: 'tool', callId: call.id, name: call.name, result });
        }
      }
      throw new AiModelError('MODEL_PROTOCOL_ERROR');
    } catch (error) {
      const rejected = error instanceof AiSecurityError || error instanceof AiConversationError ? error
        : signal.aborted ? new AiModelError('MODEL_TIMEOUT')
        : error instanceof AiModelError ? error : new AiModelError('MODEL_PROTOCOL_ERROR');
      await record?.finish(failureOutcome(rejected.code, context.abortSignal?.aborted === true), rejected.code);
      await log({ stage: 'reasoning', event: 'run_rejected', code: rejected.code });
      throw rejected;
    } finally {
      if (session && leased) await this.sessions.release(session, runId);
    }
  }
}
