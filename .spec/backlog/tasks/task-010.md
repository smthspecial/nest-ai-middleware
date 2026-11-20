---
id: TASK-010
type: task
title: "Emit run, model, and tool bookkeeping records"
status: done
created: 2026-11-18
storyId: US-005
releaseId: REL-001
priority: high
dependsOn: TASK-009
---

# Emit run, model, and tool bookkeeping records

The optional `database.adapter` records run outcomes, model usage when reported, and tool attempts. Tests verify accepted output reads, stored events, and a sanitized diagnostic when a bookkeeping write fails. [Storage contract](../../technical/services/srv-001.md#run-records-and-visibility).
