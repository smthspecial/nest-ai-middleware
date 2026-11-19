# NestJS AI Middleware

A reusable NestJS module shaped around a host-provided model, a service allowlist, and a host authorization policy. The module validates allowlisted tool calls, resolves registered Nest services and runs a bounded model loop. A host controller can call `AiOrchestrator.run()` with a verified caller and a Nest context ID.

## Development

Use Node.js 26 and npm. From the workspace root, run the following commands. The library targets NestJS 12 and ships as ESM with TypeScript declarations.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run pack:packages
```

`npm publish --workspace nestjs-ai-middleware --dry-run` runs the publish checks and lists the package contents. The package ships the ESM build, TypeScript declarations, README, and integration skill. The plugin database and test fixtures stay in the development checkout.

## Register the module

```ts
import { Module } from '@nestjs/common';
import { AiModule, type AiModel } from 'nestjs-ai-middleware';

const model: AiModel = {
  capabilities: { toolCalling: false },
  async generate() {
    return { kind: 'final', message: 'Offline model reply' };
  },
};

@Module({
  imports: [
    AiModule.forRoot({
      model,
      services: [],
      authorization: { canExecute: () => false },
    }),
  ],
})
export class AppModule {}
```

Use `AiModule.forRootAsync({ imports, inject, useFactory })` when Nest providers supply the model or policy. Host modules export the tokens listed in `inject`. Both registration methods validate their configuration during bootstrap. `execution.toolTimeoutMs` defaults to 10,000 milliseconds.

## Source structure

- `src/contracts/` contains the options, model protocol, authorization, run, conversation, and logger types. Import the public types through the package entry point.
- `src/ai.module.ts` and `src/config/` handle Nest registration, startup validation, and building the tool registry. `src/decorators/` defines how host services declare their tools.
- `src/orchestrator/` runs the model loop. `src/security/`, `src/executor/`, `src/conversation/`, and `src/logging/` handle screening, tool dispatch, conversation lifecycle, and log delivery.
- `src/events/` publishes committed tool events to local subscribers.

## Retail integration test

The local `test-app` workspace exercises the packed package through a Nest HTTP route. Its domain services power both REST endpoints and read-only AI tools. The host controller owns authentication and request validation. See the [Nest integration skill](skills/nest-ai-middleware-integration/SKILL.md) for the worked integration.

## Access and prompt security

Authenticate the host endpoint and derive `AiExecutionContext.caller` from the verified request. Pass the original request under `http` and use its Nest context ID. The executor runs `@UseGuards()` declared on the registered service class and tool method in class-first order, using the owning Nest module and original request scope. Guarded tools require HTTP context. The host policy still checks tool permissions and validated arguments. Controller route guards apply on their own HTTP routes. Resource checks that rely on tool arguments belong in the host policy or service. [NestJS guards](https://docs.nestjs.com/guards)

Built-in prompt checks inspect input, history, model text, tool arguments, and tool results. Configure them in `forRoot()` or the `forRootAsync()` factory.

```ts
promptSecurity: {
  rules: [{ contains: 'internal cost price', stages: ['input', 'output'] }],
  classifier: { model: securityModel, stages: ['input', 'output'], timeoutMs: 5000 },
  rejection: 'close',
}
```

Omitting `promptSecurity` enables the built-in signatures. `rules` adds normalized, case-insensitive deny phrases. Omit a rule's `stages` to apply it at every stage. An `allow` callback can add a host policy. Set `builtInChecks: false` to select host rules, a callback, or a classifier in place of the default signatures.

The optional classifier receives the stage and content in a separate model call with an empty tool list. It checks input and output by default. The classifier must return `ALLOW` to permit the content. A rejection, invalid answer, or timeout uses the configured rejection behavior. Choose the classifier provider with the host's data handling requirements in mind.

`enabled: false` skips the configurable screening. Credential fields, recognizable secret formats, credential extraction requests, and destructive database patterns are checked in every mode. Tool schemas and authorization apply independently. Design tool responses to contain only data the caller may read.

A detected violation throws `AiSecurityError` with the configured `rejection` mode. For the default `'close'`, an HTTP host destroys the socket before writing a response. A proxy in front of that route must preserve the aborted connection. For `'respond'`, the host can return a sanitized error such as HTTP 403. Signature checks cover common injection patterns. Keep closed argument schemas, fixed parameterized queries, and per-tool authorization as enforced boundaries.

### Tool operations

Read tools default to `operation: 'get'`. A host can opt in to `create` and `update` with `execution.allowWrites: true` and register specific tools with `readOnly: false` and an explicit `operation`. The policy receives `tool.operation`, the authenticated caller, and the validated arguments. Check resource ownership and the applicable permission on every dispatch. The registry rejects `delete`. Keep delete, cascade-delete, and arbitrary SQL capabilities outside the tool allowlist. Apply any required confirmation or idempotency in the host's write flow. The example exposes reads only.

Give each tool a stable ID with `@AiTool({ id: 'catalog.product-trend', ... })`. The registry checks uniqueness and uses the tool name as the ID when omitted. Successful calls expose the stable `toolId` and a distinct, generated `invocationId` through `onToolResult`. Each run returns its own `runId` and the IDs of the tools it executed successfully.

### Conversations

Pass a host-initialized adapter as `database.adapter` in `forRoot()` or `forRootAsync()`. SQLite is the local default choice and uses Node’s built-in driver. The host opens and closes the database.

```ts
import { SqliteDatabaseAdapter } from 'nestjs-ai-middleware-adapter-sqlite';

const adapter = new SqliteDatabaseAdapter('./data/nest-ai-middleware.sqlite');
AiModule.forRoot({
  model,
  services,
  authorization,
  database: { adapter },
  logger,
});
```

Call `run()` with the verified caller to start a session. Keep the returned `sessionId` and pass it in the run options on each follow-up. The plugin binds the session to the caller's subject and tenant, serializes active runs within the session, and saves only exchanges that pass screening. `readConversation(sessionId, caller, after?)` returns a page of complete turns. Start at cursor zero and follow `nextAfter` until omitted.

The adapter returns original turns in bounded pages. The core conversation service selects the opening exchange and as many recent exchanges as fit into a 24 KiB context budget, with up to 3 KiB per prior message. The core also issues session IDs and chooses when to release a lease or discard an empty session. `AI_REQUEST_LIMITS` exports these limits and the 16 KiB current-message limit. Callers using the plugin without persistence may pass bounded `history` directly. With persistence enabled, the session is the source of history.

### Logging

Pass your initialized `AiLogger` in `logger`. The interface has one method, `log(event: AiLogEvent)`. Events carry the verified subject, tenant when present, run ID, and session ID once ownership is established. The `input` and `output` events include screened text. The `reasoning` events report observable tool calls and run rejections, including stable tool and invocation IDs when available. Raw rejected content and model chain of thought stay out of these events. The host controls where accepted text is sent and how the sink retains it. Sink errors and timeouts leave the interaction available.

## SQLite

The retail integration places the database in this plugin checkout at `data/nest-ai-middleware.sqlite`. SQLite stores session ownership in `ai_chat_sessions` and accepted exchanges in `ai_chat_turns`. The same file holds `ai_runs` for run status and `ai_run_events` for generation calls and tool attempts, including duration, provider-reported token usage, stable tool IDs, and invocation IDs. Bookkeeping stores metadata and stable error codes. Accepted transcript text lives in the conversation tables. [Node.js SQLite documentation](https://nodejs.org/api/sqlite.html)

### Adapter packages

The adapter packages are `nestjs-ai-middleware-adapter-sqlite`, `nestjs-ai-middleware-adapter-postgres`, and `nestjs-ai-middleware-adapter-mongodb`. The PostgreSQL adapter uses the host's `pg.Pool` and a dedicated schema. The MongoDB adapter uses the host's `MongoClient` and prefixed collections. Call the adapter's `initialize()` during PostgreSQL or MongoDB setup. Each adapter writes only the plugin's conversation and bookkeeping records.

The host can also supply its own implementation of `AiDatabaseAdapter`. The core controls the records and selects the conversation context consistently for every adapter.

```ts
AiModule.forRootAsync({
  imports: [HostDatabaseModule],
  inject: [HOST_AI_DATABASE],
  useFactory: (adapter: AiDatabaseAdapter) => ({
    model,
    services,
    authorization,
    database: { adapter },
  }),
});
```

Implement the adapter with parameterized queries. Check the verified subject and tenant in owner-scoped reads and lease operations. Use a transaction for lease acquisition and turn finalization. Preserve the plugin-issued IDs, per-run event sequence, and Unix millisecond timestamps. Honor the supplied abort signals. Bookkeeping writes have a 100 ms budget and report failures through the configured logger. Omitting `database` disables persistence.

### Read stored output and logs

Inject `AiRunReader` into a service in a Nest module that imports the registered `AiModule`. Apply the host's existing authentication and authorization before calling `readRun(runId, verifiedCaller, after?)`. Pass the principal established by the app's guards. The reader scopes the result to the caller's subject and tenant. It returns the run status, accepted output when available, and committed model and tool events. Start at cursor zero and follow `nextAfter` for further events. Missing and inaccessible runs both return `undefined`.

### Subscribe to tool events

Inject `AiToolEvents` into a Nest service that imports the registered module. Pass a principal established by the host and the stable tool IDs to observe.

```ts
const unsubscribe = toolEvents.subscribe(
  { caller: verifiedCaller, toolIds: ['retail.catalog.product-trend'] },
  async (event, signal) => {
    await metrics.recordToolUse(event.eventId, event.toolId, signal);
  },
);
```

By default, the subscriber receives successful tool events from the same subject and tenant. Set `outcomes` to subscribe to other outcomes. To authorize a background service principal, implement `authorization.canObserveToolEvent` using the host's permissions. It receives the subscriber, the run owner, and event metadata. When present, the policy decides all deliveries and must return `true` to permit one. A separate `AiRunReader` call has its own session ownership check.

The plugin schedules delivery after the tool attempt commits to the configured database. Each event includes the tool ID, invocation ID as `eventId`, run ID, session ID, outcome, and timing. Accepted answer text is available through the read API. Tool events carry metadata only. A successful tool can belong to a run that later fails.

Subscriptions are in-process and best effort. Each subscription has a 128-event queue. When it fills, new deliveries are dropped and the host logger can report the overflow. Handlers run independently of chat and other subscribers. Call `unsubscribe()` during the consumer's cleanup. Nest shutdown also clears queued deliveries and aborts the handler's signal. For idempotent reactions, use `eventId` as the key.
