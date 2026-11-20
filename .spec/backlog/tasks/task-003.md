---
id: TASK-003
type: task
title: "Resolve and authorize read tools in Nest"
status: done
created: 2026-11-18
storyId: US-002
releaseId: REL-001
priority: high
dependsOn: TASK-002
---

# Resolve and authorize read tools in Nest

The executor resolves a registered method through the owning module and the original Nest request context. It validates input and applies class and method guards before dispatch. The application service enforces resource-level access. [Guard and execution tests](../../../packages/core/test/ai-security.test.ts).
