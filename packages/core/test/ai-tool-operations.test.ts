import { expect, it } from '@jest/globals';
import { Injectable, Module } from '@nestjs/common';
import { ContextIdFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AiArgs, AiModule, AiPermissions, AiService, AiTool, AiToolExecutor } from '../src/index.js';
import type { AiAuthorizationPolicy, AiModel, AiToolOptions } from '../src/index.js';

const schema = { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false };

@Injectable()
@AiService()
@AiPermissions('records')
class RecordService {
  changes = 0;

  @AiTool({ name: 'get_record', description: 'Read an example record.', readOnly: true, inputSchema: schema })
  get(@AiArgs() args: { id: number }) { return args; }

  @AiTool({ name: 'create_record', description: 'Create an example record.', readOnly: false, operation: 'create', inputSchema: schema })
  create(@AiArgs() args: { id: number }) { this.changes++; return args; }

  @AiTool({ name: 'update_record', description: 'Update an example record.', readOnly: false, operation: 'update', inputSchema: schema })
  update(@AiArgs() args: { id: number }) { this.changes++; return args; }
}

@Injectable()
@AiService()
@AiPermissions('records')
class InvalidDeleteService {
  @AiTool({ name: 'remove_record', description: 'Delete an example record.', readOnly: false, operation: 'delete', inputSchema: schema } as unknown as AiToolOptions)
  delete(@AiArgs() args: { id: number }) { return args; }
}

@Module({ providers: [RecordService, InvalidDeleteService] })
class RecordsModule {}

const model: AiModel = {
  capabilities: { toolCalling: false },
  async generate() { return { kind: 'final', message: 'OK' }; },
};

const authorization: AiAuthorizationPolicy = {
  canDiscover: ({ context, tool }) => tool.operation === 'get' || context.caller.subjectId === 'editor',
  canExecute: ({ context, tool, args }) => args.id === 1 &&
    (tool.operation === 'get' || context.caller.subjectId === 'editor'),
};

function createFixture(allowWrites: boolean, service: typeof RecordService | typeof InvalidDeleteService = RecordService) {
  return Test.createTestingModule({ imports: [RecordsModule, AiModule.forRoot({
    model,
    authorization,
    services: [service],
    execution: { allowWrites },
  })] }).compile();
}

it('authorizes get, create, and update against the caller and resource on each dispatch', async () => {
  const fixture = await createFixture(true);
  try {
    await fixture.init();
    const executor = fixture.get(AiToolExecutor);
    const service = fixture.get(RecordService);
    const viewer = { caller: { subjectId: 'viewer' }, contextId: ContextIdFactory.create() };
    const editor = { caller: { subjectId: 'editor' }, contextId: ContextIdFactory.create() };

    expect((await executor.discover(viewer, AbortSignal.timeout(1000))).map(tool => tool.name)).toEqual(['get_record']);
    await expect(executor.execute('get_record', { id: 1 }, viewer)).resolves.toEqual({ id: 1 });
    await expect(executor.execute('get_record', { id: 2 }, viewer)).rejects.toMatchObject({ code: 'DENIED' });
    await expect(executor.execute('create_record', { id: 1 }, viewer)).rejects.toMatchObject({ code: 'DENIED' });
    await expect(executor.execute('update_record', { id: 2 }, editor)).rejects.toMatchObject({ code: 'DENIED' });
    expect(service.changes).toBe(0);
    await expect(executor.execute('create_record', { id: 1 }, editor)).resolves.toEqual({ id: 1 });
    await expect(executor.execute('update_record', { id: 1 }, editor)).resolves.toEqual({ id: 1 });
    expect(service.changes).toBe(2);
  } finally {
    await fixture.close();
  }
});

it('rejects writes without host opt-in and rejects delete even with opt-in', async () => {
  const readOnly = await createFixture(false);
  const withDelete = await createFixture(true, InvalidDeleteService);
  try {
    await expect(readOnly.init()).rejects.toThrow(/requires execution.allowWrites/);
    await expect(withDelete.init()).rejects.toThrow(/Unsupported AI tool operation/);
  } finally {
    await readOnly.close();
    await withDelete.close();
  }
});
