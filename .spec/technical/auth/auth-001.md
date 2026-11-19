---
id: AUTH-001
type: auth-spec
title: "Host authentication and tool authorization"
status: draft
created: 2026-11-18
linkedIds: FR-003,FR-005,FR-007,NFR-001,TP-001
---

# Host authentication and tool authorization

## Authentication and request context

- Phase 1 receives the verified caller and Nest context ID from the same trusted application invocation. The application decides how to verify the identity and resolve the tenant.
- Phase 2 accepts host-supplied Nest guards in `authenticationGuards` and `authorizationGuards`. Nest runs them on the generated `/ai` handler with its real `ExecutionContext`, in list order with all configured authentication guards before configured authorization guards. Use guard classes for Nest-managed DI, or pass instances as supported by `UseGuards()`. The host imports the modules that export any required dependencies. [NestJS guards](https://docs.nestjs.com/guards).
- Global guards run before the route guard lists. If a global authorization guard needs the authenticated principal, the host must establish it earlier in the global pipeline. A guard denial stops the request before the controller, model, or any tool. Nest and the host's exception filters handle guard exceptions and denials. [NestJS request lifecycle](https://docs.nestjs.com/faq/request-lifecycle).
- After the guard stage, a host-provided `AiIdentityResolver` maps the authenticated principal to `AiCaller`. The resolver receives the actual request and the Nest context ID. It may read a verified `request.user`, session, or host request-context provider. The controller returns 401 when it cannot establish verified identity.
- The host establishes subject, tenant, and context from trusted state. The request body and model have no authority to supply these values. Tenant-scoped services require a verified tenant and must scope their data queries and resource ownership checks to it.

## Permission declarations and policy hooks

- Eligibility requires all three registrations. The class is in the module's `services` allowlist and declares its own `@AiService()`. The concrete method declares its own `@AiTool()`. Tool lookup and execution use the validated registry. A model request cannot select an arbitrary class or member, extend the registry, or inherit an exposure marker.
- `@AiPermissions('orders:read')` declares host-defined permission labels on a service class or `@AiTool()` method. At bootstrap, collect class labels from base class to concrete service, then the method's own labels. Deduplicate while preserving declaration order. Method declarations add to class requirements. Reject empty declarations, blank labels, or a tool with no effective requirements.
- The host supplies an `AiAuthorizationPolicy` through `forRoot()` or an injected `forRootAsync()` factory. `canExecute` receives the trusted context, effective requirements, and validated arguments. It must enforce all declared labels and any resource-level rules. Only a literal `true` authorizes dispatch. Errors, invalid decisions, missing identity, deadline expiry, and cancellation deny dispatch.
- Phase 2 calls `canDiscover` with caller context and tool requirements before the registry item enters the model prompt. Discovery is a separate grant to reveal a capability. Execution requires a fresh `canExecute` decision with validated arguments on every call. Omit permission labels from model-facing tool definitions.
- A Nest authorization guard decides whether the caller can access `/ai` as a route. Tool methods run directly on service instances, where `AiAuthorizationPolicy` decides whether the caller can invoke each specific tool with its validated arguments. The guard and tool policy can share the host's permission service. Keep resource ownership checks in the business service.

For example, a multi-tenant host could back its tool policy with the same permission service its HTTP guards use.

```ts
const ordersToolPolicy: AiAuthorizationPolicy = {
  async canExecute({ context: { caller }, tool, args }) {
    const { subjectId, tenantId } = caller;
    if (!tenantId || tool.name !== 'find_orders' || tool.permissions.length === 0) {
      return false;
    }
    return (await access.hasAll(subjectId, tenantId, tool.permissions))
      && (await access.canReadOrders(caller, args));
  },
};
```

## Untrusted inputs and result disclosure

- Validate model envelopes, call IDs, arguments, and structured blocks before using them. Resolve tool names through the immutable registry and the set offered in the current round. Any lookup or authorization failure presented to the model uses a sanitized result code and omits internal binding details.
- Keep instructions, user text, tool requests, and tool data in separate message roles. Never interpret text inside a tool result as a privileged instruction. Keep allowlists, authorization, budget, and confirmation checks outside the model loop's instructions and apply them to every requested execution.
- Express forbidden inputs and resource access rules in the schema, host policy, and business service. `useWhen` and `avoidWhen` guide the model's selection. For a hard read-only guarantee, expose methods backed by read-only dependencies or credentials. A decorator cannot inspect the side effects of arbitrary service code.
- Services must return deliberately model-safe data or supply a trusted `projectResult` function to select and redact allowed fields. Snapshot and validate the projected JSON result before model use, applying output schema and size limits where configured. Reject non-JSON results and suppress raw service exceptions. Tool schemas, examples, and descriptions are also model-visible and must be safe to disclose.
- Audit with correlation IDs, declared tool names, policy outcome, stable error codes, and latency. Phase 1 exposes typed execution outcomes. Phase 2 offers optional bookkeeping; the host can project opaque tenant or subject references. Exclude credentials, raw prompts, arguments, and tool outputs from bookkeeping and core log events. Phase 4 adds optional observability integrations. Future write support requires an action audit hook. [Bookkeeping and persistence](../services/srv-001.md).

## Deferred write approval and idempotency

The initial release supports tools explicitly declared read-only. Reject write or confirmation metadata at bootstrap. Service authors are responsible for the actual behavior of methods they mark as reads. If a future release adds writes, it requires explicit approval for every write and may support confirmation for reads marked by the host. A write call occupies its own model round. A mixed or multi-write batch is rejected before dispatch.

1. Reuse the execution authorization check on a validated proposal. Store an immutable record with the opaque action ID, actor, tenant, conversation, registered tool, validated arguments, schema or application revision, expiration, and stable operation key. Present a host-generated summary of the action and its target.
2. Accept approval or rejection through the authenticated HTTP route. Verify actor, tenant, expiration, and registration revision. Approval claims the action atomically, revalidates its saved arguments, and rechecks current permissions before calling the service. Rejection closes the action without dispatch. Unknown actions and actions owned by a different caller share a safe response.
3. Pass the same operation key to the business service on any permitted recovery. The application must atomically deduplicate the key with the business mutation, or provide an equivalent durable idempotency guarantee in the target system. Tool and action records carry explicit claimed, completed, failed, rejected, expired, or outcome-unknown states. A crash, timeout, or disconnect after dispatch can leave an unknown result. Resolve it through the host's idempotent service or reconciliation path before reporting success or attempting recovery.
4. Refuse to enable writes without a durable action store and a host idempotency mechanism. Replayed successful approvals may return a stored safe result to the authorized caller. Concurrent attempts cannot independently dispatch the same action. Apply host retention and access policies to saved arguments, results, and audit data.

Conversation and approval identifiers are references scoped to trusted identity, with no authority on their own. Cookie-authenticated deployments apply the host's CSRF protection to the AI endpoint, including confirmation requests.
