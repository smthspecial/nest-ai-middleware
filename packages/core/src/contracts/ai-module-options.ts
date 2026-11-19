import type { FactoryProvider, ModuleMetadata, Type } from '@nestjs/common';
import type { AiAuthorizationPolicy } from './ai-authorization-policy.js';
import type { AiDatabaseOptions } from './ai-database.js';
import type { AiModel } from './ai-model.js';
import type { AiPromptSecurityOptions } from './ai-prompt-security.js';
import type { AiLogger } from './ai-logger.js';

export interface AiModuleOptions {
  model: AiModel;
  services: readonly Type<unknown>[];
  authorization: AiAuthorizationPolicy;
  promptSecurity?: AiPromptSecurityOptions;
  database?: AiDatabaseOptions;
  logger?: AiLogger;
  execution?: { toolTimeoutMs?: number; allowWrites?: boolean };
}

export interface AiModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: FactoryProvider['inject'];
  useFactory: FactoryProvider<AiModuleOptions>['useFactory'];
}
