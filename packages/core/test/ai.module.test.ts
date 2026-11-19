import { describe, expect, it } from '@jest/globals';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AI_MODULE_OPTIONS } from '../src/config/validate-options.js';
import type { ValidatedAiModuleOptions } from '../src/config/validate-options.js';
import { AiModule, AiService } from '../src/index.js';
import type { AiAuthorizationPolicy, AiModel, AiModuleOptions } from '../src/index.js';

@AiService()
class OrdersService {}

@Module({ providers: [OrdersService] })
class OrdersModule {}

const model: AiModel = {
  capabilities: { toolCalling: false },
  async generate() {
    return { kind: 'final', message: 'Offline reply' };
  },
};
const authorization: AiAuthorizationPolicy = { canExecute: () => false };
const options: AiModuleOptions = { model, authorization, services: [OrdersService] };

const HOST_MODEL = Symbol('HOST_MODEL');
const HOST_POLICY = Symbol('HOST_POLICY');

@Module({
  providers: [
    { provide: HOST_MODEL, useValue: model },
    { provide: HOST_POLICY, useValue: authorization },
  ],
  exports: [HOST_MODEL, HOST_POLICY],
})
class HostDependenciesModule {}

describe('AiModule', () => {
  it('registers an initialized model and policy with the default timeout', async () => {
    const registeredModule = AiModule.forRoot(options);
    const fixture = await Test.createTestingModule({ imports: [OrdersModule, registeredModule] }).compile();
    try {
      await fixture.init();
      const config = fixture.select(registeredModule).get<ValidatedAiModuleOptions>(AI_MODULE_OPTIONS, { strict: true });

      expect(config.model).toBe(model);
      expect(config.authorization).toBe(authorization);
      expect(config.promptSecurity).toEqual({ enabled: true, builtInChecks: true, rejection: 'close', rules: [] });
      expect(config.services).toEqual([OrdersService]);
      expect(config.services).not.toBe(options.services);
      expect(config.execution.toolTimeoutMs).toBe(10_000);
    } finally {
      await fixture.close();
    }
  });

  it('awaits a factory with dependencies exported by a host module', async () => {
    const registeredModule = AiModule.forRootAsync({
      imports: [HostDependenciesModule],
      inject: [HOST_MODEL, HOST_POLICY],
      async useFactory(hostModel: AiModel, hostPolicy: AiAuthorizationPolicy) {
        return { model: hostModel, authorization: hostPolicy, services: [], execution: { toolTimeoutMs: 250 } };
      },
    });
    const fixture = await Test.createTestingModule({ imports: [registeredModule] }).compile();
    try {
      await fixture.init();
      const config = fixture.select(registeredModule).get<ValidatedAiModuleOptions>(AI_MODULE_OPTIONS, { strict: true });

      expect(config.model).toBe(model);
      expect(config.authorization).toBe(authorization);
      expect(config.execution.toolTimeoutMs).toBe(250);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    [{ model: { capabilities: { toolCalling: true } } }, /generate\(\)/],
    [{ model: { ...model, capabilities: {} } }, /capabilities\.toolCalling/],
    [{ model: { ...model, capabilities: { toolCalling: false, structuredOutput: 'yes' } } }, /structuredOutput/],
    [{ authorization: {} }, /canExecute\(\)/],
    [{ promptSecurity: { enabled: 'false' } }, /must be booleans/],
    [{ promptSecurity: { builtInChecks: false } }, /requires rules, allow, or classifier/],
    [{ promptSecurity: { rules: [{ contains: '\u200b' }] } }, /must be a non-empty string/],
    [{ promptSecurity: { rules: [{ contains: 'marker', stages: ['unknown'] }] } }, /valid prompt stages/],
    [{ promptSecurity: { classifier: { model: {}, timeoutMs: 20 } } }, /requires a model with generate/],
    [{ promptSecurity: { rejection: 'unknown' } }, /rejection must be close or respond/],
    [{ services: OrdersService }, /services must be an array/],
    [{ services: [() => ({})] }, /services\[0\] must be a Nest provider class/],
    [{ services: [OrdersService, OrdersService] }, /services\[1\] repeats a provider class/],
    [{ execution: null }, /execution must be an object/],
    [{ database: { filename: ':memory:' } }, /database\.adapter/],
    [{ database: { adapter: {} } }, /implementing AiDatabaseAdapter/],
    [{ database: { filename: ':memory:', adapter: {} } }, /database\.adapter/],
    [{ conversation: { filename: ':memory:' } }, /database\.adapter/],
    [{ execution: { toolTimeoutMs: 0 } }, /execution\.toolTimeoutMs/],
    [{ execution: { toolTimeoutMs: 2_147_483_648 } }, /execution\.toolTimeoutMs/],
  ])('rejects invalid configuration %o during bootstrap', async (overrides, error) => {
    const invalidOptions = { ...options, ...overrides } as AiModuleOptions;
    await expect(Test.createTestingModule({ imports: [AiModule.forRoot(invalidOptions)] }).compile())
      .rejects.toThrow(error);
  });

  it('validates the resolved async configuration during bootstrap', async () => {
    const registeredModule = AiModule.forRootAsync({
      useFactory: () => ({ ...options, execution: { toolTimeoutMs: 1.5 } }),
    });

    await expect(Test.createTestingModule({ imports: [registeredModule] }).compile())
      .rejects.toThrow(/execution\.toolTimeoutMs/);
  });
});
