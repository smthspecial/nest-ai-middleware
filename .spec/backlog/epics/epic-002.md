---
id: EPIC-002
type: epic
title: "Authenticated HTTP and read orchestration"
status: active
created: 2026-11-18
linkedIds: US-003,US-004
---

# Authenticated HTTP and read orchestration

The retail host serves an authenticated Nest route. The middleware discovers authorized tools, executes them sequentially, and returns final text. Independent input and output checks return a generic HTTP 500 on rejection. The database can retain the internal rejection code.

## Remaining exit criteria

Add deterministic cases for dependent calls across rounds and for the run deadline and tool-call caps. [TASK-009](../tasks/task-009.md). The larger HTTP compatibility matrix is tracked in [TASK-014](../tasks/task-014.md).
