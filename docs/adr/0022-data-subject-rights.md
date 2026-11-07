# 0022. Data-subject rights: export, deletion and retention as Temporal workflows

Status: accepted (owner decision, 2026-11-07: one workflow exports or deletes a person's data
everywhere, in our database and storage and in the external tools; AI content retention is
enforced, not only recorded)

## Context

Personal data no longer lives only in Postgres and S3: PostHog, Langfuse, Chatwoot, GA4 and the
error tracker hold some too. GDPR Art. 15/20 (access, portability) and Art. 17 (erasure) need one
reliable path that covers all of them, that can be resumed after a crash, and that leaves a record
of what was done. At the same time some records must outlive a deletion: the `ai_calls` log
(EU AI Act Art. 12/26(6), docs/ai-act.md) and `audit_log`. Usage and the data map:
[docs/privacy.md](../privacy.md).

## Decision

- **Temporal workflows in the Python worker**, like every other background job (ADR 0004). The
  API only validates, writes a `privacy_requests` row and starts `DataExportWorkflow` or
  `DataDeletionWorkflow` with the request id (ids only, no content). No job table, no own step
  journal: progress is the workflow history, the outcome is the row's `status` and `report`.
- **Deletion = one activity per step** (`sessions`/`access`, `webhooks`, `billing`, one per tool,
  `storage`, `database`), each idempotent. Our own steps retry until they succeed; a tool that
  keeps failing (8 attempts with backoff, or a permanent 4xx) is recorded as `failed` with its
  status code and the workflow continues, so the report says what could not be deleted and why.
  A crash resumes at the unfinished step (Temporal replays the finished ones from history).
- **Grace period as a durable timer** (`PRIVACY_DELETION_GRACE_DAYS`, default 14): the workflow
  waits on `wait_condition(cancelled, timeout=…)`. Cancelling updates the row first
  (`scheduled` → `cancelled`, atomic) and then signals; the workflow starts only if its
  conditional `scheduled` → `running` update succeeds, so the row, not signal timing, decides.
- **Re-auth and ownership**: deletion needs a sign-in from the last 10 minutes (the same rule as
  2FA changes, ADR 0017); organization export/deletion is for owners; a user who is the only owner
  of an organization must hand it over or delete it first, so no organization is left ownerless.
- **What stays**: `ai_calls` rows (append-only, no UPDATE for the app role) and `audit_log` rows
  are kept, the latter with `ip` cleared; their `actor_id` is a random id whose user row is gone.
  A deleted organization is anonymised in place (name, slug, logo, metadata) so these rows keep
  their foreign key, and the retention schedule deletes it, cascading to them, after
  `PRIVACY_ORG_RECORDS_DAYS` (default 180, the Art. 26(6) minimum of six months). Files and
  rows of an organization are the organization's (it is the controller of tenant data); a user's
  deletion only unlinks them (`attachments.created_by`, `projects.reviewed_by`).
- **Export** is one ZIP (JSON per table and per tool, the files, a README listing every source
  and what it could not provide) in `S3_BUCKET` under `privacy-exports/`. The mail links to the
  privacy settings page, which mints a 5-minute presigned URL per click after sign-in: a
  forwarded mail or a mail log is not a bearer link to someone's data. Rate limit: one export per
  subject per `PRIVACY_EXPORT_INTERVAL_HOURS` plus a per-route limit.
- **Retention is a Temporal Schedule** (`privacy-retention`, daily), not a bucket lifecycle rule:
  `content_expires_at` is per call (the setting can change), and the same schedule also expires
  export ZIPs and purges deleted organizations. It deletes content whose expiry passed since the
  previous run (`get_last_completion_result` is the watermark), so each call is visited once and
  a missed day is caught up. The row stays: it holds no content.
- **Tool adapters are plain HTTP** (`httpx2`, already used) against each tool's documented API,
  one small class per tool in `worker/privacy.py`; no vendor SDKs. GA4's service-account token is
  a self-signed JWT with `cryptography` (already a dependency) instead of `google-auth`. A tool
  without per-person data or without an API is listed in every report with the reason, so the
  record is complete (support matrix in docs/privacy.md).

## Alternatives considered

- **S3 lifecycle rule for AI content** (the previous TODO): no code, but it cannot follow
  per-row expiry, does not exist on every S3-compatible store in the same form, and leaves exports
  and deleted organizations to something else anyway.
- **Deleting `ai_calls` rows on user erasure**: breaks the append-only audit record the AI Act
  asks deployers to keep; the content (where personal data is) is deleted instead.
- **A step table for resumability**: duplicates what the workflow history already records.

## Consequences

- A deployment must configure each tool's admin credentials in the worker for deletion to reach
  it; unconfigured tools are reported as `skipped`, not silently ignored.
- `audit_log` must stay updatable for `ip` (docs/TODO.md suggests making it append-only; that
  change would need a column-level grant or a different anonymisation).
- Billing: the provider is called from the API (the worker has no provider adapters), so the
  owner's deletion request stops renewal right away (`BillingProvider.cancel`, ADR 0019); the
  worker's `billing` step only confirms nothing renews any more and drops our row. Cancelling the
  deletion does not resume the subscription.
