# Privacy: data map, export, deletion, retention

What personal data the app stores where, how a user or an organization owner exports or deletes
it, what each external tool supports, and which retention dates are enforced. Design:
[ADR 0021](adr/0021-data-subject-rights.md). Code: `apps/api/src/routes/privacy.ts` (requests),
`services/worker-py/worker/privacy.py` (the work), `worker/workflows.py` (the workflows).

This is engineering documentation, not legal advice. Legal bases below are generic notes; the
operator of a deployment decides them, writes the privacy notice and signs the processor
agreements with the tools it configures.

## Roles

- **Account data** (user, sign-in methods, sessions): the operator is the controller.
- **Tenant data** (projects, files, webhooks, AI calls of an organization): the customer
  organization is the controller, the operator its processor. That is why erasing a user does
  not delete the files they uploaded to an organization (it unlinks them), while deleting the
  organization does.

## Data map

### Our database (Postgres)

| Table                                                         | Personal data                                                            | Export (user / org)                                     | User deletion                                                                         | Organization deletion                                                         | Generic legal basis note                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `user`                                                        | name, email, image                                                       | yes / members' name+email                               | deleted                                                                               | kept (members keep their accounts)                                            | contract                                                                                       |
| `account`                                                     | provider account ids                                                     | yes, without password hash and tokens / -               | deleted (cascade)                                                                     | -                                                                             | contract                                                                                       |
| `session`                                                     | IP, user agent                                                           | yes, without the token / -                              | deleted first (signed out everywhere)                                                 | active organization cleared                                                   | contract, security                                                                             |
| `member`                                                      | user id, role                                                            | yes / yes                                               | deleted (cascade)                                                                     | deleted                                                                       | contract                                                                                       |
| `invitation`                                                  | invitee email, inviter id                                                | sent by or addressed to the user / yes                  | sent: cascade; pending ones addressed to them: deleted                                | deleted                                                                       | contract                                                                                       |
| `two_factor`, `passkey`                                       | second-factor secrets, public keys                                       | metadata only (no secret, codes or public key) / -      | deleted (cascade)                                                                     | -                                                                             | security                                                                                       |
| `verification`                                                | email, user id in short-lived tokens                                     | - / -                                                   | rows naming the email or user id deleted                                              | -                                                                             | contract                                                                                       |
| `apikey`                                                      | none (organization-owned, hash only)                                     | - / metadata without hash                               | -                                                                                     | deleted (revoked)                                                             | contract                                                                                       |
| `organization`                                                | name, slug, logo (may name a person)                                     | - / yes                                                 | -                                                                                     | anonymised now, deleted after the record period                               | contract                                                                                       |
| `projects`                                                    | free text; `reviewed_by`                                                 | reviewed by the user / yes                              | `reviewed_by` cleared                                                                 | deleted                                                                       | contract (customer's data)                                                                     |
| `attachments` + S3 objects                                    | file contents; `created_by`                                              | uploaded by the user, with bytes / all, with bytes      | `created_by` cleared, files stay (organization data)                                  | rows and objects deleted                                                      | contract (customer's data)                                                                     |
| `ai_calls` (+ S3 request/response content)                    | `actor_id`; content can hold anything users typed                        | the user's calls with content / all with content        | **row kept** (append-only AI Act record), content deleted                             | content deleted; rows kept for the record period, then deleted                | legal obligation (record-keeping, Art. 12/26(6)) for the row; content per retention            |
| `audit_log`                                                   | `actor_id`, IP                                                           | the user's rows / all                                   | **row kept** (accountability), IP cleared                                             | IP cleared; kept for the record period, then deleted                          | legitimate interest (security, accountability)                                                 |
| `webhook_endpoints`, `_events`, `_deliveries`, `_attempts`    | event payloads (project data), endpoint URLs                             | - / yes, without signing secrets                        | -                                                                                     | endpoints disabled first, then all deleted                                    | contract                                                                                       |
| `privacy_requests`                                            | ids only                                                                 | the user's / the organization's                         | **kept** as the record of the request (report has no personal data)                   | **kept**                                                                      | legal obligation (demonstrating compliance)                                                    |

`ai_calls.actor_id` and `audit_log.actor_id` keep a random user id after erasure. The user row
that linked it to a person is gone, and so are the person's records in the tools below, so the id
no longer identifies anyone through our systems.

### Object storage (S3)

- `S3_BUCKET` (`attachments`): uploads under `<org>/<project>/<attachment>`, data exports under
  `privacy-exports/<request>.zip`.
- `AI_CONTENT_BUCKET` (`ai-calls`): LLM request/response JSON under
  `<org>/<yyyy>/<mm>/<dd>/<call>/{request,response}.json` (ADR 0008).

### Elsewhere in our stack

- **Temporal history**: workflow arguments hold ids, plus the recipient address and rendered body
  of transactional mails (incl. the export-ready mail) and, for a user deletion, the GA4 client id.
  Kept for the namespace retention period (docs/TODO.md, "Mailed links live in Temporal history").
- **Logs and traces** (Loki, Jaeger/Langfuse): ids and counts only by rule (AGENTS.md
  "Observability"); no content, no addresses.
- **Mail provider**: delivery logs with recipient addresses, under the provider's retention.

## Export ("Download my data")

1. Settings, Privacy: "Download my data" (`POST /api/privacy/user/export`) or, for an owner,
   "Download all data" (`POST /api/privacy/org/export`). One export per subject per
   `PRIVACY_EXPORT_INTERVAL_HOURS` (default 24, then 429), plus 10 requests per minute per route.
   Audit-logged in each of the user's organizations (`privacy.export_requested`) or as
   `POST /api/privacy/org/export` in the organization.
2. `DataExportWorkflow` (`privacy-export-<request>`) builds one ZIP:
   `README.md` (every source and its outcome), `db/<table>.json`, `files/attachments/...`,
   `files/ai-content/...` and `tools/<tool>.json` for each configured tool that can export.
   Secrets are never exported (password hashes, session tokens, 2FA secrets, key hashes,
   webhook signing secrets). A tool that keeps failing is listed as failed in the README on the
   last attempt rather than blocking the export.
3. The ZIP goes to `S3_BUCKET`, the request becomes `completed`, and the worker mails the
   requester a link to the privacy page. Downloading there mints a presigned URL valid for 5
   minutes, per click, for the signed-in subject only. The ZIP is deleted after
   `PRIVACY_EXPORT_TTL_DAYS` (default 7).

## Deletion

1. Settings, Privacy: "Delete your account" (`POST /api/privacy/user/deletion`) or, for an owner,
   "Delete this organization" (`POST /api/privacy/org/deletion`). Needs a sign-in from the last
   10 minutes (else 403 "sign in again to confirm this request"). A user who is the only owner of
   an organization gets 409 until they hand it over or delete it. One open deletion per subject.
2. The request is `scheduled` for `now + PRIVACY_DELETION_GRACE_DAYS` (default 14; 0 = at once).
   Until then `POST /api/privacy/{user|org}/requests/<id>/cancel` cancels it (audit-logged) and
   nothing is touched.
3. `DataDeletionWorkflow` (`privacy-deletion-<request>`) then runs each step as its own retried,
   idempotent activity and records the outcome in the request's `report`:
   - user: `sessions`, `posthog`, `langfuse`, `chatwoot`, `ga4`, `storage`, `database`;
   - organization: `access` (API keys revoked, invitations withdrawn), `webhooks` (disabled),
     `billing`, `langfuse`, `storage`, `database`.
   The report also lists the tools that hold nothing per person, with the reason. Each entry is
   `{status: done | skipped | not_supported | failed, detail, counts}`; it carries no personal
   data and stays as the audit record.
4. A deleted organization's anonymised row, `ai_calls` and `audit_log` are deleted by the
   retention schedule after `PRIVACY_ORG_RECORDS_DAYS` (default 180).

Billing: there is no billing provider on main yet. The `billing` step
(`PrivacyActivities._billing`) is the extension point: cancel the organization's subscription
there (idempotently) when a provider is added.

## Per-tool support

TOOL_MATRIX

## Retention

The daily Temporal Schedule `privacy-retention` (`PrivacyRetentionWorkflow`, created by the
worker on start; pause or edit it in the Temporal UI) enforces every recorded date:

| What                                 | Recorded in                                        | Enforced by                           | What stays                    |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------- | ----------------------------- |
| AI request/response content          | `ai_calls.content_expires_at` (`AI_CONTENT_RETENTION_DAYS`, 180) | S3 objects deleted                    | the `ai_calls` row (metadata) |
| Data export ZIPs                     | `privacy_requests.expires_at` (`PRIVACY_EXPORT_TTL_DAYS`, 7)     | S3 object deleted, `result_key` cleared | the request row               |
| Deleted organizations' records       | `privacy_requests.expires_at` (`PRIVACY_ORG_RECORDS_DAYS`, 180)  | organization row deleted, cascading to `ai_calls` and `audit_log` | the request row with its report |
| Webhook events and attempts          | `created_at` + `WEBHOOK_RETENTION_DAYS` (30)       | `webhook-maintenance` schedule (ADR 0018) | -                         |

Each run deletes AI content whose expiry passed since the previous successful run (its result is
the watermark), so a call is visited once and a missed day is caught up on the next run.
