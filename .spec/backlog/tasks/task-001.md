---
id: TASK-001
type: task
title: "Set up the package and module registration"
status: done
created: 2026-11-18
storyId: US-001
releaseId: REL-001
priority: high
---

# Set up the package and module registration

The core package ships ESM and TypeScript declarations with Nest peer dependencies. Jest verifies synchronous registration, dependency injection through `forRootAsync()`, and startup configuration validation. [Registration tests](../../../packages/core/test/ai.module.test.ts).
