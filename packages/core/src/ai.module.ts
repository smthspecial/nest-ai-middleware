import "reflect-metadata";
import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { AiAttachmentService } from "./services/ai-attachment.service.js";
import { AiChatService } from "./services/ai-chat.service.js";
import { AiToolExecutor } from "./executor/ai-tool-executor.js";
import { AiOrchestrator } from "./orchestrator/ai-orchestrator.js";
import { AiPromptSecurity } from "./security/prompt-security.js";
import { AiConversationSessions } from "./conversation/ai-conversation-sessions.js";
import { AiDatabase } from "./database/ai-database.js";
import { AiRunBookkeeping } from "./logging/ai-run-bookkeeping.js";
import { AiRunReader } from "./logging/ai-run-reader.js";
import type { DynamicModule } from "@nestjs/common";
import type {
  AiModuleAsyncOptions,
  AiModuleOptions,
} from "./contracts/ai-module-options.js";
import { AiToolRegistry } from "./config/ai-tool-registry.js";
import {
  AI_MODULE_OPTIONS,
  validateOptions,
} from "./config/validate-options.js";

@Module({
  imports: [DiscoveryModule],
  providers: [
    AiAttachmentService,
    AiChatService,
    AiDatabase,
    AiToolRegistry,
    AiConversationSessions,
    AiRunBookkeeping,
    AiRunReader,
    AiPromptSecurity,
    AiToolExecutor,
    AiOrchestrator,
  ],
  exports: [
    AiAttachmentService,
    AiChatService,
    AiToolExecutor,
    AiOrchestrator,
    AiRunReader,
  ],
})
export class AiModule {
  static forRoot(options: AiModuleOptions): DynamicModule {
    return {
      module: AiModule,
      providers: [
        {
          provide: AI_MODULE_OPTIONS,
          useFactory: () => validateOptions(options),
        },
      ],
    };
  }

  static forRootAsync(options: AiModuleAsyncOptions): DynamicModule {
    const { imports, inject, useFactory } = options;
    return {
      module: AiModule,
      imports: imports ?? [],
      providers: [
        {
          provide: AI_MODULE_OPTIONS,
          inject: inject ?? [],
          useFactory: async (...dependencies) =>
            validateOptions(await useFactory(...dependencies)),
        },
      ],
    };
  }
}
