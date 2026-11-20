import type { FactoryProvider, ModuleMetadata } from "@nestjs/common";
import type { AiDatabaseOptions } from "./ai-database.js";
import type { AiModel } from "./ai-model.js";
import type { AiLogger } from "./ai-logger.js";
import type { AiAttachmentModels } from "./ai-attachment.js";

export interface AiModuleOptions {
  model: AiModel;
  attachmentModels?: AiAttachmentModels;
  /** Controls input and output checks independently. A boolean sets both checks. */
  promptSecurity?:
    boolean | { readonly input?: boolean; readonly output?: boolean };
  database?: AiDatabaseOptions;
  logger?: AiLogger;
  execution?: { toolTimeoutMs?: number; allowWrites?: boolean };
}

export interface AiModuleAsyncOptions {
  imports?: ModuleMetadata["imports"];
  inject?: FactoryProvider["inject"];
  useFactory: FactoryProvider<AiModuleOptions>["useFactory"];
}
