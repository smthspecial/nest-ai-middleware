import { Inject, Injectable, Scope } from "@nestjs/common";
import type { OnApplicationBootstrap, Type } from "@nestjs/common";
import { DiscoveryService, ModuleRef } from "@nestjs/core";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import type { AiToolDefinition, AiToolOptions } from "../contracts/ai-model.js";
import type { JsonObject } from "../contracts/json.types.js";
import { AI_TOOL } from "../decorators/ai-decorators.js";
import { serviceGuards } from "../executor/service-guards.js";
import { AI_MODULE_OPTIONS } from "./validate-options.js";
import type { ValidatedAiModuleOptions } from "./validate-options.js";

export interface RegisteredAiTool {
  definition: AiToolDefinition & { readonly id: string };
  validate: ValidateFunction;
  service: Type<unknown>;
  owner: ModuleRef;
  key: string;
  method: (this: unknown, input: JsonObject) => unknown;
  guards: ReturnType<typeof serviceGuards>;
}

function decoratedMethods(service: Type<unknown>) {
  return Object.getOwnPropertyNames(service.prototype ?? {}).flatMap((key) => {
    if (key === "constructor") return [];
    const method = Object.getOwnPropertyDescriptor(
      service.prototype,
      key,
    )?.value;
    if (typeof method !== "function") return [];
    const metadata = Reflect.getOwnMetadata(AI_TOOL, method) as
      AiToolOptions | undefined;
    return metadata ? [{ key, method, metadata }] : [];
  });
}

@Injectable()
export class AiToolRegistry implements OnApplicationBootstrap {
  private tools: ReadonlyMap<string, RegisteredAiTool> = new Map();

  constructor(
    @Inject(AI_MODULE_OPTIONS)
    private readonly options: ValidatedAiModuleOptions,
    private readonly discovery: DiscoveryService,
  ) {}

  onApplicationBootstrap(): void {
    const ajv = new Ajv({ strict: true, ownProperties: true });
    const ids = new Set<string>();
    const tools = new Map<string, RegisteredAiTool>();
    const providers = this.discovery.getProviders();
    const serviceClasses = new Set(
      providers.flatMap(({ token, metatype }) =>
        typeof token === "function" && token === metatype
          ? [token as Type<unknown>]
          : [],
      ),
    );
    for (const service of serviceClasses) {
      const methods = decoratedMethods(service);
      if (!methods.length) continue;
      const matches = providers.filter(
        (provider) => provider.token === service,
      );
      const wrapper = matches[0];
      const owner = wrapper?.host;
      const ref = owner?.providers.get(ModuleRef)?.instance;
      if (
        matches.length !== 1 ||
        wrapper?.metatype !== service ||
        wrapper.scope === Scope.TRANSIENT ||
        owner?.controllers.has(service) ||
        owner?.injectables.has(service) ||
        !(ref instanceof ModuleRef)
      ) {
        throw new TypeError(
          `Expected one Nest class provider for AI service ${service.name}.`,
        );
      }
      for (const { key, method, metadata } of methods) {
        if ("argumentOrder" in metadata || method.length > 1) {
          throw new TypeError(
            `AI tool ${service.name}.${key} receives one named input object. Use inputSchema properties for its arguments.`,
          );
        }
        const {
          readOnly,
          operation: declaredOperation,
          id: declaredId,
          ...definition
        } = structuredClone(metadata);
        const { inputSchema } = definition;
        const id = declaredId ?? definition.name;
        const operation =
          declaredOperation === undefined && readOnly === true
            ? "get"
            : declaredOperation;
        const supported =
          (operation === "get" && readOnly === true) ||
          ((operation === "create" || operation === "update") &&
            readOnly === false);
        if (!supported || operation === undefined) {
          throw new TypeError(
            `Unsupported AI tool operation for ${service.name}.${key}. Only get, create and update are supported.`,
          );
        }
        if (operation !== "get" && !this.options.execution.allowWrites) {
          throw new TypeError(
            `AI tool ${service.name}.${key} requires execution.allowWrites.`,
          );
        }
        if (
          !/^[a-z][a-z0-9_]{0,63}$/.test(definition.name) ||
          !definition.description?.trim() ||
          tools.has(definition.name) ||
          typeof id !== "string" ||
          !/^[a-z][a-z0-9_.:-]{0,127}$/.test(id) ||
          ids.has(id)
        ) {
          throw new TypeError(
            `Invalid AI tool registration for ${service.name}.${key}.`,
          );
        }
        const additional = inputSchema?.additionalProperties;
        if (
          inputSchema?.type !== "object" ||
          (additional !== false &&
            (!additional ||
              typeof additional !== "object" ||
              Array.isArray(additional)))
        ) {
          throw new TypeError(
            `AI tool ${service.name}.${key} requires an object inputSchema with additionalProperties set to false or a schema.`,
          );
        }
        ids.add(id);
        tools.set(definition.name, {
          definition: { ...definition, id },
          validate: ajv.compile(inputSchema),
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
