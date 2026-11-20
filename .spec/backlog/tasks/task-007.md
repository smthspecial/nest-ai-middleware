---
id: TASK-007
type: task
title: "Validate the AI route and map verified identity"
status: done
created: 2026-11-18
storyId: US-003
releaseId: REL-001
priority: high
dependsOn: TASK-006
---

# Validate the AI route and map verified identity

The retail app serves `POST /api/ai`, validates message, session, and upload input, and resolves the caller from the authenticated request. Its controller connects response closure to cancellation and passes the original Nest context to `AiChatService`. [HTTP contract](../../technical/arch/arch-002.md#http-and-response-envelope).
