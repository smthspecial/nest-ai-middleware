import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, it, jest } from '@jest/globals';
import { Injectable, Module } from '@nestjs/common';
import { ContextIdFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AiArgs, AiModule, AiOrchestrator, AiPermissions, AiRunReader, AiService, AiTool, AiToolEvents } from 'nestjs-ai-middleware';
import type { AiLogEvent, AiModuleOptions, AiToolEvent, AiToolEventHandler } from 'nestjs-ai-middleware';
import { SqliteDatabaseAdapter } from '../src/index.js';

@Injectable()
@AiService()
@AiPermissions('reports:read')
class ReportService {
  @AiTool({
    id: 'reports.weekly', name: 'report', description: 'Read a report.', readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  })
  report(@AiArgs() _args: object) {
    return { total: 12 };
  }
}

@Module({ providers: [ReportService] })
class ReportModule {}

const caller = { subjectId: 'analyst', tenantId: 'store-a' };
const context = { caller, contextId: ContextIdFactory.create() };
const filter = { caller, toolIds: ['reports.weekly'] };

async function fixture(overrides: Partial<AiModuleOptions> = {}) {
  const sqlite = overrides.database ? undefined : new SqliteDatabaseAdapter(':memory:');
  const module = await Test.createTestingModule({
    providers: sqlite ? [{ provide: 'SQLITE_LIFECYCLE', useValue: { onModuleDestroy: () => sqlite.close() } }] : [],
    imports: [ReportModule, AiModule.forRoot({
      services: [ReportService],
      authorization: { canDiscover: () => true, canExecute: () => true },
      database: overrides.database ?? { adapter: sqlite! },
      model: {
        capabilities: { toolCalling: true },
        async generate({ messages }) {
          if (messages.at(-1)?.role === 'tool') return { kind: 'final', message: 'Report ready.' };
          const current = messages.at(-1);
          const invalid = current?.role === 'user' && current.content === 'Show an invalid report.';
          return { kind: 'tool-calls', toolCalls: [{ id: 'one', name: 'report', arguments: invalid ? { extra: true } : {} }] };
        },
      },
      ...overrides,
    })],
  }).compile();
  await module.init();
  return { module, ai: module.get(AiOrchestrator), reader: module.get(AiRunReader), events: module.get(AiToolEvents) };
}

it('publishes committed tool metadata to the owner and lets slow handlers finish independently', async () => {
  const { module, ai, reader, events } = await fixture();
  const received = Promise.withResolvers<AiToolEvent>();
  const release = Promise.withResolvers<void>();
  const unowned = jest.fn<AiToolEventHandler>();
  const unrelated = jest.fn<AiToolEventHandler>();
  try {
    events.subscribe(filter, () => release.promise);
    events.subscribe(filter, event => { received.resolve(event); });
    events.subscribe({ ...filter, caller: { ...caller, tenantId: 'store-b' } }, unowned);
    events.subscribe({ ...filter, caller: { ...caller, subjectId: 'another-user' } }, unowned);
    events.subscribe({ ...filter, toolIds: ['reports.other'] }, unrelated);
    const reply = await ai.run('Show the weekly report.', context);
    const event = await received.promise;
    expect(event).toEqual({
      type: 'ai.tool.completed.v1', eventId: expect.any(String), runId: reply.runId, sessionId: reply.sessionId,
      sequence: 2, toolId: 'reports.weekly', outcome: 'succeeded', occurredAt: expect.any(Number), durationMs: expect.any(Number),
    });
    await expect(reader.readRun(event.runId, caller, event.sequence - 1)).resolves.toMatchObject({
      events: [expect.objectContaining({ invocationId: event.eventId }), expect.objectContaining({ kind: 'model_call' })],
    });
    expect(unowned).not.toHaveBeenCalled();
    expect(unrelated).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await module.close();
  }
});

it('obeys host authorization and outcome filters and isolates subscriber exceptions', async () => {
  const log = jest.fn<(event: AiLogEvent) => void>();
  const observer = { subjectId: 'metrics', tenantId: 'store-a' };
  const { module, ai, events } = await fixture({
    logger: { log },
    authorization: {
      canDiscover: () => true, canExecute: () => true,
      async canObserveToolEvent({ subscriber, owner }) {
        return subscriber.subjectId === 'metrics' && subscriber.tenantId === owner.tenantId;
      },
    },
  });
  const received = Promise.withResolvers<AiToolEvent>();
  const defaultFilter = jest.fn<AiToolEventHandler>();
  const denied = jest.fn<AiToolEventHandler>();
  try {
    events.subscribe({ ...filter, caller: observer }, defaultFilter);
    const rejected = { ...filter, caller: observer, outcomes: ['rejected'] } as const;
    events.subscribe(rejected, () => { throw new Error('private handler error'); });
    events.subscribe(rejected, event => { received.resolve(event); });
    events.subscribe({ ...rejected, caller: { ...observer, tenantId: 'store-b' } }, denied);
    const reply = await ai.run('Show an invalid report.', context);
    const event = await received.promise;
    await nextTurn();
    expect(event).toMatchObject({ outcome: 'rejected', errorCode: 'INVALID_ARGUMENTS', runId: reply.runId });
    expect(defaultFilter).not.toHaveBeenCalled();
    expect(denied).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: 'tool_subscription_error', code: 'HANDLER_FAILED', eventId: event.eventId,
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private handler error');
  } finally {
    await module.close();
  }
});

it('skips notifications when a tool event cannot be committed', async () => {
  const adapter = new SqliteDatabaseAdapter(':memory:');
  const append = adapter.appendRunEvent.bind(adapter);
  jest.spyOn(adapter, 'appendRunEvent').mockImplementation((event, signal) => {
    if (event.kind === 'tool_attempt') throw new Error('SQL write failed');
    append(event, signal);
  });
  const { module, ai, events } = await fixture({ database: { adapter } });
  const listener = jest.fn<AiToolEventHandler>();
  try {
    events.subscribe(filter, listener);
    await expect(ai.run('Show the weekly report.', context)).resolves.toMatchObject({ toolIds: ['reports.weekly'] });
    await nextTurn();
    expect(listener).not.toHaveBeenCalled();
  } finally {
    await module.close();
    adapter.close();
  }
});

it('bounds each subscription queue and drops queued deliveries on unsubscribe and shutdown', async () => {
  const log = jest.fn<(event: AiLogEvent) => void>();
  const { ai, events, module } = await fixture({ logger: { log } });
  const done = Promise.withResolvers<void>();
  const pending = jest.fn<AiToolEventHandler>(() => done.promise);
  const released = jest.fn<AiToolEventHandler>(() => done.promise);
  const unsubscribe = events.subscribe(filter, pending);
  events.subscribe(filter, released);
  try {
    const opening = await ai.run('Show the weekly report.', context);
    if (!opening.sessionId) throw new Error('Expected a stored session.');
    await nextTurn();
    for (let index = 0; index < 140; index++) {
      await ai.run('Show the report again.', context, { sessionId: opening.sessionId });
    }
    unsubscribe();
  } finally {
    await module.close();
    done.resolve();
  }
  await nextTurn();
  expect(pending).toHaveBeenCalledTimes(1);
  expect(released).toHaveBeenCalledTimes(1);
  expect(log.mock.calls.filter(([value]) => 'code' in value && value.code === 'QUEUE_FULL')).toHaveLength(2);
});
