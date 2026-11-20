---
id: TASK-008
type: task
title: "Discover only authorized registered tools"
status: done
created: 2026-11-18
storyId: US-004
releaseId: REL-001
priority: high
dependsOn: TASK-003,TASK-007
---

# Discover only authorized registered tools

Tool discovery filters the bootstrap registry through the service class and method guards. The executor rechecks authorization before dispatch. A text-only model receives an empty tool list. [Discovery and guard tests](../../../packages/core/test/ai-security.test.ts).
