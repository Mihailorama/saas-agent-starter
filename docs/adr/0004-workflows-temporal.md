# 0004. Background work with Temporal

Status: accepted

## Context

AI and data tasks are slow, flaky and multi-step. They need retries, timeouts, idempotency,
visibility and a way to run in Python while the API is TypeScript.

## Decision

- Temporal (MIT) orchestrates all background work. The API starts workflows with
  `@temporalio/client`; `services/worker-py` runs workflows and activities with the Python SDK.
- Workflow ids are derived from the entity (`project-created-<id>`) with
  `REJECT_DUPLICATE`, so a retried request never runs the work twice; activities are written
  to be idempotent as well.
- Temporal persists to its own databases (`temporal`, `temporal_visibility`) on the same
  Postgres server. Local setup follows the official `temporalio/samples-server` compose
  (server + admin-tools schema setup + UI).
- OpenTelemetry interceptors on both SDKs.

## Alternatives

- A Postgres job queue (pg-boss, graphile-worker): simplest, but no cross-language workflows,
  history or UI. A message bus (NATS, Kafka): delivery only; retries, state and timeouts become
  our code. BullMQ: needs Redis semantics and is Node-only.

## Consequences

- One more service to run (Temporal Cloud is a drop-in for production).
- Workflows are started after the DB commit; if Temporal is down at that instant the start is
  logged and lost. Add a transactional outbox when that matters.
