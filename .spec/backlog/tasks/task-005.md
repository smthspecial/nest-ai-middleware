---
id: TASK-005
type: task
title: "Verify the Phase 1 package and examples"
status: testing
created: 2026-11-18
storyId: US-002
releaseId: REL-001
priority: high
dependsOn: TASK-004
---

# Verify the Phase 1 package and examples

The offline Nest fixtures cover module registration, decorated tools, guarded execution, and request-scoped guards. The retail fixture consumes the packed package. [Core tests](../../../packages/core/test/ai-security.test.ts) · [Packed consumer](../../../packages/core/README.md#retail-integration-test).

Complete the remaining Phase 1 coverage for request-scoped business providers, concurrent caller isolation, ambiguous bindings, and cancellation before and after dispatch. [TP-001](../../technical/test-plans/tp-001.md).
