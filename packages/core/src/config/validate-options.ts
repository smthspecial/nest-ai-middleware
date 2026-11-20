import type { AiModuleOptions } from "../contracts/ai-module-options.js";
import type { AiAttachmentModels } from "../contracts/ai-attachment.js";
import type {
  AiDatabaseAdapter,
  AiDatabaseOptions,
} from "../contracts/ai-database.js";

export const AI_MODULE_OPTIONS = Symbol("AI_MODULE_OPTIONS");

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
// Node schedules a 1 ms timer when the delay exceeds the signed 32-bit range.
const NODE_MAX_TIMER_DELAY_MS = 2_147_483_647;
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

export type ValidatedAiModuleOptions = Readonly<
  Omit<AiModuleOptions, "execution" | "promptSecurity">
> & {
  readonly execution: {
    readonly toolTimeoutMs: number;
    readonly allowWrites: boolean;
  };
  readonly promptSecurity: {
    readonly input: boolean;
    readonly output: boolean;
  };
};

function validatePromptSecurity(
  options: AiModuleOptions["promptSecurity"] = true,
): ValidatedAiModuleOptions["promptSecurity"] {
  if (typeof options === "boolean") {
    return Object.freeze({ input: options, output: options });
  }

  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "input" && key !== "output")
  ) {
    throw new TypeError(
      "AiModule promptSecurity must be a boolean or an object with input and output switches.",
    );
  }

  const { input = true, output = true } = options;
  if (typeof input !== "boolean" || typeof output !== "boolean") {
    throw new TypeError(
      "AiModule promptSecurity.input and output must be booleans.",
    );
  }

  return Object.freeze({ input, output });
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

export function validateOptions(
  options: AiModuleOptions,
): ValidatedAiModuleOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("AiModule options must be an object.");
  }

  const {
    model,
    attachmentModels,
    execution,
    promptSecurity,
    database,
    logger,
  } = options;
  if (
    typeof model?.generate !== "function" ||
    typeof model.capabilities?.toolCalling !== "boolean"
  ) {
    throw new TypeError(
      "AiModule model must implement generate() and declare capabilities.toolCalling as a boolean.",
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

  if (
    execution !== undefined &&
    (execution === null ||
      typeof execution !== "object" ||
      Array.isArray(execution))
  ) {
    throw new TypeError("AiModule execution must be an object when supplied.");
  }
  const configuredTimeout = execution?.toolTimeoutMs;
  const toolTimeoutMs =
    configuredTimeout === undefined
      ? DEFAULT_TOOL_TIMEOUT_MS
      : configuredTimeout;
  const allowWrites =
    execution?.allowWrites === undefined ? false : execution.allowWrites;
  if (typeof allowWrites !== "boolean")
    throw new TypeError("AiModule execution.allowWrites must be a boolean.");
  if (
    !Number.isInteger(toolTimeoutMs) ||
    toolTimeoutMs < 1 ||
    toolTimeoutMs > NODE_MAX_TIMER_DELAY_MS
  ) {
    throw new TypeError(
      `AiModule execution.toolTimeoutMs must be an integer from 1 to ${NODE_MAX_TIMER_DELAY_MS}.`,
    );
  }

  return Object.freeze({
    model,
    ...(attachmentModels === undefined
      ? {}
      : { attachmentModels: validateAttachmentModels(attachmentModels) }),
    promptSecurity: validatePromptSecurity(promptSecurity),
    ...(database !== undefined ? { database: validateDatabase(database) } : {}),
    ...(logger ? { logger } : {}),
    execution: Object.freeze({ toolTimeoutMs, allowWrites }),
  });
}
