---
name: nest-ai-middleware-integration
description: Integrate, update, or verify the nestjs-ai-middleware package in a NestJS host. Use for model wiring, domain service decorators, tool authorization, and testing the installed package against the sibling test-app example.
---

# Integrate Nest AI Middleware

## Find the example

Use the sibling `test-app` checkout if present. Read `apps/api/src/ai/assistant.module.ts` for registration, `apps/api/src/catalog/catalog.service.ts` for the named-product tool, `apps/api/src/ai/chat.controller.ts` for request context, and `apps/api/test/retail.test.mjs` for a packed consumer test. Use [the plugin README](../../README.md) and the package exports when the sibling checkout is unavailable.

## Wire the host

1. Build and install the npm package. For local integration, run `npm run pack:packages` from the workspace root and copy the core and selected adapter archives to the consumer. In `test-app`, set the API workspace dependencies to their `file:../../vendor/<archive>.tgz` paths using the actual archive names and run `npm install` to refresh the lockfile. Verify the installed version before testing.
2. Keep the model adapter, middleware configuration, and chat controller in the host's assistant module. Supply a ready `AiModel` with declared capabilities. The example maps local Ollama chat and tool calls to `AiModel`. Use the host's configured provider and model in other apps.
3. Keep business logic and database access in the owning domain modules. Export each eligible Nest provider from its module. Add `@AiService()` and register its class in the `services` allowlist. Use `@AiTool({ readOnly: true, ... })` for reads, a closed input schema, `@AiArgs()` on the single object parameter, and effective `@AiPermissions()` on the class or method. The host can explicitly enable `create` and `update` with `execution.allowWrites`. Declare the operation and enforce its resource permissions and any confirmation in the host. The registry rejects delete operations. Put usage guidance and realistic examples in the tool decorator.
4. Import the domain modules in `AiModule.forRootAsync({ imports, useFactory })`. The factory returns the host model, service classes, and an authorization policy. Select visible tools with `canDiscover` and check the verified caller and validated arguments in `canExecute`. Let each domain module own its Nest provider instance.
5. Authenticate in the host controller, then pass the verified caller, original HTTP request, and current Nest `ContextId` to `AiOrchestrator.run()`. Register the request for request-scoped dependencies. Put guards that should apply to a tool on the registered service or method with `@UseGuards()`. The executor runs these guards alongside the tool policy. Use `AI_REQUEST_LIMITS` for validation. For charts, project successful values received by `onToolResult` into bounded host-owned response data.
6. To persist chat and bookkeeping, construct the SQLite, PostgreSQL, or MongoDB adapter with host-managed database setup and pass `database: { adapter }`. SQLite is the default choice in the retail example. The plugin uses a single adapter for chat and bookkeeping. Return the server-generated `sessionId` and accept it on follow-ups. Restore transcripts through `readConversation(sessionId, caller, after)`. Use `AiRunReader.readRun(runId, caller, after)` for accepted output, run status, and logs. Pass the caller established by the host's authentication and authorization.
7. Assign stable IDs in the tool decorators. To collect screened input, observable tool outcomes, and output, pass a ready `AiLogger` with `log(event)`. Correlate entries by `sessionId`, `runId`, and the distinct per-call `invocationId`. Apply the host's handling policy to the accepted message and answer text.
8. To react to committed tool attempts, inject `AiToolEvents` and subscribe with a verified principal and explicit tool IDs. The default delivers successful attempts for the same subject and tenant. Use the host's `authorization.canObserveToolEvent` policy to grant a service account access. Keep the unsubscribe function and call it when the consumer shuts down. Use the event ID for idempotent reactions.

## Bound the work

Expose specific domain queries. Use finite argument ranges and result limits, parameterized database access, and indexes or prepared aggregates for expensive reads. In the example, `product_trend` accepts one product and reads seven weekday buckets from a prepared aggregate. Derive provenance and time-period labels from actual data. The archive records weekday codes, so the order-volume check reports its bounded archive-wide comparison when the user asks about a calendar week.

Configure prompt screening through `promptSecurity`. The default uses built-in signatures. Add stage-scoped literal deny phrases with `rules`, a custom policy with `allow`, or a separate tool-free model check with `classifier`. Set `builtInChecks: false` to use host screening alone. Credential and destructive database checks apply in every mode. Read `AiSecurityError.rejection` in the transport handler. For `'close'`, destroy the socket before writing response bytes and preserve the close through proxies. For `'respond'`, return a sanitized host error.

## Verify the installed package

Run the host integration tests with an injected scripted model to verify the Nest wiring, authorization, limits, and tool output. Compare a chat result with the corresponding domain read. With a tool-capable model running, ask for a Banana trend using a dashboard mention, reload the page, then ask a follow-up in the same session. Verify the request carries the same session ID and the response identifies any successful service calls. Also try the unusual-order question about last week and verify bulk inputs are rejected or bounded before execution.
