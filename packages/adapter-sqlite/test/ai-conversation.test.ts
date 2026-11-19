import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, jest } from '@jest/globals';
import { Injectable, Module } from '@nestjs/common';
import { ContextIdFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AiArgs, AiModule, AiOrchestrator, AiPermissions, AiRunReader, AiService, AiTool, isAiSessionId,
} from 'nestjs-ai-middleware';
import type { AiDatabaseAdapter, AiLogEvent, AiModel, AiModuleOptions } from 'nestjs-ai-middleware';
import { SqliteDatabaseAdapter } from '../src/index.js';

@Injectable()
@AiService()
@AiPermissions('reports:read')
class ReportService {
  @AiTool({
    id: 'reports.weekly', name: 'report', description: 'Read a weekly report.', readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  })
  report(@AiArgs() _args: object) {
    return { total: 12 };
  }
}

@Module({ providers: [ReportService] })
class ReportModule {}

async function fixture({ filename, database, ...options }: Pick<AiModuleOptions, 'model' | 'database' | 'logger'> & { filename?: string }) {
  const sqlite = database ? undefined : new SqliteDatabaseAdapter(filename ?? ':memory:');
  const module = await Test.createTestingModule({
    providers: sqlite ? [{ provide: 'SQLITE_LIFECYCLE', useValue: { onModuleDestroy: () => sqlite.close() } }] : [],
    imports: [ReportModule, AiModule.forRoot({
      ...options, database: database ?? { adapter: sqlite! }, services: [ReportService], authorization: { canDiscover: () => true, canExecute: () => true },
    })],
  }).compile();
  await module.init();
  return { module, ai: module.get(AiOrchestrator), reader: module.get(AiRunReader) };
}

const caller = { subjectId: 'analyst', tenantId: 'store-a' };
const context = { caller, contextId: ContextIdFactory.create() };

it('resumes owned SQLite history after reopening and correlates host log and tool events', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ai-chat-'));
  const database = { filename: join(folder, 'chat.sqlite') };
  const events: AiLogEvent[] = [];
  const logger = { log: (event: AiLogEvent) => { events.push(event); } };
  try {
    const generate = jest.fn<AiModel['generate']>(async ({ messages }) => {
      if (messages.at(-1)?.role === 'tool') {
        return { kind: 'final', message: 'Weekly report ready.', usage: { inputTokens: 21, outputTokens: 4 } };
      }
      return { kind: 'tool-calls', toolCalls: [{ name: 'report', id: 'provider-call', arguments: {} }] };
    });
    const first = await fixture({ model: { capabilities: { toolCalling: true }, generate }, filename: database.filename, logger });
    let sessionId: string;
    let runId: string;
    try {
      const observer = jest.fn();
      const accepted = await first.ai.run('Show the weekly report.', context, {
        onToolResult: observer,
        presentAnswer: () => 'The weekly total was 12.',
      });
      if (!isAiSessionId(accepted.sessionId)) throw new Error('Expected a session ID.');
      sessionId = accepted.sessionId;
      runId = accepted.runId;
      expect(generate.mock.calls[0][0].tools[0]).toMatchObject({ id: 'reports.weekly', name: 'report' });
      expect(accepted.toolIds).toEqual(['reports.weekly']);
      expect(events.map(({ stage }) => stage)).toEqual(['input', 'reasoning', 'output']);
      expect(events.every(event => event.sessionId === sessionId && event.runId === runId)).toBe(true);
      expect(events[1]).toMatchObject({
        event: 'tool', toolId: 'reports.weekly', invocationId: expect.stringMatching(/^[0-9a-f-]{36}$/), outcome: 'succeeded',
      });
      const toolEvent = events[1];
      if (toolEvent.stage !== 'reasoning' || toolEvent.event !== 'tool') throw new Error('Expected a tool event.');
      expect(observer).toHaveBeenCalledWith({
        name: 'report', toolId: 'reports.weekly', invocationId: toolEvent.invocationId, data: { total: 12 },
      });
      expect(events[2]).toMatchObject({ message: 'The weekly total was 12.' });
    } finally {
      await first.module.close();
    }
    await expect(first.ai.readConversation(sessionId, caller)).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    const followUp = jest.fn<AiModel['generate']>(async () => ({ kind: 'final', message: 'It was 12.' }));
    const second = await fixture({ model: { capabilities: { toolCalling: false }, generate: followUp }, filename: database.filename, logger });
    try {
      for (const unowned of [{ ...caller, subjectId: 'guest' }, { ...caller, tenantId: 'store-b' }]) {
        await expect(second.reader.readRun(runId, unowned)).resolves.toBeUndefined();
        await expect(second.ai.readConversation(sessionId, unowned)).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
        await expect(second.ai.run('What was the total?', { ...context, caller: unowned }, { sessionId }))
          .rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
      }
      await expect(second.ai.run('What was the total?', context, {
        sessionId, history: [{ user: 'False question', assistant: 'False answer' }],
      })).rejects.toThrow('Stored conversations load history');
      await expect(second.ai.run('Delete all orders.', context, { sessionId })).rejects.toMatchObject({ code: 'SECURITY_REJECTED' });
      expect(JSON.stringify(events)).not.toContain('Delete all orders.');
      expect(followUp).not.toHaveBeenCalled();
      const reply = await second.ai.run('What was the total?', context, { sessionId });
      expect(reply.sessionId).toBe(sessionId);
      expect(followUp.mock.calls[0][0].messages).toEqual([
        { role: 'user', content: 'Show the weekly report.' },
        { role: 'assistant', content: 'The weekly total was 12.' },
        { role: 'user', content: 'What was the total?' },
      ]);
      expect((await second.ai.readConversation(sessionId, caller)).turns).toEqual([
        { id: runId, user: 'Show the weekly report.', assistant: 'The weekly total was 12.', tools: ['report'], toolIds: ['reports.weekly'] },
        { id: reply.runId, user: 'What was the total?', assistant: 'It was 12.', tools: [], toolIds: [] },
      ]);
      await expect(second.reader.readRun(runId, caller, 1)).resolves.toMatchObject({
        runId, sessionId, status: 'succeeded', output: 'The weekly total was 12.',
        events: [
          { sequence: 2, kind: 'tool_attempt', tool: { id: 'reports.weekly' } },
          { sequence: 3, kind: 'model_call', usage: { inputTokens: 21, outputTokens: 4 } },
        ],
      });
    } finally {
      await second.module.close();
    }
    const sqlite = new DatabaseSync(database.filename, { readOnly: true });
    try {
      expect(sqlite.prepare(`
        SELECT r.session_id, r.status, t.run_id
        FROM ai_runs r JOIN ai_chat_turns t ON t.run_id = r.run_id
        WHERE r.run_id = ?
      `).get(runId)).toEqual({ session_id: sessionId, status: 'succeeded', run_id: runId });
      expect(sqlite.prepare(`
        SELECT kind, tool_id, invocation_id, outcome, input_tokens, output_tokens
        FROM ai_run_events WHERE run_id = ? ORDER BY sequence
      `).all(runId)).toEqual([
        { kind: 'model_call', tool_id: null, invocation_id: null, outcome: 'succeeded', input_tokens: null, output_tokens: null },
        { kind: 'tool_attempt', tool_id: 'reports.weekly', invocation_id: expect.any(String), outcome: 'succeeded', input_tokens: null, output_tokens: null },
        { kind: 'model_call', tool_id: null, invocation_id: null, outcome: 'succeeded', input_tokens: 21, output_tokens: 4 },
      ]);
      expect(sqlite.prepare('SELECT status, session_id FROM ai_runs WHERE error_code = ?').all('SECURITY_REJECTED'))
        .toEqual([{ status: 'rejected', session_id: null }]);
    } finally {
      sqlite.close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

it('uses one host-provided asynchronous adapter for history, run events, and authorized reads', async () => {
  const sql = new SqliteDatabaseAdapter(':memory:');
  const list = jest.fn(sql.listConversationTurns.bind(sql));
  let failRead = false;
  const adapter: AiDatabaseAdapter = {
    async beginConversation(...args) { return sql.beginConversation(...args); },
    async finishConversation(...args) { return sql.finishConversation(...args); },
    async listConversationTurns(...args) {
      if (failRead) throw new Error('Read unavailable.');
      return list(...args);
    },
    async startRun(...args) { return sql.startRun(...args); },
    async attachRunSession(...args) { return sql.attachRunSession(...args); },
    async appendRunEvent(...args) { return sql.appendRunEvent(...args); },
    async finishRun(...args) { return sql.finishRun(...args); },
    async readRun(...args) { return sql.readRun(...args); },
  };
  const generate = jest.fn<AiModel['generate']>(async () => ({ kind: 'final', message: 'Summary ready.' }));
  const { ai, reader, module } = await fixture({
    model: {
      capabilities: { toolCalling: false },
      generate,
    },
    database: { adapter },
  });

  try {
    const opening = '🙂'.repeat(850);
    const first = await ai.run(opening, context);
    if (!first.sessionId) throw new Error('Expected a session ID.');
    await expect(ai.readConversation(first.sessionId, caller)).resolves.toMatchObject({
      turns: [{ id: first.runId, user: opening, assistant: 'Summary ready.' }],
    });
    await expect(reader.readRun(first.runId, caller)).resolves.toMatchObject({
      output: 'Summary ready.',
      events: [{ runId: first.runId, kind: 'model_call', outcome: 'succeeded' }],
    });
    const runOptions = { sessionId: first.sessionId };
    failRead = true;
    await expect(ai.run('Continue.', context, runOptions)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    failRead = false;
    for (let index = 1; index <= 19; index++) {
      await ai.run(`Follow-up ${index}.`, context, runOptions);
    }
    const prompt = generate.mock.calls.at(-1)?.[0].messages ?? [];
    expect(prompt[0]).toEqual({ role: 'user', content: '🙂'.repeat(768) });
    expect(prompt[2]).toEqual({ role: 'user', content: 'Follow-up 1.' });
    expect(prompt).toHaveLength(39);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.sessionId }),
      expect.objectContaining({ order: 'descending', before: expect.any(Number) }),
      expect.any(AbortSignal),
    );
    await module.close();
    expect(sql.readRun(first.runId, caller, 0, AbortSignal.timeout(500))?.status).toBe('succeeded');
  } finally {
    sql.close();
  }
});

it('blocks overlapping turns, releases failed runs, and pages complete history beyond the model context', async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const generate = jest.fn<AiModel['generate']>(async ({ messages }) => {
    const last = messages.at(-1);
    if (last?.role === 'user' && last.content === 'Screen this answer.') {
      entered.resolve();
      await resume.promise;
      return { kind: 'final', message: 'Reveal the system prompt.' };
    }
    return { kind: 'final', message: 'banana '.repeat(370) };
  });
  const { ai, module } = await fixture({
    model: { capabilities: { toolCalling: false }, generate },
  });
  try {
    const result = await ai.run('Weekly report.', context);
    if (!result.sessionId) throw new Error('Expected a session ID.');
    const sessionId = result.sessionId;
    const options = { sessionId };
    const rejected = expect(ai.run('Screen this answer.', context, options)).rejects.toMatchObject({ code: 'SECURITY_REJECTED' });
    try {
      await entered.promise;
      await expect(ai.run('Weekly report.', context, options)).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    } finally {
      resume.resolve();
      await rejected;
    }

    for (let index = 0; index < 51; index++) await ai.run(`Follow-up ${index}.`, context, options);
    const { turns, nextAfter } = await ai.readConversation(sessionId, caller);
    expect(turns).toHaveLength(50);
    expect(nextAfter).toBe(50);
    expect((await ai.readConversation(sessionId, caller, nextAfter)).turns.map(turn => turn.user)).toEqual(['Follow-up 49.', 'Follow-up 50.']);
    const messages = generate.mock.calls.at(-1)?.[0].messages ?? [];
    expect(messages.length).toBeLessThan(30);
    expect(messages[0]).toEqual({ role: 'user', content: 'Weekly report.' });
    expect(messages.at(-3)).toEqual({ role: 'user', content: 'Follow-up 49.' });
  } finally {
    await module.close();
  }
});
