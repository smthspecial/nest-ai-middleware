import { Inject, Injectable, Scope } from '@nestjs/common';
import type { OnApplicationBootstrap, Type } from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { AiToolPolicyInput } from '../contracts/ai-authorization-policy.js';
import type { AiToolDefinition, AiToolOptions } from '../contracts/ai-model.js';
import type { JsonObject } from '../contracts/json.types.js';
import { AI_ARGS, AI_PERMISSIONS, AI_SERVICE, AI_TOOL } from '../decorators/ai-decorators.js';
import { serviceGuards } from '../executor/service-guards.js';
import { AI_MODULE_OPTIONS } from './validate-options.js';
import type { ValidatedAiModuleOptions } from './validate-options.js';

export interface RegisteredAiTool {
  definition: AiToolDefinition & { readonly id: string };
  policyInput: AiToolPolicyInput;
  validate: ValidateFunction;
  service: Type<unknown>;
  owner: ModuleRef;
  key: string;
  method: (this: unknown, args: JsonObject) => unknown;
  guards: ReturnType<typeof serviceGuards>;
}

function classPermissions(service: Type<unknown>): string[] {
  const permissions: string[] = [];
  for (let current: object | null = service; current; current = Object.getPrototypeOf(current)) {
    permissions.push(...(Reflect.getOwnMetadata(AI_PERMISSIONS, current) ?? []));
  }
  return permissions;
}

@Injectable()
export class AiToolRegistry implements OnApplicationBootstrap {
  private tools: ReadonlyMap<string, RegisteredAiTool> = new Map();

  constructor(
    @Inject(AI_MODULE_OPTIONS) private readonly options: ValidatedAiModuleOptions,
    private readonly discovery: DiscoveryService,
  ) {}

  onApplicationBootstrap(): void {
    const ajv = new Ajv({ strict: true, ownProperties: true });
    const ids = new Set<string>();
    const tools = new Map<string, RegisteredAiTool>();
    for (const service of this.options.services) {
      if (Reflect.getOwnMetadata(AI_SERVICE, service) !== true) {
        throw new TypeError(`Missing @AiService() on ${service.name}.`);
      }
      const matches = this.discovery.getProviders().filter(provider => provider.token === service);
      const wrapper = matches[0];
      const owner = wrapper?.host;
      const ref = owner?.providers.get(ModuleRef)?.instance;
      if (matches.length !== 1 || wrapper?.metatype !== service || wrapper.scope === Scope.TRANSIENT ||
          owner?.controllers.has(service) || owner?.injectables.has(service) || !(ref instanceof ModuleRef)) {
        throw new TypeError(`Expected one Nest class provider for AI service ${service.name}.`);
      }
      const inherited = classPermissions(service);
      for (const key of Object.getOwnPropertyNames(service.prototype)) {
        if (key === 'constructor') continue;
        const method = Object.getOwnPropertyDescriptor(service.prototype, key)?.value;
        if (typeof method !== 'function') continue;
        const metadata = Reflect.getOwnMetadata(AI_TOOL, method) as AiToolOptions | undefined;
        if (!metadata) continue;
        const { readOnly, operation: declaredOperation, id: declaredId, ...definition } = structuredClone(metadata);
        const id = declaredId ?? definition.name;
        const operation = declaredOperation === undefined && readOnly === true ? 'get' : declaredOperation;
        const supported = (operation === 'get' && readOnly === true) ||
          ((operation === 'create' || operation === 'update') && readOnly === false);
        if (!supported || operation === undefined) {
          throw new TypeError(`Unsupported AI tool operation for ${service.name}.${key}. Only get, create and update are supported.`);
        }
        if (operation !== 'get' && !this.options.execution.allowWrites) {
          throw new TypeError(`AI tool ${service.name}.${key} requires execution.allowWrites.`);
        }
        const args: number[] = Reflect.getOwnMetadata(AI_ARGS, service.prototype, key) ?? [];
        const permissions: string[] = [...new Set<string>([...inherited, ...(Reflect.getOwnMetadata(AI_PERMISSIONS, method) ?? [])])];
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(definition.name) ||
            !definition.description?.trim() || !permissions.length || permissions.some(label => !label.trim()) ||
            args.length !== 1 || args[0] !== 0 || method.length !== 1 ||
            definition.inputSchema.type !== 'object' || definition.inputSchema.additionalProperties !== false ||
            tools.has(definition.name) || typeof id !== 'string' || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(id) || ids.has(id)) {
          throw new TypeError(`Invalid AI tool registration for ${service.name}.${key}.`);
        }
        ids.add(id);
        tools.set(definition.name, {
          definition: { ...definition, id },
          policyInput: Object.freeze({ id, name: definition.name, permissions: Object.freeze(permissions), readOnly, operation }),
          validate: ajv.compile(definition.inputSchema),
          service,
          owner: ref,
          key,
          method,
          guards: serviceGuards(service, method),
        });
      }
    }
    this.tools = tools;
  }

  get(name: string): RegisteredAiTool | undefined {
    return this.tools.get(name);
  }

  values(): Iterable<RegisteredAiTool> {
    return this.tools.values();
  }
}
