---
name: nest-ai-middleware-integration
description: Integrate, migrate, or verify nestjs-ai-middleware in a NestJS app. Use for AiModule registration, SdkModel wiring, guarded AI endpoints, decorated tools, and storage adapters.
---

# Integrate Nest AI Middleware

The host owns its route, auth, provider configuration, and database lifecycle. The package owns model orchestration and tool dispatch. Check the installed package's exports and [core README](../../README.md) before wiring an integration.

## Register the module and model

Install `nestjs-ai-middleware` and the provider package the host uses. For local builds, run `npm run pack:packages` in the library workspace. Install the core tarball and the selected storage adapter tarball in the consuming app and refresh the lockfile. Verify the archive or its integrity when replacing a tarball at the same version.

Create the provider's Vercel AI SDK V3 or V4 language model using server-side configuration, then pass `new SdkModel(providerModel, { instructions })` as `model`. Tool calling is enabled by default. Set `toolCalling: false` for text-only models. For an existing custom provider or a scripted test, pass an implementation of `AiModel` directly.

Import one configured dynamic module alongside the host controller. For pre-initialized dependencies, use `AiModule.forRoot({ model, database: { adapter }, logger })`. If dependencies come from Nest, use `AiModule.forRootAsync({ imports, inject, useFactory })` with the modules that export the injected tokens. The factory returns the same options.

Choose the accepted MIME types and validate uploads in the host. Map full lowercase types to file-capable SDK models in `attachmentModels`, such as `{ 'image/png': imageModel, 'application/pdf': pdfModel }`. Pass `{ mediaType, data: Uint8Array }` entries with an optional filename in the message's `attachments` option. The core uses the extracted notes as chat context and applies the input check when enabled. See [file input examples](../../README.md#process-images-and-pdfs).

## Expose business tools

- Keep a single class-provider registration in the owning domain module. The middleware discovers `@AiTool()` methods from those providers. When upgrading, review decorated methods before removing the old `services` option.
- Decorate each callable method with `@AiTool()`. Give it a unique name, description, and an object `inputSchema` with named properties and required fields. Set `additionalProperties: false` or provide a schema for extra fields. The executor passes the validated input as one object. Destructure fields by name or collect them with `...rest`. Use an empty closed object schema for a method with no arguments. Keep business validation in the service. Set a stable `id` to identify the same tool in run records across renames.
- Use `readOnly: true` for reads. For an approved mutation workflow, `create` and `update` require an explicit operation, `readOnly: false`, and `execution.allowWrites: true`. The service or host workflow handles resource permissions, confirmation, and idempotency.
- Put shared authorization guards on the service class or method. The executor runs them before offering a tool to the model and again before dispatch in the original request scope. Check caller access to specific resources inside the service, using its validated arguments. When upgrading, move existing `authorization` checks into guards and business methods before removing that option.
- Use parameterized queries and return the caller's authorized JSON data.

## Connect the host endpoint

Register a Nest controller such as `POST /ai` in the host's module. Use the host's authentication and AI access guards, apply any app-specific message and upload limits, and obtain the subject and tenant from the verified principal. Pass the original request and response so service guards and request-scoped providers see the same context.

```ts
const caller = verifiedCaller(request);
if (!caller) throw new UnauthorizedException();

const contextId = ContextIdFactory.getByRequest(request);
moduleRef.registerRequestByContextId(request, contextId);

return aiChatService.sendMessage(
  body.message,
  {
    caller,
    contextId,
    http: { request, response },
    ...(abortSignal ? { abortSignal } : {}),
  },
  body.sessionId ? { sessionId: body.sessionId } : {},
);
```

`verifiedCaller` and body validation belong to the host. Inject `AiChatService` and `ModuleRef`. Derive the optional `abortSignal` from the HTTP connection and release event listeners when the run settles. Map typed failures to the host's response format. Rethrow `AiSecurityError` so Nest can return a generic HTTP 500. With storage configured, the middleware records the rejection code in the backend run record. The configured logger omits security rejection events. Prompt security defaults to `{ input: true, output: true }`. Set either switch to `false` independently or use `promptSecurity: false` to disable both.

## Add storage or observability as needed

- Pass an initialized `AiDatabaseAdapter` as `database.adapter`. The provided adapters use SQLite, PostgreSQL, or MongoDB. The host opens and closes storage. PostgreSQL and MongoDB need `initialize()` during setup. Use `AiChatService.listConversations()`, `readConversation()`, and `readRun()` with the verified caller. Page with `nextAfter` and pass the selected `sessionId` to `sendMessage()` on follow-ups.
- Resumed chats send all saved turns from the verified session to the model in order. Remove the old `selectConversationHistory` option when upgrading.
- Inject `AiChatService` into host backend services or controllers in a module that imports the configured `AiModule`. Use `readRun()` with a verified caller to retrieve recorded tool attempts. Use the optional `onToolResult` callback during `sendMessage()` when assembling the current response from a tool result. Input screening checks that result before the callback when enabled.
- Pass `logger: { log(event) { … } }` to collect accepted input, output, and tool outcomes.

## Verify with a packed consumer

Run an offline HTTP test with a scripted `AiModel` or scripted SDK provider. Verify route denial before model use, rejection of denied or invalid tool calls before dispatch, and an authorized tool result reaching the model in the original request scope. Verify that unsafe input and output yield a generic HTTP 500. If storage is configured, verify session reuse, caller isolation, and persistence of the private rejection code.

The sibling `test-app` is a reference consumer. `apps/api/src/app.ts` imports `AiModule.forRoot()` directly in `AppModule`. Read `apps/api/src/ai/ai-config.ts` for model and storage setup, `apps/api/src/ai/chat.controller.ts` for host auth and request context, `apps/api/src/catalog/catalog.service.ts` for decorators, and `apps/api/test/retail.test.mjs` for verification. Its API uses the packed core and SQLite packages from `vendor/`.
