import type { AiModuleOptions } from "../contracts/ai-module-options.js";
import type {
  AiAttachmentModels,
  AiAttachmentStorageOptions,
} from "../contracts/ai-attachment.js";
import type {
  AiDatabaseAdapter,
  AiDatabaseOptions,
} from "../contracts/ai-database.js";
import {
  readAiBooleanEnv,
  readAiEnv,
  readAiIntegerEnv,
} from "./environment.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import type { AiRuntimeLimits } from "./runtime-limits.js";

export const AI_MODULE_OPTIONS = Symbol("AI_MODULE_OPTIONS");

const databaseMethods = [
  "beginConversation",
  "finishConversation",
  "listConversationTurns",
  "startRun",
  "attachRunSession",
  "appendRunEvent",
  "finishRun",
  "readRun",
] as const satisfies readonly (keyof AiDatabaseAdapter)[];

export type ValidatedAiModuleOptions = Readonly<AiModuleOptions> & {
  readonly attachmentDirectory?: string;
  readonly limits: AiRuntimeLimits;
  readonly execution: {
    readonly toolTimeoutMs: number;
    readonly allowWrites: boolean;
  };
  readonly promptSecurity: {
    readonly input: boolean;
    readonly output: boolean;
  };
};

function readPromptSecurity(): ValidatedAiModuleOptions["promptSecurity"] {
  const enabled = readAiBooleanEnv("PROMPT_SECURITY") ?? true;
  return Object.freeze({
    input: readAiBooleanEnv("PROMPT_SECURITY_INPUT") ?? enabled,
    output: readAiBooleanEnv("PROMPT_SECURITY_OUTPUT") ?? enabled,
  });
}

function validateDatabase(options: AiDatabaseOptions): AiDatabaseOptions {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    "filename" in options ||
    !options.adapter ||
    databaseMethods.some(
      (method) => typeof options.adapter?.[method] !== "function",
    )
  ) {
    throw new TypeError(
      "Configure storage with a host-initialized database.adapter implementing AiDatabaseAdapter.",
    );
  }
  return Object.freeze({ adapter: options.adapter });
}

function validateAttachmentModels(
  options: AiAttachmentModels,
): AiAttachmentModels {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(
      "AiModule attachmentModels must map MIME types to models.",
    );
  }
  for (const [mediaType, model] of Object.entries(options)) {
    if (
      !/^[a-z0-9][a-z0-9!#$&.^_+%-]*\/[a-z0-9][a-z0-9!#$&.^_+%-]*$/.test(
        mediaType,
      )
    ) {
      throw new TypeError(
        "AiModule attachment model keys must be full lowercase MIME types.",
      );
    }
    if (
      typeof model?.generate !== "function" ||
      typeof model.capabilities?.toolCalling !== "boolean"
    ) {
      throw new TypeError("Each attachment model must implement AiModel.");
    }
  }
  return Object.freeze({ ...options });
}

function validateAttachmentStorage(
  options: AiAttachmentStorageOptions,
): AiAttachmentStorageOptions {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "adapter") ||
    !options.adapter ||
    (["create", "read", "update", "delete"] as const).some(
      (method) => typeof options.adapter[method] !== "function",
    )
  ) {
    throw new TypeError(
      "Pass a custom attachmentStorage.adapter to AiModule. Configure local storage with NEST_AI_ATTACHMENT_STORAGE_ENABLED or NEST_AI_ATTACHMENT_STORAGE_DIRECTORY.",
    );
  }
  return Object.freeze({ adapter: options.adapter });
}

function readAttachmentDirectory(): string | undefined {
  const directory = readAiEnv("ATTACHMENT_STORAGE_DIRECTORY");
  const enabled =
    readAiBooleanEnv("ATTACHMENT_STORAGE_ENABLED") ?? directory !== undefined;
  if (!enabled) return;
  if (
    directory !== undefined &&
    (!directory.trim() || directory.includes("\0"))
  ) {
    throw new TypeError(
      "NEST_AI_ATTACHMENT_STORAGE_DIRECTORY must be a nonempty path.",
    );
  }
  return directory ?? "./assets/attachments";
}

export function validateOptions(
  options: AiModuleOptions,
): ValidatedAiModuleOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("AiModule options must be an object.");
  }

  const {
    model,
    answerEvaluator,
    attachmentModels,
    attachmentStorage,
    database,
    logger,
  } = options;
  if (
    typeof model?.generate !== "function" ||
    model.capabilities?.toolCalling !== true
  ) {
    throw new TypeError(
      "AiModule chat model must implement generate() and set capabilities.toolCalling to true.",
    );
  }
  if (
    model.capabilities.structuredOutput !== undefined &&
    typeof model.capabilities.structuredOutput !== "boolean"
  ) {
    throw new TypeError(
      "AiModule model capabilities.structuredOutput must be a boolean when supplied.",
    );
  }
  if (
    answerEvaluator !== undefined &&
    (typeof answerEvaluator?.generate !== "function" ||
      typeof answerEvaluator.capabilities?.toolCalling !== "boolean")
  ) {
    throw new TypeError("AiModule answerEvaluator must implement AiModel.");
  }
  if ("authorization" in options) {
    throw new TypeError(
      "Move AiModule authorization checks into Nest service guards and business services before removing the authorization option.",
    );
  }
  if (
    Object.hasOwn(options, "conversationStore") ||
    Object.hasOwn(options, "conversation")
  ) {
    throw new TypeError(
      "Use AiModule database.adapter to configure plugin storage.",
    );
  }
  if (logger !== undefined && typeof logger?.log !== "function") {
    throw new TypeError("AiModule logger must implement log().");
  }
  if ("selectConversationHistory" in options) {
    throw new TypeError(
      "Remove selectConversationHistory from AiModule options. Resumed conversations now use the full saved history.",
    );
  }
  if ("services" in options) {
    throw new TypeError(
      "Review which methods have @AiTool() before removing the AiModule services option. Tool discovery uses those decorators.",
    );
  }

  if ("promptSecurity" in options) {
    throw new TypeError(
      "Configure prompt security with NEST_AI_PROMPT_SECURITY, NEST_AI_PROMPT_SECURITY_INPUT and NEST_AI_PROMPT_SECURITY_OUTPUT.",
    );
  }
  if ("execution" in options) {
    throw new TypeError(
      "Configure tool execution with NEST_AI_TOOL_TIMEOUT_MS and NEST_AI_ALLOW_WRITES.",
    );
  }
  const attachmentDirectory =
    attachmentStorage === undefined ? readAttachmentDirectory() : undefined;

  return Object.freeze({
    model,
    ...(answerEvaluator === undefined ? {} : { answerEvaluator }),
    ...(attachmentModels === undefined
      ? {}
      : { attachmentModels: validateAttachmentModels(attachmentModels) }),
    ...(attachmentStorage === undefined
      ? {}
      : { attachmentStorage: validateAttachmentStorage(attachmentStorage) }),
    ...(attachmentDirectory === undefined ? {} : { attachmentDirectory }),
    promptSecurity: readPromptSecurity(),
    ...(database !== undefined ? { database: validateDatabase(database) } : {}),
    ...(logger ? { logger } : {}),
    limits: readRuntimeLimits(),
    execution: Object.freeze({
      toolTimeoutMs: readAiIntegerEnv("TOOL_TIMEOUT_MS", 10_000),
      allowWrites: readAiBooleanEnv("ALLOW_WRITES") ?? false,
    }),
  });
}
