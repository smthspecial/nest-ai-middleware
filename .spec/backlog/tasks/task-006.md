---
id: TASK-006
type: task
title: "Bind host authentication and authorization guards"
status: done
created: 2026-11-18
storyId: US-003
releaseId: REL-001
priority: high
dependsOn: TASK-003
---

# Bind host authentication and authorization guards

The retail controller applies native authentication and read guards in order. The packed HTTP fixture verifies that unsigned requests are rejected and authorized requests reach the middleware, and the core fixture verifies guard order in the original request scope. [Host integration](../../technical/auth/auth-001.md).
