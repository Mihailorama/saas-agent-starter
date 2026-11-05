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
- **AI content retention is recorded, not enforced.** `ai_calls.content_expires_at` is set from
  `AI_CONTENT_RETENTION_DAYS`, but nothing deletes the S3 objects. Fix: apply an S3 lifecycle
  expiration rule to `AI_CONTENT_BUCKET` at deploy time (or a scheduled Temporal workflow that
  deletes expired objects); keep the rows, which hold no content.
- **AI calls export loads all rows in memory** (`apps/api/src/routes/ai-calls.ts`). Fine for
  thousands of rows; stream with a server-side cursor before orgs reach ~100k calls.
- **`audit_log` is not append-only** for the app role, unlike `ai_calls`. Consider adding it
  to the append-only list in `packages/db/src/migrate.ts` (check nothing updates it first).
