---
id: TASK-015
type: task
title: "Implement opt-in conversation history"
status: done
created: 2026-11-18
storyId: US-007
releaseId: REL-002
priority: medium
dependsOn: TASK-010
---

# Implement opt-in conversation history

The shared adapter persists owner-scoped sessions and accepted turns. A run lease prevents overlapping writes, and resumed chats replay all saved turns in order. SQLite tests cover restart, scoped access, and lease conflict recovery. [Conversation tests](../../../packages/adapter-sqlite/test/ai-conversation.test.ts).
