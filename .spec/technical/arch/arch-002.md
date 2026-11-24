---
id: ARCH-002
type: arch
title: "Public TypeScript API and model protocol"
status: draft
created: 2026-11-18
linkedIds: ARCH-003,FR-001,FR-002,FR-003,FR-004,FR-005,FR-006,FR-007
---

# Public TypeScript API and model protocol

The signatures and examples describe the current library API. The host owns its HTTP contract and calls the library from trusted application code.

The [data-flow diagrams](arch-003.md) show how the middleware handles calls to this API.

## NestJS integration

```ts
AiModule.forRoot({
  model: readyToUseModel,
});

AiModule.forRootAsync({
  imports: [ModelModule],
  inject: [AI_MODEL],
  useFactory: (model: AiModel) => ({
    model,
  }),
});
```

The host imports the module that owns `OrdersService` into its Nest application. `ModelModule` exports the token injected by the async factory. The factory may return options or a promise. The middleware discovers tool methods by their `@AiTool()` decorator.

```ts
export interface AiModuleOptions {
  model: AiModel;
  attachmentModels?: AiAttachmentModels;
  attachmentStorage?: AiAttachmentStorageOptions;
  database?: AiDatabaseOptions;
  logger?: AiLogger;
}

export interface AiCaller {
  readonly subjectId: string;
  readonly tenantId?: string;
}

export interface AiExecutionContext {
  readonly caller: AiCaller;
  readonly contextId: ContextId;
  readonly abortSignal?: AbortSignal;
  readonly http?: { readonly request: object; readonly response?: object };
}

export declare class AiToolExecutor {
  execute(
    name: string,
    args: unknown,
    context: AiExecutionContext,
  ): Promise<JsonValue>;
}
```

`execute` is a trusted server entry point. It uses stable tool error codes for unavailable tools, invalid arguments, denied authorization, timeouts, and failures. Rejected content raises `AiSecurityError`. The executor runs the service and method guards in the supplied Nest request scope. Business methods receive the validated argument snapshot and can check permissions for the specific resource.

## Tool declaration

```ts
@Injectable()
@UseGuards(OrdersAccessGuard)
export class OrdersService {
  @UseGuards(OrdersReadGuard)
  @AiTool({
    name: "find_orders",
    description: "Find recent orders for the current customer",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
      additionalProperties: false,
    },
  })
  async findOrders({ limit = 10 }: { limit?: number }) {
    return this.orders.findRecentForCurrentCustomer(limit);
  }
}
```

At bootstrap, the registry compiles the object input schema from `@AiTool()`. The schema describes named properties and either rejects undeclared fields or validates them against an additional property schema. Model-facing definitions contain the schema and selection hints. Names are unique and match `[a-z][a-z0-9_]{0,63}`.

A tool method declares its own `@AiTool()`. The executor runs class guards before method guards. In this example, both `OrdersAccessGuard` and `OrdersReadGuard` must approve access to `find_orders`.

Use strict validation without coercion or silent property removal. The executor passes one validated object and the method reads its inputs by property name. Services enforce business rules needed by direct callers.

## Model adapter

Core exports `AiSdkModelAdapter`. The host installs a provider package, configures its credentials, and uses the model ID to create a language model. The adapter accepts objects implementing `LanguageModelV3` or `LanguageModelV4` and exposes `AiModel.generate()`. Configure instructions, provider options, the output token budget, and tool-calling capability on the adapter. The orchestrator controls tool discovery and execution. Hosts can also implement `AiModel` directly. [SDK integration example](../../../packages/core/README.md#use-a-vercel-ai-sdk-model)

```ts
export type JsonValue =
  null | boolean | number | string | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface AiToolDefinition {
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly useWhen?: readonly string[];
  readonly avoidWhen?: readonly string[];
  readonly tags?: readonly string[];
  readonly examples?: readonly { user: string; arguments: JsonObject }[];
}

export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type AiToolResult =
  { ok: true; data: JsonValue } | { ok: false; code: string };

export type AiMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content?: string;
      toolCalls?: readonly AiToolCall[];
      continuation?: JsonValue;
    }
  | { role: "tool"; callId: string; name: string; result: AiToolResult };

export interface AiModelRequest {
  readonly messages: readonly AiMessage[];
  readonly tools: readonly AiToolDefinition[];
  readonly attachments?: readonly AiAttachment[];
  readonly abortSignal?: AbortSignal;
}

type AiUsage = { inputTokens?: number; outputTokens?: number };

export type AiModelResponse = (
  | { kind: "final"; message: string }
  | {
      kind: "tool-calls";
      message?: string;
      toolCalls: readonly AiToolCall[];
      continuation?: JsonValue;
    }
) & { usage?: AiUsage };

export interface AiModel {
  generate(request: AiModelRequest): Promise<AiModelResponse>;
}

export type AiModelErrorCode =
  | "MODEL_TIMEOUT"
  | "MODEL_RATE_LIMITED"
  | "MODEL_UNAVAILABLE"
  | "MODEL_PROTOCOL_ERROR";

export declare class AiModelError extends Error {
  constructor(code: AiModelErrorCode);
  readonly code: AiModelErrorCode;
}
```

The adapter maps its SDK's messages, usage, errors, and argument encoding to these types. If the SDK emits JSON strings for arguments, the adapter parses them once. Core validates the complete batch and requires each call to have JSON object arguments and a unique ID within the run. Schema violations for otherwise well-formed calls become tool result errors. The orchestrator invokes tools sequentially and associates each call with its result in the model messages. The adapter passes abort signals to the SDK where supported. It can throw `AiModelError` for known failure categories. Core maps other adapter exceptions to `MODEL_UNAVAILABLE` and discards raw exception details from client responses. Provider credentials and SDK types stay inside the adapter boundary.

Each chat run discovers the tools eligible for the caller and includes them in generation requests. The model can request tool calls or return a final text answer. Attachment extraction and answer evaluation use empty tool lists. The optional `continuation` carries JSON data back to the adapter during a run. SDK adapters can use it for provider metadata required after a tool call. The orchestrator keeps it out of persisted conversations, logs, and responses. The host can render application-specific data from tool callbacks. Streaming is planned separately.

The host selects accepted file types, validates upload contents, and maps each supported MIME type to a model through `attachmentModels`. The host applies any message and upload limits. Resumed chats replay all turns from the verified session. The orchestrator sends files to the corresponding attachment models with an empty tool list. When input screening is enabled, the orchestrator checks extracted text before using it as chat context. With persistence enabled, the notes become part of the saved user turn. [File inputs](../../../packages/core/README.md#process-images-and-pdfs)

## HTTP and response envelope

The host registers its own Nest controller and chooses the path, guards, request DTO, and response format. The reference route accepts a validated `{ "message": "Show my last five orders", "sessionId": "optional-id" }`. After verifying the caller, the controller passes the message, caller, original request context, and optional session ID to `AiChatService.sendMessage()`. The service exposes `listConversations()`, `readConversation()`, and `readRun()` for owner-scoped storage reads. [Host controller example](../../../packages/core/README.md#connect-an-authenticated-endpoint)

Service and method guards run before a tool definition goes to the model and before each invocation. [Authentication and guard details](../auth/auth-001.md)

The run returns `message`, `runId`, `tools`, and `toolIds`, plus `sessionId` when storage is enabled. The host maps typed failures to its HTTP error contract and propagates client cancellation through the run's abort signal. The host may format application-specific blocks such as charts through `onToolResult`, or replace the answer text through `presentAnswer`. The returned and stored assistant text uses the same value.

Prompt screening defaults to `{ input: true, output: true }`. The host can toggle each check independently through `NEST_AI_PROMPT_SECURITY_INPUT` and `NEST_AI_PROMPT_SECURITY_OUTPUT`. Input checks cover incoming messages, history, attachment notes, and tool results. Output checks cover model-generated tool requests and final answer text. A rejected check aborts the run with a generic HTTP 500 in Nest. Storage can record `SECURITY_REJECTED` for backend inspection, and middleware logs omit the rejection event. [Core integration guide](../../../packages/core/README.md#access-and-prompt-security)

## Bookkeeping and persistence

Pass a host-initialized `database.adapter` to enable session storage and run bookkeeping together. The bundled adapters support SQLite, PostgreSQL, and MongoDB. Resuming a session loads all saved turns for the verified subject and tenant. The host can send its own `history` when running without storage. [Configuration and store contracts](../services/srv-001.md).
