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

The core exports `SdkModel` for Vercel AI SDK V3 and V4 language models. The host supplies the provider package and model. Tests cover files, tool round trips, usage, provider continuation, abort forwarding, and sanitized provider errors. [SDK adapter](../../../packages/core/README.md#use-a-vercel-ai-sdk-model).
