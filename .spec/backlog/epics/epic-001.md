---
id: EPIC-001
type: epic
title: "Phase 1 core foundation"
status: draft
created: 2026-11-18
---

# Phase 1 core foundation

Deliver an installable NestJS package that integrates a host-supplied model and executes authorized read tools through existing Nest providers. The phase is usable from trusted application code and in a standalone Nest test harness.

## Implementation order

1. [US-001](../stories/us-001.md) defines module wiring, the adapter contract, and the bootstrap registry.
2. [US-002](../stories/us-002.md) adds the executor, integration examples, and consumer verification.

## Exit criteria

- Jest unit and Nest integration tests cover [TP-001](../../technical/test-plans/tp-001.md).
- An independent Nest fixture installs the package archive, imports the declared API, and invokes an authorized read. The examples include an offline custom model and a service with a request-scoped dependency.
- The integration README covers installation, supported combinations, schema requirements, the host's authorization responsibility, and extension points available in Phase 1.
- The delivery plan assigns the HTTP route, orchestration, response composition, and optional adapters to later phases. The initial release stays read-only. [Architecture and phased delivery](../../technical/arch/arch-001.md).
