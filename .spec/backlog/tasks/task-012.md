---
id: TASK-012
type: task
title: "Verify PostgreSQL deployment and storage failure handling"
status: todo
created: 2026-11-18
storyId: US-006
releaseId: REL-001
priority: high
dependsOn: TASK-011
---

# Verify PostgreSQL deployment and storage failure handling

Add real PostgreSQL integration coverage for migration retries, duplicate event identities, cascading deletes, and storage failure. Verify separate migration and runtime roles. Validate a host-managed retention procedure against the persisted schema. SQLite already covers restart, missing usage, migration rollback, and a failed bookkeeping write.
