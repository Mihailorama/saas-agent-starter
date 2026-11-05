# Known limitations / backlog

- **Transactional outbox for workflow starts.** `POST /api/projects` starts the Temporal
  workflow after commit; if Temporal is unreachable at that moment the start is logged and lost
  (`apps/api/src/routes/projects.ts`). Fix: write an outbox row in the same transaction and have a
  small relay start workflows from it (still idempotent via the workflow id).
- **Attachment upload confirmation.** The attachment row is created before the browser uploads
  the bytes, so an abandoned upload leaves a row without an object. Fix: add `uploaded_at`, set it
  from a `POST .../attachments/:id/complete` that HEADs the object, and hide/expire rows without it.
- **osv-scanner ignore for `@opentelemetry/core` 1.x** expires 2027-02-01 (`osv-scanner.toml`).
  Remove it once `@temporalio/interceptors-opentelemetry` depends on OpenTelemetry 2.x.
