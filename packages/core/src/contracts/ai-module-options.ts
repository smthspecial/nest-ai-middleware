import type { FactoryProvider, ModuleMetadata } from "@nestjs/common";
import type { AiDatabaseOptions } from "./ai-database.js";
import type { AiModel } from "./ai-model.js";
import type { AiLogger } from "./ai-logger.js";
import type {
  AiAttachmentModels,
  AiAttachmentStorageOptions,
} from "./ai-attachment.js";

export interface AiModuleOptions {
  /** The chat model receives the tools available for the run. */
  model: AiModel;
  /** Reviews proposed answers and gives feedback for one revision when needed. */
  answerEvaluator?: AiModel;
  attachmentModels?: AiAttachmentModels;
  attachmentStorage?: AiAttachmentStorageOptions;
  database?: AiDatabaseOptions;
  logger?: AiLogger;
}

export interface AiModuleAsyncOptions {
  imports?: ModuleMetadata["imports"];
  inject?: FactoryProvider["inject"];
  useFactory: FactoryProvider<AiModuleOptions>["useFactory"];
}
