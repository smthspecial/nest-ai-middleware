---
id: ARCH-002
type: arch
title: "Public TypeScript API and model protocol"
status: draft
created: 2026-11-18
linkedIds: FR-001,FR-002,FR-003,FR-004,FR-005,FR-006,FR-007
---

# Public TypeScript API and model protocol

The signatures and examples describe the proposed library API. Phase 1 exports the configuration, decorators, adapter types, and programmatic executor. The HTTP contract begins in Phase 2.

## NestJS integration

```ts
AiModule.forRoot({
  model: readyToUseModel,
  services: [OrdersService],
  authorization: ordersToolPolicy,
});

AiModule.forRootAsync({
  imports: [ModelModule, OrdersPolicyModule],
  inject: [AI_MODEL, ORDERS_TOOL_POLICY],
  useFactory: (model: AiModel, authorization: AiAuthorizationPolicy) => ({
    model,
    services: [OrdersService],
    authorization,
  }),
});
```

The host imports the module that owns `OrdersService` into its Nest application. `ModelModule` and `OrdersPolicyModule` export the tokens injected by the async factory. The factory may return options or a promise. The model, policy, and options are application-level providers. The policy receives caller identity per invocation.

```ts
export interface AiModuleOptions {
  model: AiModel;
  services: readonly Type<unknown>[];
  authorization: AiAuthorizationPolicy;
  execution?: { toolTimeoutMs?: number };
}

export interface AiCaller {
  readonly subjectId: string;
  readonly tenantId?: string;
}

export interface AiExecutionContext {
  readonly caller: AiCaller;
  readonly contextId: ContextId;
  readonly abortSignal?: AbortSignal;
}

export interface AiAuthorizationPolicy {
  canExecute(input: {
    context: AiExecutionContext;
    tool: AiToolPolicyInput;
    args: Readonly<JsonObject>;
  }): boolean | Promise<boolean>;
}

export interface AiToolPolicyInput {
  readonly name: string;
  readonly permissions: readonly string[];
  readonly readOnly: true;
}

export declare class AiToolExecutor {
  execute(name: string, args: unknown, context: AiExecutionContext): Promise<JsonValue>;
}
```

`execute` is a trusted server entry point. It rejects with a typed, stable error code for unavailable tools, invalid arguments, denied authorization, invalid results, timeouts, cancellation, and service failures. The authorization policy receives the trusted caller and Nest context, the tool's effective permission labels, and an immutable validated argument snapshot. It can use injected dependencies or resolve request-scoped permissions in the supplied Nest context.

## Tool declaration

```ts
@Injectable()
@AiService()
@AiPermissions('orders:access')
export class OrdersService {
  @AiPermissions('orders:read')
  @AiTool({
    name: 'find_orders',
    description: 'Find recent orders for the current customer',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
      required: ['limit'],
      additionalProperties: false,
    },
  })
  async findOrders(@AiArgs() input: { limit: number }) {
    return this.orders.findRecentForCurrentCustomer(input.limit);
  }
}
```

Phase 1 accepts one `@AiArgs()` object parameter on a decorated method. A parameterless business action can declare an empty object schema. Proposed metadata includes `useWhen`, `avoidWhen`, `tags`, `examples`, `outputSchema`, `resultHint`, and optional host-authored `projectResult`. The initial contract requires `readOnly: true`. A registration that declares write or confirmation behavior fails during bootstrap. Names are unique and match `[a-z][a-z0-9_]{0,63}`. Validate examples against the same schema used for execution. Model definitions contain selection hints and the input schema. Runtime bindings, permissions, output schema, and projection stay in the server registry.

`AiService(): ClassDecorator` explicitly opts a concrete service into AI registration. The class must also be listed in `services`, and each exposed method must declare its own `@AiTool()`. The class marker does not grant method access. Bootstrap rejects an allowlisted class without its own marker.

`AiPermissions(...permissions: [string, ...string[]]): ClassDecorator & MethodDecorator` declares app-defined requirements. Class and method declarations accumulate, including class requirements from base classes. `find_orders` requires both `orders:access` and `orders:read`. Each tool needs at least one effective label and approval by the host policy on every invocation. Decorator order does not affect the effective permissions.

Use JSON Schema draft-07 with an object root for inputs, closed object shapes, and local references only. Compile code-owned schemas at startup and reject unsupported keywords or references. Use strict validation without coercion, implicit defaults, or silent property removal. Input DTO annotations may inform a future helper. Direct tool calls receive validated plain data. Methods that depend on DTO prototypes or transformations need a host-owned adaptation.

## Model adapter

```ts
export type JsonValue = null | boolean | number | string | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export interface AiToolDefinition {
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
  | { ok: true; data: JsonValue }
  | { ok: false; code: string };

export type AiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls?: readonly AiToolCall[] }
  | { role: 'tool'; callId: string; name: string; result: AiToolResult };

export interface AiModelRequest {
  readonly messages: readonly AiMessage[];
  readonly tools: readonly AiToolDefinition[];
  readonly abortSignal?: AbortSignal;
  readonly responseSchema?: JsonObject;
}

type AiUsage = { inputTokens?: number; outputTokens?: number };

export type AiModelResponse = (
  | { kind: 'final'; message: string; structuredOutput?: unknown }
  | { kind: 'tool-calls'; message?: string; toolCalls: readonly AiToolCall[] }
) & { usage?: AiUsage };

export interface AiModel {
  readonly capabilities: {
    readonly toolCalling: boolean;
    readonly structuredOutput?: boolean;
  };
  generate(request: AiModelRequest): Promise<AiModelResponse>;
}

export type AiModelErrorCode =
  | 'MODEL_TIMEOUT'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_PROTOCOL_ERROR'
  | 'UNSUPPORTED_MODEL_CAPABILITY';

export declare class AiModelError extends Error {
  constructor(code: AiModelErrorCode);
  readonly code: AiModelErrorCode;
}
```

The adapter maps its SDK's messages, usage, errors, and argument encoding to these types. If the SDK emits JSON strings for arguments, the adapter size-checks and parses them once. Core independently validates JSON shape and bounds for the complete batch. Each call must have bounded JSON object arguments and a unique ID within the run. Schema violations for otherwise well-formed calls become tool result errors. The orchestrator associates each accepted call with one bounded result, preserving the original order in the transcript even when authorized reads run concurrently. The adapter passes abort signals to the SDK where supported. It can throw `AiModelError` for known failure categories. Core maps other adapter exceptions to `MODEL_UNAVAILABLE` and discards raw exception details from client responses. Provider credentials and SDK types stay inside the adapter boundary.

Phase 2 requires declared tool calling for the tool-enabled route. Startup rejects an incompatible model configuration with an explicit error. A validated fallback, if added later, must be configured independently. Structured output is optional and only requested when the adapter declares support. Plain text and trusted renderers cover simpler models. Streaming is an optional future adapter interface, so `generate()` remains the base contract.

## HTTP and response envelope

Phase 2 accepts `POST /ai` with `{ "message": "Show my last five orders", "conversationId": "optional-id" }`. Validate the body strictly and generate an opaque ID when omitted. In the stateless Phase 2 implementation, a supplied ID is a correlation value only. A later store must bind history to the authenticated caller and tenant and distinguish absent or inaccessible conversations through a safe error. Preserve the host's global route prefix. Mount the route through Nest so host guards and request context apply.

Both `forRoot()` and `forRootAsync()` accept `authenticationGuards` and `authorizationGuards` for the generated route. Bind them with Nest's `UseGuards()` in one ordered list, with authentication first and authorization second. The host can rely on its global guards for either stage. An `AiIdentityResolver` then reads verified identity from the actual request and its Nest context. `canDiscover` checks the resulting caller's access before exposing tool definitions. `canExecute` additionally checks the validated arguments before dispatch. [Authentication and policy details](../auth/auth-001.md).

```ts
type AiNestGuard = Type<CanActivate> | CanActivate;

export interface AiHttpRouteOptions {
  endpoint?: string;
  authenticationGuards?: readonly AiNestGuard[];
  authorizationGuards?: readonly AiNestGuard[];
  routeDecorators?: readonly MethodDecorator[];
}

export interface AiIdentityResolver {
  resolveCaller(
    request: object,
    contextId: ContextId,
  ): AiCaller | undefined | Promise<AiCaller | undefined>;
}

export interface AiHttpAuthorizationPolicy extends AiAuthorizationPolicy {
  canDiscover(input: {
    context: AiExecutionContext;
    tool: AiToolPolicyInput;
  }): boolean | Promise<boolean>;
}

AiModule.forRootAsync({
  endpoint: '/ai',
  authenticationGuards: [JwtAuthGuard],
  authorizationGuards: [AiAccessGuard],
  imports: [ModelModule, HostAuthModule],
  inject: [AI_MODEL, AI_IDENTITY_RESOLVER, ORDERS_TOOL_POLICY],
  useFactory: (
    model: AiModel,
    identityResolver: AiIdentityResolver,
    authorization: AiHttpAuthorizationPolicy,
  ) => ({ model, services: [OrdersService], identityResolver, authorization }),
});
```

With `forRootAsync()`, pass `AiHttpRouteOptions` on the registration object so Nest can bind controller metadata before it runs the options factory. The factory supplies `identityResolver` and `authorization`. With `forRoot()`, pass the route options alongside the resolver and policy. Both registration forms can import host modules that export the guards' injectable dependencies. Optional `routeDecorators` attach the metadata expected by the host's guards, such as `@Roles('ai-user')`. Configure guard order through the two guard lists. The guard classes and injection tokens in this example belong to the host.

Use a stable `{ "error": { "code": "...", "requestId": "..." } }` envelope for errors owned by the library. The draft maps invalid input to 400, missing identity to 401, forbidden requests to 403, oversized bodies to 413, model protocol failures to 502, temporary model unavailability to 503, and an expired interaction deadline to 504. Individual read failures are tool results for the orchestrator. Host guards and transport errors follow the host's error handling.

```ts
export interface AiResponse {
  conversationId: string;
  message: string;
  blocks: AiResponseBlock[];
}

export type AiResponseBlock =
  | { type: 'text'; content: string }
  | { type: 'list'; items: string[] }
  | { type: 'table'; columns: { key: string; label: string }[]; rows: JsonObject[] }
  | { type: 'chart'; chartType: 'bar' | 'line' | 'pie'; points: { label: string; value: number }[] }
  | { type: 'entity-list'; entityType: string; items: JsonObject[] }
  | { type: 'data'; data: JsonValue };
```

Phase 2 returns `message` and text blocks. Phase 3 adds the other variants and verifies block schemas and counts, chart data, and table columns. Invalid model-generated blocks fall back to safe text or trusted projections. Render text as text and keep HTML, scripts, and arbitrary executable content out of the protocol. Confirmation requests and action forms belong to the deferred write milestone. [Deferred write requirements](../../requirements/fr/fr-007.md).

## Bookkeeping and persistence

Phase 2 adds optional `bookkeeping` configuration. The host can enable a bounded memory store or inject a persistent store. The first PostgreSQL integration records run status, tool outcomes, and model usage. Phase 4 adds optional conversation history and SQLite integration. [Configuration and store contracts](../services/srv-001.md).
