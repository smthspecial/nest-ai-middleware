---
id: TASK-011
type: task
title: "Qualify the PostgreSQL storage adapter"
status: testing
created: 2026-11-18
storyId: US-006
releaseId: REL-001
priority: high
dependsOn: TASK-010
---

# Qualify the PostgreSQL storage adapter

The PostgreSQL adapter uses a host-owned `pg.Pool` and versioned migrations in `nest_ai_middleware`. The package builds and type-checks. [PostgreSQL setup](../../../packages/adapter-postgres/README.md).

Verify initialization, restart durability, owner-scoped reads, and lease contention against PostgreSQL. Track operational failure and deployment coverage in [TASK-012](task-012.md).
