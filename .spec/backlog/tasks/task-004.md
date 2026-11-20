---
id: TASK-004
type: task
title: "Enforce tool deadlines and safe outputs"
status: done
created: 2026-11-18
storyId: US-002
releaseId: REL-001
priority: high
dependsOn: TASK-003
---

# Enforce tool deadlines and safe outputs

The executor applies an abort signal and deadline to authorization, provider resolution, and invocation. It snapshots JSON arguments and results, applies configured prompt checks, and maps service failures to stable errors. Services select the fields they return. [Tool executor](../../../packages/core/src/executor/ai-tool-executor.ts).
