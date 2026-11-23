# NestJS AI Middleware

A reusable NestJS module for calling decorated tools on the host's existing Nest services. Inject `AiChatService` to send a message, list or read saved conversations, and read stored run records. The host supplies a verified caller and passes its Nest request context for tool execution.

## How a message runs

1. At startup, the host imports `AiModule.forRoot(...)`. The middleware discovers tool methods by their `@AiTool()` decorator on existing Nest class providers.
2. A host controller authenticates the request and calls `AiChatService.sendMessage()` with the message, verified caller, and original Nest request context. Pass a `sessionId` to resume a saved conversation.
3. For a resumed conversation, the middleware loads all saved turns in order. It gives the configured model the tool definitions whose service and method guards allow the caller. The model can answer directly or ask for a tool call with structured arguments.
4. The middleware validates the arguments and checks the guards again before invoking the existing Nest provider. It returns each tool result to the model, which can answer or request another tool. Tool calls run sequentially.
5. `sendMessage()` returns the answer and run ID. With a storage adapter configured, it also returns a session ID and saves the accepted exchange and run records. Backend services can retrieve those records through `AiChatService`.

## Development

The core package supports Node.js 24 and 26 with NestJS 11 and 12. It ships as ESM with TypeScript declarations. Use Node.js 26 and npm to develop the library from the workspace root.

```sh
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
npm run pack:packages
```

The package ships the ESM build, TypeScript declarations, README, and integration skill. The plugin database and test fixtures stay in the development checkout.

## Register the module

Apply any message and upload limits in the host before calling `AiChatService.sendMessage()`.

```ts
import { Module } from "@nestjs/common";
import { AiModule, type AiModel } from "nestjs-ai-middleware";

const model: AiModel = {
  capabilities: { toolCalling: true },
  async generate() {
    return { kind: "final", message: "Offline model reply" };
  },
};

@Module({
  imports: [
    AiModule.forRoot({
      model,
    }),
  ],
})
export class AppModule {}
```

Use `AiModule.forRootAsync({ imports, inject, useFactory })` when Nest providers supply the model or other dependencies. Host modules export the tokens listed in `inject`. Both registration methods validate their configuration during bootstrap. Attachment extraction shares the chat run deadline. See [environment settings](#environment-settings) for defaults and overrides.

### Environment settings

Set `NEST_AI_*` variables in the backend process before constructing `AiSdkModelAdapter` or a database adapter and before initializing `AiModule`. Pass the model, MIME-to-model mapping, database adapter, logger, and custom attachment adapter to `AiModule` as application dependencies. Use a Nest factory to construct those dependencies from application environment variables when needed.

Boolean variables accept `true` or `false`, and numbers use positive decimal integers. Omit a variable to use its default. Invalid overrides fail during initialization. Explicit `AiSdkModelAdapter` options and database adapter constructor arguments take precedence over their environment defaults.

When migrating, move `promptSecurity`, `execution`, and local `attachmentStorage` settings from `AiModule.forRoot()` or `forRootAsync()` to the environment.

| Environment variable                     |                             Default | Controls                                                                                |
| ---------------------------------------- | ----------------------------------: | --------------------------------------------------------------------------------------- |
| `NEST_AI_PROMPT_SECURITY`                |                              `true` | Default for both prompt security switches                                               |
| `NEST_AI_PROMPT_SECURITY_INPUT`          |  Inherits `NEST_AI_PROMPT_SECURITY` | Input screening                                                                         |
| `NEST_AI_PROMPT_SECURITY_OUTPUT`         |  Inherits `NEST_AI_PROMPT_SECURITY` | Output screening                                                                        |
| `NEST_AI_ALLOW_WRITES`                   |                             `false` | Allows registration of create and update tools                                          |
| `NEST_AI_ATTACHMENT_STORAGE_ENABLED`     |     Enabled when a directory is set | Enables the local attachment store                                                      |
| `NEST_AI_ATTACHMENT_STORAGE_DIRECTORY`   | `./assets/attachments` when enabled | Directory for local attachment files                                                    |
| `NEST_AI_SDK_TOOL_CALLING`               |                              `true` | Tool-calling capability for `AiSdkModelAdapter`                                         |
| `NEST_AI_SDK_INSTRUCTIONS`               |                               Unset | System instructions for `AiSdkModelAdapter`                                             |
| `NEST_AI_SDK_PROVIDER_OPTIONS`           |                               Unset | JSON object keyed by provider name, with an options object per provider                 |
| `NEST_AI_SQLITE_FILENAME`                |                               Unset | Filename when `SqliteDatabaseAdapter` is constructed without one                        |
| `NEST_AI_MONGODB_DATABASE_NAME`          |                               Unset | Database name when `MongoDatabaseAdapter` receives only a client                        |
| `NEST_AI_RUN_TIMEOUT_MS`                 |                               30000 | Deadline for each chat run, including extraction                                        |
| `NEST_AI_RUN_LEASE_MS`                   |                               35000 | Lifetime of a stored conversation lease                                                 |
| `NEST_AI_TOOL_TIMEOUT_MS`                |                               10000 | Deadline for each tool invocation                                                       |
| `NEST_AI_MAX_MODEL_ROUNDS`               |                                  10 | Chat model rounds per run                                                               |
| `NEST_AI_MAX_TOOL_CALLS`                 |                                  20 | Proposed tool calls per run                                                             |
| `NEST_AI_MAX_ANSWER_BYTES`               |                               32768 | UTF-8 byte limit for an answer or model tool-request message                            |
| `NEST_AI_MAX_JSON_DEPTH`                 |                                  24 | Maximum nesting depth for tool JSON and model continuation data, configurable up to 128 |
| `NEST_AI_MAX_ATTACHMENT_NOTES_BYTES`     |                                8192 | UTF-8 byte limit per attachment-model response                                          |
| `NEST_AI_ATTACHMENT_NOTES_TARGET_CHARS`  |                                2000 | Character target in the attachment extraction prompt                                    |
| `NEST_AI_SDK_MAX_OUTPUT_TOKENS`          |                                1024 | Default output token limit for `AiSdkModelAdapter`                                      |
| `NEST_AI_TRANSCRIPT_PAGE_SIZE`           |                                  50 | Stored turns per page                                                                   |
| `NEST_AI_CONVERSATION_PAGE_SIZE`         |                                  20 | Conversation summaries per page                                                         |
| `NEST_AI_CONVERSATION_PREVIEW_CHARS`     |                                 120 | Preview length in the bundled database adapters                                         |
| `NEST_AI_RUN_EVENT_PAGE_SIZE`            |                                  50 | Run events per page in the bundled database adapters                                    |
| `NEST_AI_STORE_READ_TIMEOUT_MS`          |                                5000 | Default deadline for public conversation and run reads                                  |
| `NEST_AI_SESSION_RELEASE_TIMEOUT_MS`     |                                 250 | Deadline for releasing an abandoned conversation lease                                  |
| `NEST_AI_BOOKKEEPING_TIMEOUT_MS`         |                                 100 | Budget for each run bookkeeping write                                                   |
| `NEST_AI_LOG_TIMEOUT_MS`                 |                                 100 | Budget for each logger call                                                             |
| `NEST_AI_SQLITE_MIGRATION_TIMEOUT_MS`    |                               30000 | SQLite lock wait during migration                                                       |
| `NEST_AI_SQLITE_BUSY_TIMEOUT_MS`         |                                 100 | SQLite lock wait during regular use                                                     |
| `NEST_AI_MONGODB_BOOKKEEPING_TIMEOUT_MS` |                                 100 | MongoDB driver deadline for bookkeeping writes                                          |
| `NEST_AI_MONGODB_SESSION_TIMEOUT_MS`     |                                5000 | MongoDB driver deadline for session writes and transactions                             |

The lease must exceed the run deadline. When `NEST_AI_RUN_LEASE_MS` is omitted, the lease is at least 35000 ms and at least 5000 ms longer than the configured run timeout.

When upgrading, transfer existing tool authorization checks to Nest service guards and business methods. Remove the old `services`, `authorization`, and `selectConversationHistory` options and the old class, permission, and argument decorators. Declare tool inputs in `@AiTool()`. Replace any `argumentOrder` configuration with a method that takes one input object.

### Use a Vercel AI SDK model

Install the provider package in the host app, configure it, and pass the language model it creates to `AiSdkModelAdapter`. The adapter accepts `LanguageModelV4`, the provider interface used by AI SDK 7, and `LanguageModelV3` from earlier provider releases. [AI SDK provider versioning](https://github.com/vercel/ai/blob/main/contributing/pre-release-cycle.md).

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { AiModule, AiSdkModelAdapter } from "nestjs-ai-middleware";

const openai = createOpenAI({ apiKey });

AiModule.forRoot({
  model: new AiSdkModelAdapter(openai.chat(modelId), {
    instructions: "Help users with the product catalog.",
    maxOutputTokens: 2048,
  }),
  database: { adapter },
});
```

Use the same constructor with a compatible model from `anthropic(modelId)` in `@ai-sdk/anthropic` or `ollama(modelId)` in `ollama-ai-provider-v2`. [OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai), [Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic), [Ollama providers](https://ai-sdk.dev/providers/community-providers/ollama).

The chat model must declare `capabilities.toolCalling: true`. The middleware discovers the caller's eligible tools on every chat run, and the model can still answer from context or give a fallback. Attachment models can use `toolCalling: false`. You can also provide a custom `AiModel` or pass SDK-specific settings through `providerOptions`.

### Process images and PDFs

Map each accepted full, lowercase MIME type to a file-capable SDK model in `attachmentModels`. Multiple types can share one model. The host decides which files it accepts, checks the file contents, and applies any upload limits.

```ts
const image = new AiSdkModelAdapter(visionModel, { toolCalling: false });
const pdf = new AiSdkModelAdapter(documentModel, { toolCalling: false });

AiModule.forRoot({
  model,
  attachmentModels: {
    "image/png": image,
    "image/jpeg": image,
    "application/pdf": pdf,
  },
});

await chat.sendMessage(
  "What numbers are shown in this file?",
  verifiedContext,
  {
    attachments: [
      { mediaType: "application/pdf", data: pdfBytes, filename: "report.pdf" },
    ],
  },
);
```

Pass validated bytes as a `Uint8Array` or Node `Buffer`, with an optional host-selected filename. Pass an empty message to request a summary when files are attached. Map `AiAttachmentError` to the host's response format.

Each configured attachment model receives the question and its assigned files with an empty tool list. The middleware checks the extracted text when input screening is enabled and includes the notes in the chat model's context. A configured conversation store saves those notes in the accepted turn. Inline attachments are processed for the current request. [AI SDK file inputs](https://ai-sdk.dev/docs/foundations/prompts#file-parts)

### Store and reuse attachments

Set `NEST_AI_ATTACHMENT_STORAGE_ENABLED=true` to use `./assets/attachments` relative to the backend working directory. Set `NEST_AI_ATTACHMENT_STORAGE_DIRECTORY=/path/to/private/assets` to enable storage at a different location. The first save creates the folder. Keep the folder outside directories served over HTTP.

```ts
AiModule.forRoot({
  model,
  attachmentModels: { "application/pdf": pdf },
});

// Inject AiAttachmentService into your authenticated upload handler.
const attachmentId = await storage.create(verifiedContext.caller, {
  mediaType: "application/pdf",
  data: pdfBytes,
  filename: "report.pdf",
});

await chat.sendMessage("What numbers are in the report?", verifiedContext, {
  attachmentIds: [attachmentId],
});
```

`AiModule` exports `AiAttachmentService` for injection into your controllers and services. Return the ID to the client so it can reuse the attachment in a later request. Every operation receives the verified caller. The exact `subjectId` and `tenantId` determine ownership. `read(caller, id)` retrieves the file, `update(caller, id, file)` replaces it under the same ID, and `delete(caller, id)` removes it. These operations throw `AiAttachmentError` with code `ATTACHMENT_NOT_FOUND` for a missing file or a different owner. Blob lifetime is managed by the host and is independent of conversations.

For object storage, pass `attachmentStorage: { adapter }` with your implementation of `AiAttachmentStorageAdapter`. The custom adapter takes precedence over local storage settings. Scope the adapter's operations by caller and ID. The adapter's `read` returns `undefined` for a missing record, and its `update` and `delete` return `false`. Storage works independently of `database.adapter`.

#### Expose attachment metadata as an AI tool

Register this provider in a host module that imports the configured `AiModule`. The tool takes an attachment ID and derives the caller from the authenticated request. Use `attachmentIds` when the model needs to interpret the file itself.

```ts
import {
  Inject,
  Injectable,
  Scope,
  UnauthorizedException,
} from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import { AiAttachmentService, AiTool } from "nestjs-ai-middleware";

@Injectable({ scope: Scope.REQUEST })
export class AttachmentTools {
  constructor(
    @Inject(REQUEST) private readonly request: object,
    private readonly storage: AiAttachmentService,
  ) {}

  @AiTool({
    name: "get_attachment",
    description:
      "Get the filename, media type, and size of an attachment by ID.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        attachmentId: { type: "string", minLength: 36, maxLength: 36 },
      },
      required: ["attachmentId"],
      additionalProperties: false,
    },
  })
  async getAttachment({ attachmentId }: { attachmentId: string }) {
    const caller = verifiedCaller(this.request);
    if (!caller) throw new UnauthorizedException();

    const { mediaType, filename, data } = await this.storage.read(
      caller,
      attachmentId,
    );
    return {
      mediaType,
      filename: filename ?? null,
      sizeBytes: data.byteLength,
    };
  }
}
```

### Connect an authenticated endpoint

Register an application controller in a module that imports the configured `AiModule` and inject `AiChatService`. Apply the app's authentication and AI access guards, validate the request DTO, and resolve the caller from the authenticated request. Forward the original Nest context so the middleware can resolve request-scoped tools and guards.

```ts
@Controller("ai")
@UseGuards(JwtAuthGuard, AiAccessGuard)
export class AiController {
  constructor(
    private readonly ai: AiChatService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Post()
  async run(
    @Body() body: ChatRequestDto,
    @Req() request: object,
    @Res({ passthrough: true }) response: object,
  ) {
    const caller = verifiedCaller(request);
    if (!caller) throw new UnauthorizedException();

    const contextId = ContextIdFactory.getByRequest(request);
    this.moduleRef.registerRequestByContextId(request, contextId);
    return this.ai.sendMessage(
      body.message,
      { caller, contextId, http: { request, response } },
      body.sessionId ? { sessionId: body.sessionId } : {},
    );
  }
}
```

The DTO, guards, and `verifiedCaller` are application code. The controller owns validation, response mapping, and HTTP cancellation. With persistence enabled, it can return the `sessionId` for subsequent messages.

### Use the middleware from a backend service

Inject `AiChatService` like any other Nest provider. Register your service in a module that imports the configured `AiModule`. If multiple feature modules need it, import and re-export `AiModule` from a shared host module so each consumer uses the same registration.

```ts
import { Injectable } from "@nestjs/common";
import { AiChatService, type AiCaller } from "nestjs-ai-middleware";

@Injectable()
export class SupportService {
  constructor(private readonly ai: AiChatService) {}

  readChatRun(runId: string, verifiedCaller: AiCaller) {
    return this.ai.readRun(runId, verifiedCaller);
  }
}
```

## Source structure

- `src/contracts/` contains the options, model protocol, execution context, run, conversation, and logger types. Import the public types through the package entry point.
- `src/ai.module.ts` and `src/config/` handle Nest registration, startup validation, and building the tool registry. `src/decorators/` defines how host services declare their tools.
- `src/orchestrator/ai-orchestrator.ts` coordinates a chat run and saves the final turn. The same directory contains the model and tool loop in `ai-answer.ts`, attachment processing in `ai-attachments.ts`, and per-run screening and model call tracking in `ai-run-context.ts`.
- `src/security/`, `src/executor/`, `src/conversation/`, and `src/logging/` handle screening, tool dispatch, conversation storage, and run records.
- `src/services/` contains the injectable `AiChatService` and `AiAttachmentService` APIs for the host backend.

## Retail integration test

The local `test-app` workspace exercises the packed package through a Nest HTTP route. Its domain services power both REST endpoints and read-only AI tools. The host controller owns authentication and request validation. See the [Nest integration skill](skills/nest-ai-middleware-integration/SKILL.md) for the worked integration.

## Access and prompt security

Authenticate the host endpoint and derive `AiExecutionContext.caller` from the verified request. Pass the original request under `http` and use its Nest context ID. The executor runs `@UseGuards()` declared on the registered service class and tool method in class-first order, using the owning Nest module and original request scope. Guarded tools require HTTP context. Controller route guards apply on their own HTTP routes. Put resource checks that rely on validated tool arguments in the business service. [NestJS guards](https://docs.nestjs.com/guards)

Input and output screening are enabled by default. Set `NEST_AI_PROMPT_SECURITY_INPUT` or `NEST_AI_PROMPT_SECURITY_OUTPUT` to `false` to disable a single check. Set `NEST_AI_PROMPT_SECURITY=false` to disable both by default. A per-direction switch takes precedence over the shared setting.

- `input` screens incoming messages, saved history, attachment notes, and tool results before they reach the chat model.
- `output` screens model-generated tool requests and the final answer, including any changes from `presentAnswer`, before the answer is saved or returned.

Tool schemas, Nest guards, and business authorization still apply. A rejected check aborts the run and throws `AiSecurityError`, which Nest returns as a generic HTTP 500. If the host catches the error, rethrow it to keep that response. With a database adapter configured, the middleware records `SECURITY_REJECTED` in the backend run record. The HTTP response is generic and the configured logger omits the rejection event.

### Tool operations

Set `inputSchema` in `@AiTool()` to an object JSON Schema. Use `properties` to name and type the inputs and `required` to mark mandatory fields. The executor validates the model's input and passes the resulting object to the method. The method can destructure fields by name and collect the rest with `...rest`. Set `additionalProperties: false` to reject undeclared fields or supply a schema to validate extra fields. For a method with no arguments, use an object schema with no properties and `additionalProperties: false`.

```ts
@AiTool({
  name: 'find_orders',
  description: 'Find recent orders for a customer.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      customerId: { type: 'string' },
      limit: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: ['open', 'closed'] },
    },
    required: ['customerId'],
    additionalProperties: false,
  },
})
findOrders({ customerId, limit = 10, ...filters }: {
  customerId: string;
  limit?: number;
  status?: 'open' | 'closed';
}) {
  return this.orders.findRecent(customerId, limit, filters);
}
```

The model can supply `{ customerId: 'customer-1' }` and the method uses its default `limit`. Application code can call `findOrders({ limit: 5, customerId: 'customer-1' })` directly. Schema properties can describe nested objects, arrays, and constraints for tool input. Keep business rules that apply to every caller in the service.

Read tools default to `operation: 'get'`. A host can opt in to `create` and `update` with `NEST_AI_ALLOW_WRITES=true` and register specific tools with `readOnly: false` and an explicit `operation`. Check resource ownership and the applicable permissions in the service. The registry rejects `delete`. Leave delete, cascade-delete, and arbitrary SQL methods undecorated. Apply any required confirmation or idempotency in the host's write flow. The example exposes reads only.

Give each tool a stable ID with `@AiTool({ id: 'catalog.product-trend', ... })`. The registry checks uniqueness and uses the tool name as the ID when omitted. The `onToolResult` option runs during the current `sendMessage()` call and gives the calling backend the tool result, stable `toolId`, and generated `invocationId`. Input screening checks that result before the callback when enabled. The retail example uses it to assemble charts in the HTTP response. Each run returns its own `runId` and the IDs of the tools it executed successfully.

### Conversations

Pass a host-initialized adapter as `database.adapter` in `forRoot()` or `forRootAsync()`. SQLite is the local default choice and uses Node’s built-in driver. The host opens and closes the database.

```ts
import { SqliteDatabaseAdapter } from "nestjs-ai-middleware-adapter-sqlite";

const adapter = new SqliteDatabaseAdapter("./data/nest-ai-middleware.sqlite");
AiModule.forRoot({
  model,
  database: { adapter },
  logger,
});
```

Call `AiChatService.sendMessage()` with the verified caller to start a session. Only the creator can list, read, or resume that session. Access requires the same `subjectId` and `tenantId` that were recorded at creation. Keep the returned `sessionId` and pass it on each follow-up. The plugin saves each successful exchange, including the text returned by a host-supplied `presentAnswer` callback. If a run is already active in the session, a second request receives `SESSION_BUSY`. `AiChatService.readConversation(sessionId, caller, after?)` returns up to 50 complete turns by default. Start at cursor zero and follow `nextAfter` until omitted. Both a missing session and a session owned by another caller return `SESSION_UNAVAILABLE`.

Use `AiChatService.listConversations(caller, after?)` to let a signed-in user choose a previous conversation. By default, it returns up to 20 summaries with the session ID, a preview of the first saved message, and the last saved turn's run time in Unix milliseconds. The bundled adapters limit the preview to 120 characters by default. A run time of zero indicates unavailable bookkeeping. Pass the returned `nextAfter` back unmodified for the next page. Pass the same verified caller to read or continue the selected session.

Resuming a conversation sends all saved turns from the verified session to the model in order. `readConversation()` returns the complete saved transcript in pages. Without persistence, pass `history` directly to `sendMessage()`.

SQLite, PostgreSQL, and MongoDB also support recall from other sessions for the same verified user and tenant. The model can call `nest_ai_search_history` with keywords when it needs information from an earlier conversation. It receives up to five question previews and can call `nest_ai_load_history` to use a selected question and answer in the current run. A search miss leaves the application tools available. Custom adapters can enable this by implementing `searchConversationTurns()`.

### Answer evaluation

Pass an `answerEvaluator` model alongside `model` in `AiModule.forRoot()` to review proposed replies. The evaluator receives the request, the run evidence, and the draft. It returns a JSON score and feedback. When the draft falls short, the chat model can make one text-only revision using the evidence it already has. The evaluator scores a revised draft before the middleware selects the reply and calls `presentAnswer`. Answer evaluation also works without database storage.

### Logging

Pass your initialized `AiLogger` in `logger`. The interface has one method, `log(event: AiLogEvent)`. Events carry the verified subject, tenant when present, run ID, and session ID once ownership is established. The `input` and `output` events include accepted text. The `reasoning` events report observable tool calls and non-security run failures, including stable tool and invocation IDs when available. Security rejections are recorded through the database adapter. The host controls where accepted text is sent and how the sink retains it. Sink errors and timeouts leave the interaction available.

## SQLite

The retail integration places the database in this plugin checkout at `data/nest-ai-middleware.sqlite`. SQLite stores session ownership in `ai_chat_sessions` and accepted exchanges in `ai_chat_turns`. The same file holds `ai_runs` for run status and `ai_run_events` for generation calls and tool attempts, including duration, provider-reported token usage, stable tool IDs, and invocation IDs. Bookkeeping stores metadata and stable error codes. Accepted transcript text lives in the conversation tables. [Node.js SQLite documentation](https://nodejs.org/api/sqlite.html)

### Adapter packages

The adapter packages are `nestjs-ai-middleware-adapter-sqlite`, `nestjs-ai-middleware-adapter-postgres`, and `nestjs-ai-middleware-adapter-mongodb`. The PostgreSQL adapter uses the host's `pg.Pool` and a dedicated schema. The MongoDB adapter uses the host's `MongoClient` and prefixed collections. Pending migrations run when the SQLite adapter opens its file and when the host awaits `initialize()` on PostgreSQL or MongoDB. An adapter that sees a newer schema version fails initialization.

The host can also supply its own implementation of `AiDatabaseAdapter`. The core manages the records and loads history the same way for every adapter. Implement the optional `listConversations` adapter method to enable the conversation picker. All three bundled adapters support listing existing conversations.

```ts
AiModule.forRootAsync({
  imports: [HostDatabaseModule],
  inject: [HOST_AI_DATABASE],
  useFactory: (adapter: AiDatabaseAdapter) => ({
    model,
    database: { adapter },
  }),
});
```

Implement the adapter with parameterized queries. Check the verified subject and tenant in owner-scoped reads and lease operations. Use a transaction for lease acquisition and turn finalization. Preserve the plugin-issued IDs, per-run event sequence, and Unix millisecond timestamps. Honor the supplied abort signals. Bookkeeping writes have a default 100 ms budget and report failures through the configured logger. Omitting `database` disables persistence.

### Read stored output and logs

Call `AiChatService.readRun(runId, verifiedCaller, after?)` after applying the host's authentication and authorization. The service scopes the result to the caller's subject and tenant through the associated session and returns the run status, accepted output, and committed model and tool events. Keep this result in the backend because it may include private rejection codes. The bundled adapters return up to 50 events per page by default. Start at cursor zero and follow `nextAfter` for further events. Missing and inaccessible runs both return `undefined`. The conversation and run read methods query the configured storage directly.
