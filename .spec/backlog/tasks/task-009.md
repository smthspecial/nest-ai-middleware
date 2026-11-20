---
id: TASK-009
type: task
title: "Run bounded model and tool rounds"
status: testing
created: 2026-11-18
storyId: US-004
releaseId: REL-001
priority: high
dependsOn: TASK-008
---

# Run bounded model and tool rounds

The chat loop validates each batch and its call IDs, runs tools sequentially, and returns ordered results to the model. It enforces the 30-second run deadline and the model-round and tool-call caps. Current tests cover tool round trips, multi-tool dispatch, and screening a whole batch before dispatch. [Answer loop](../../../packages/core/src/orchestrator/ai-answer.ts).

Add deterministic coverage for a dependent call in a later round and for the round, call, and deadline boundaries. [FR-004](../../requirements/fr/fr-004.md) · [NFR-002](../../requirements/nfr/nfr-002.md).
