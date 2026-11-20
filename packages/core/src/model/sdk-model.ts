import {
  APICallError,
  InvalidResponseDataError,
  JSONParseError,
} from "@ai-sdk/provider";
import type {
  LanguageModelV3,
  LanguageModelV4,
  LanguageModelV4ReasoningPart,
  LanguageModelV4TextPart,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type {
  AiMessage,
  AiModel,
  AiModelRequest,
  AiModelResponse,
  AiToolCall,
  AiToolDefinition,
} from "../contracts/ai-model.js";
import type { AiAttachment } from "../contracts/ai-attachment.js";
import { AiModelError } from "./ai-model-error.js";

export interface SdkModelOptions {
  readonly instructions?: string;
  readonly toolCalling?: boolean;
  readonly maxOutputTokens?: number;
  readonly providerOptions?: SharedV4ProviderOptions;
}

type AssistantPart =
  | LanguageModelV4TextPart
  | LanguageModelV4ReasoningPart
  | {
      type: "tool-call";
      toolCallId: string;
      providerOptions?: SharedV4ProviderOptions;
    };

function toolDescription(tool: AiToolDefinition): string {
  return [
    tool.description,
    ...(tool.useWhen ?? []).map((hint) => `Use when ${hint}.`),
    ...(tool.avoidWhen ?? []).map((hint) => `Avoid when ${hint}.`),
    ...(tool.examples ?? []).map(
      (example) =>
        `For "${example.user}", pass ${JSON.stringify(example.arguments)}.`,
    ),
  ].join(" ");
}

function assistantContent(message: Extract<AiMessage, { role: "assistant" }>) {
  const calls = new Map(
    (message.toolCalls ?? []).map((call) => [call.id, call]),
  );
  const parts =
    typeof message.continuation === "string"
      ? (JSON.parse(message.continuation) as AssistantPart[])
      : undefined;
  const content = parts ?? [
    ...(message.content
      ? [{ type: "text" as const, text: message.content }]
      : []),
    ...Array.from(calls.keys(), (toolCallId) => ({
      type: "tool-call" as const,
      toolCallId,
    })),
  ];
  return content.map((part) => {
    if (part.type !== "tool-call") return part;
    const call = calls.get(part.toolCallId);
    if (!call) throw new AiModelError("MODEL_PROTOCOL_ERROR");
    return {
      type: "tool-call" as const,
      toolCallId: call.id,
      toolName: call.name,
      input: call.arguments,
      ...("providerOptions" in part
        ? { providerOptions: part.providerOptions }
        : {}),
    };
  });
}

function toProviderMessage(message: AiMessage) {
  switch (message.role) {
    case "system":
      return { role: "system" as const, content: message.content };
    case "user":
      return {
        role: "user" as const,
        content: [{ type: "text" as const, text: message.content }],
      };
    case "assistant":
      return { role: "assistant" as const, content: assistantContent(message) };
    case "tool":
      return {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: message.callId,
            toolName: message.name,
            output: {
              type: "text" as const,
              value: JSON.stringify(message.result),
            },
          },
        ],
      };
  }
}

function appendFiles<Data>(
  prompt: ReturnType<typeof toProviderMessage>[],
  attachments: readonly AiAttachment[],
  encode: (data: Uint8Array) => Data,
) {
  if (!attachments.length) return prompt;
  const last = prompt.at(-1);
  if (last?.role !== "user") throw new AiModelError("MODEL_PROTOCOL_ERROR");
  const files = attachments.map(({ mediaType, data, filename }) => ({
    type: "file" as const,
    mediaType,
    data: encode(data),
    ...(filename !== undefined ? { filename } : {}),
  }));
  return [
    ...prompt.slice(0, -1),
    { role: "user" as const, content: [...last.content, ...files] },
  ];
}

export class SdkModel implements AiModel {
  readonly capabilities: { readonly toolCalling: boolean };

  constructor(
    private readonly model: LanguageModelV3 | LanguageModelV4,
    private readonly options: SdkModelOptions = {},
  ) {
    if (
      !model ||
      !["v3", "v4"].includes(model.specificationVersion) ||
      typeof model.doGenerate !== "function"
    ) {
      throw new TypeError(
        "SdkModel requires a V3 or V4 AI SDK language model.",
      );
    }
    this.capabilities = Object.freeze({
      toolCalling: options.toolCalling ?? true,
    });
  }

  async generate({
    messages,
    tools,
    attachments = [],
    abortSignal,
    responseSchema,
  }: AiModelRequest): Promise<AiModelResponse> {
    if (responseSchema || (!this.capabilities.toolCalling && tools.length)) {
      throw new AiModelError("UNSUPPORTED_MODEL_CAPABILITY");
    }

    const prompt = [
      ...(this.options.instructions
        ? [{ role: "system" as const, content: this.options.instructions }]
        : []),
      ...messages.map(toProviderMessage),
    ];
    let response: Awaited<
      ReturnType<(LanguageModelV3 | LanguageModelV4)["doGenerate"]>
    >;
    try {
      abortSignal?.throwIfAborted();
      const options = {
        maxOutputTokens: this.options.maxOutputTokens ?? 1024,
        ...(this.options.providerOptions
          ? { providerOptions: this.options.providerOptions }
          : {}),
        ...(abortSignal ? { abortSignal } : {}),
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                type: "function" as const,
                name: tool.name,
                description: toolDescription(tool),
                inputSchema: tool.inputSchema,
              })),
            }
          : {}),
      };
      response =
        this.model.specificationVersion === "v3"
          ? await this.model.doGenerate({
              ...options,
              prompt: appendFiles(prompt, attachments, (data) => data),
            })
          : await this.model.doGenerate({
              ...options,
              prompt: appendFiles(prompt, attachments, (data) => ({
                type: "data" as const,
                data,
              })),
            });
      abortSignal?.throwIfAborted();
    } catch (error) {
      if (abortSignal?.aborted) throw new AiModelError("MODEL_TIMEOUT");
      if (error instanceof AiModelError) throw error;
      if (APICallError.isInstance(error) && error.statusCode === 429)
        throw new AiModelError("MODEL_RATE_LIMITED");
      if (
        InvalidResponseDataError.isInstance(error) ||
        JSONParseError.isInstance(error)
      )
        throw new AiModelError("MODEL_PROTOCOL_ERROR");
      throw new AiModelError("MODEL_UNAVAILABLE");
    }

    if (
      ["length", "content-filter", "error", "interrupted"].includes(
        response.finishReason.unified,
      )
    ) {
      throw new AiModelError("MODEL_PROTOCOL_ERROR");
    }
    const usage = {
      ...(response.usage.inputTokens.total !== undefined
        ? { inputTokens: response.usage.inputTokens.total }
        : {}),
      ...(response.usage.outputTokens.total !== undefined
        ? { outputTokens: response.usage.outputTokens.total }
        : {}),
    };
    const text: string[] = [];
    const toolCalls: AiToolCall[] = [];
    const continuation: AssistantPart[] = [];
    for (const part of response.content) {
      const options = part.providerMetadata
        ? { providerOptions: part.providerMetadata }
        : {};
      switch (part.type) {
        case "text":
          text.push(part.text);
          continuation.push({ type: "text", text: part.text, ...options });
          break;
        case "reasoning":
          continuation.push({ type: "reasoning", text: part.text, ...options });
          break;
        case "tool-call":
          if (
            part.providerExecuted ||
            part.dynamic ||
            !this.capabilities.toolCalling
          ) {
            throw new AiModelError("MODEL_PROTOCOL_ERROR");
          }
          try {
            toolCalls.push({
              id: part.toolCallId,
              name: part.toolName,
              arguments: JSON.parse(part.input),
            });
          } catch {
            throw new AiModelError("MODEL_PROTOCOL_ERROR");
          }
          continuation.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            ...options,
          });
          break;
        case "tool-result":
        case "tool-approval-request":
          throw new AiModelError("MODEL_PROTOCOL_ERROR");
      }
    }
    const metadata = Object.keys(usage).length ? { usage } : {};
    const message = text.join("");
    if (toolCalls.length) {
      return {
        kind: "tool-calls",
        toolCalls,
        continuation: JSON.stringify(continuation),
        ...(message ? { message } : {}),
        ...metadata,
      };
    }
    if (!text.length || response.finishReason.unified === "tool-calls")
      throw new AiModelError("MODEL_PROTOCOL_ERROR");
    return { kind: "final", message, ...metadata };
  }
}
