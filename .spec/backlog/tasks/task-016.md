---
id: TASK-016
type: task
title: "Ship the optional SQLite storage adapter"
status: done
created: 2026-11-18
storyId: US-013
releaseId: REL-002
priority: medium
dependsOn: TASK-010
---

# Ship the optional SQLite storage adapter

The standalone SQLite package supports a host-selected file or `:memory:` and applies versioned schema upgrades when opening the database. Integration tests cover restart, migration, rollback, and owner-scoped session and run reads. [SQLite adapter](../../../packages/adapter-sqlite/README.md).
