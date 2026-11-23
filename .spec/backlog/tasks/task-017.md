---
id: TASK-017
type: task
title: "Provide and verify the bundled AI SDK adapter"
status: done
created: 2026-11-18
storyId: US-009
releaseId: REL-002
priority: medium
dependsOn: TASK-009
---

# Provide and verify the bundled AI SDK adapter

The core exports `AiSdkModelAdapter` for models implementing the Vercel AI SDK language-model specification V3 or V4. The host supplies the provider package and model. Tests cover files, tool round trips, usage, provider continuation, abort forwarding, and sanitized provider errors. [SDK adapter](../../../packages/core/README.md#use-a-vercel-ai-sdk-model).
