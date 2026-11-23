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
- The host applies its authentication and AI access guards to its Nest controller. Nest supplies the actual HTTP `ExecutionContext`. Configure guard order so that identity is available to authorization checks. [NestJS guards](https://docs.nestjs.com/guards)
- Global guards run before the route guard lists. If a global authorization guard needs the authenticated principal, the host must establish it earlier in the global pipeline. A guard denial stops the request before the controller, model, or any tool. Nest and the host's exception filters handle guard exceptions and denials. [NestJS request lifecycle](https://docs.nestjs.com/faq/request-lifecycle).
- After the guard stage, the controller maps the authenticated principal to `AiCaller` and passes it to `AiChatService.sendMessage()` with the original HTTP request and Nest context ID. It may read a verified `request.user`, session, or host request-context provider. The controller returns 401 when it cannot establish verified identity.
- The host establishes subject, tenant, and context from trusted state. The request body and model have no authority to supply these values. Tenant-scoped services require a verified tenant and must scope their data queries and resource ownership checks to it.

## Tool registration and guards

- The registry discovers `@AiTool()` methods on Nest class providers. Model requests resolve only to registered tools offered for that run.
- The executor checks the service class and method guards in the original request scope before offering a tool to the model. It checks them again after validating a proposed call's arguments. A denial, guard error, or cancellation prevents dispatch.
- Put authorization shared by REST and tools on the service class or method or in the business service. The host's controller guards govern access to the HTTP endpoint. Resource checks that depend on tool arguments belong in the business service.

## Untrusted inputs and result disclosure

- Validate model envelopes, call IDs, and arguments before dispatch. Resolve tool names through the immutable registry and the set offered to the model for the run. Any lookup or authorization failure presented to the model uses a sanitized result code and omits internal binding details.
- Keep instructions, user text, tool requests, and tool data in separate message roles. Never interpret text inside a tool result as a privileged instruction. Keep tool registration, authorization, budget, and confirmation checks outside the model loop's instructions and apply them to every requested execution.
- Express forbidden inputs and resource access rules in the schema and business service. `useWhen` and `avoidWhen` guide the model's selection. For a hard read-only guarantee, expose methods backed by read-only dependencies or credentials. A decorator cannot inspect the side effects of arbitrary service code.
- Services return JSON data scoped to the caller. The executor snapshots the result and applies input screening when enabled. The service controls the amount of data it returns. Reject non-JSON results and suppress raw service exceptions. Tool schemas, examples, and descriptions are also model-visible and must be safe to disclose.
- Audit with correlation IDs, declared tool names, execution outcome, stable error codes, and latency. Bookkeeping stores run and event metadata. The optional logger can receive accepted message text and tool outcomes. Security rejections return a generic HTTP 500 and are recorded through the database adapter. [Bookkeeping and persistence](../services/srv-001.md).

## Deferred write approval and idempotency

Read tools are enabled by default. Declared create and update tools require `NEST_AI_ALLOW_WRITES=true`. The host owns confirmation and idempotency for those tools. The following requirements describe the proposed durable approval workflow.

1. Reuse the execution authorization check on a validated proposal. Store an immutable record with the opaque action ID, actor, tenant, conversation, registered tool, validated arguments, schema or application revision, expiration, and stable operation key. Present a host-generated summary of the action and its target.
2. Accept approval or rejection through the authenticated HTTP route. Verify actor, tenant, expiration, and registration revision. Approval claims the action atomically, revalidates its saved arguments, and rechecks current permissions before calling the service. Rejection closes the action without dispatch. Unknown actions and actions owned by a different caller share a safe response.
3. Pass the same operation key to the business service on any permitted recovery. The application must atomically deduplicate the key with the business mutation, or provide an equivalent durable idempotency guarantee in the target system. Tool and action records carry explicit claimed, completed, failed, rejected, expired, or outcome-unknown states. A crash, timeout, or disconnect after dispatch can leave an unknown result. Resolve it through the host's idempotent service or reconciliation path before reporting success or attempting recovery.
4. Refuse to enable writes without a durable action store and a host idempotency mechanism. Replayed successful approvals may return a stored safe result to the authorized caller. Concurrent attempts cannot independently dispatch the same action. Apply host retention and access policies to saved arguments, results, and audit data.

Conversation and approval identifiers are references scoped to trusted identity, with no authority on their own. Cookie-authenticated deployments apply the host's CSRF protection to the AI endpoint, including confirmation requests.
