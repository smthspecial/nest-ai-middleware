---
id: EPIC-003
type: epic
title: "Bookkeeping and durable conversation state"
status: active
created: 2026-11-18
linkedIds: US-005,US-006,US-007
---

# Bookkeeping and durable conversation state

A single optional database adapter stores sessions, run status, model usage, and tool outcomes. SQLite tests verify restart, lease conflicts, migrations, and scope by verified subject and tenant. Backend services can read accepted output and recorded events for an owned run.

## Remaining exit criteria

Qualify the PostgreSQL adapter on a live database and verify production migration roles, storage failure, and host-managed retention. [US-006](../stories/us-006.md).
