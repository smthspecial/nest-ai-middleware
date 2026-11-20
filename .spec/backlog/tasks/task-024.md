---
id: TASK-024
type: task
title: "Configure input and output prompt screening"
status: done
created: 2026-11-20
storyId: US-003
releaseId: REL-001
priority: high
dependsOn: TASK-007
---

# Configure input and output prompt screening

Input and output screening are independently configurable and enabled by default. Rejected requests return a generic HTTP 500. A configured database adapter records `SECURITY_REJECTED` for backend inspection, and the optional logger omits the rejection event. Core, SQLite, and packed retail tests verify the behavior. [Prompt security](../../../packages/core/README.md#access-and-prompt-security).
