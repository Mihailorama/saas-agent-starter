# 0018. Public API keys and outbound webhooks

Status: accepted (owner decision, 2026-11-07: every app gets a public API with customer keys and
outbound webhooks; prefer established tools with UI over home-grown logs)

## Context

Customers need to call the API from scripts and other services, and to be notified of changes
without polling. Both are security-sensitive (credentials, requests to customer-chosen URLs)
and easy to get subtly wrong. Usage: [docs/public-api.md](../public-api.md).

## Decision

### API keys: Better Auth API key plugin, organization-owned

- `@better-auth/api-key` (MIT, same release line as `better-auth` 1.7) with
  `references: 'organization'`: keys belong to the org, not to the admin who made them, and
  survive that person leaving. It generates, hashes (SHA-256; keys are 64 random characters,
  so a slow hash adds nothing), expires and verifies keys and records the last use. It is the
  library we already use for auth, on our Postgres through the Drizzle adapter (`apikey` table).
- The plugin needs `apiKey` permissions in the organization plugin's access control for
  non-owner roles ([docs](https://www.better-auth.com/docs/plugins/api-key/advanced#access-control--permissions)):
  `apps/api/src/access.ts` keeps Better Auth's default roles and adds `apiKey` for owner/admin.
- Scopes are the plugin's `permissions` (`projects: ['read']`), each mapped to the role a
  session needs for the same routes (`SCOPES` in `tenant.ts`). One helper, `access(scope)`,
  gives a route both checks; the key's org becomes the tenant, so RLS and audit work unchanged.
- Keys are created and revoked only through `/api/api-keys` (session, org admin): it sets
  scopes (server-only in the plugin) and writes `audit_log`. The plugin's own
  `/api/auth/api-key/*` HTTP endpoints are closed. A key can never manage keys.
- Rate limits stay in `@fastify/rate-limit` + Redis, per key; the plugin's per-row counter is
  off (one store for all limits, shared across replicas).

### Webhooks: Temporal workflow per event, not self-hosted Svix

Svix was evaluated first. Its server ([svix/svix-webhooks](https://github.com/svix/svix-webhooks))
is MIT, needs PostgreSQL and optionally Redis 6.2+, and covers sending, signing, retries,
attempt logs and resend through its API. But
[its docs](https://docs.svix.com/app-portal/oss) say: "The Consumer Application Portal is
currently only included in the hosted version of Svix and not in the open source version"
(checked 2026-11-07; the request to open-source it,
[svix-webhooks#2026](https://github.com/svix/svix-webhooks/issues/2026), is still open).
**Without the portal we would build the same customer UI anyway, on top of a second service and
datastore, so delivery runs on Temporal, which the stack already has.**

- `publishEvent(req, tx, type, data)` (`apps/api/src/events.ts`) is the single path: inside
  the tenant transaction it stores the event body and one delivery row per subscribed, enabled
  endpoint; `withTenant` starts `WebhookEventWorkflow` after the commit (workflow id
  `webhook-event-<eventId>`, duplicates rejected). Event types live in
  `config/webhook-events.json`, checked by TypeScript and `pnpm check:events`.
- The workflow runs in the Python worker (the only Temporal worker; a TS worker would fail the
  license gate and has no musl build). One activity run = one HTTP attempt, recorded in
  `webhook_attempts`; Temporal retries with backoff (8 attempts, x3 from 30 s, cap 6 h).
  Operators see every delivery in the Temporal UI; customers see attempts in Settings ->
  Webhooks, where they can replay.
- Signing per [Standard Webhooks](https://www.standardwebhooks.com/) (HMAC-SHA256, `whsec_`
  secrets, `webhook-*` headers), 15 lines of stdlib code; tests verify it with the reference
  library (`standardwebhooks`, MIT, dev dependency). Rotation keeps the previous secret signing
  for 24 h.
- Secrets at rest: AES-256-GCM (`v1:<key id>:...`, endpoint id as additional data) with keys
  from `WEBHOOK_ENCRYPTION_KEYS`; the API only encrypts and shows a secret once, the worker's
  signing path alone decrypts. The worker needs AES, which the standard library lacks:
  `cryptography` (Apache-2.0 OR BSD-3-Clause), the reference Python crypto library. The key id
  makes key rotation possible; the daily schedule re-encrypts rows under older keys.
- Endpoints are disabled on 410 or after `WEBHOOK_DISABLE_AFTER_FAILURES` failed deliveries in
  a row (audit-logged, notice and re-enable in the UI). Retention runs as a Temporal Schedule in
  the worker (`webhook-maintenance`, daily, `WEBHOOK_RETENTION_DAYS`), so it is visible and
  pausable in the Temporal UI rather than a cron we would have to monitor.
- SSRF: resolve, refuse non-global addresses, connect to the checked IP with Host/SNI set to
  the hostname, no redirects, no proxy from the environment, response body never read. Payload
  cap in the API and the worker.

## Alternatives

- **Self-hosted Svix** (MIT): rejected above for now. Revisit when the app portal ships in the
  open-source server: `publishEvent()` stays, only the delivery side changes (create a Svix
  message instead of starting the workflow), and the endpoint/delivery UI becomes the portal.
- **Hosted Svix or another webhooks SaaS**: adds a vendor and sends customer data to a third
  party, which on-prem deliveries cannot do. Fine for a SaaS-only product; same switch point as
  above.
- **Own API key table**: re-implements hashing, expiry and verification the auth library
  already ships.
- **Unkey** (self-hostable key service): another service to run for what a library does here.

## Consequences

- The API cannot show a secret again (it cannot decrypt): customers copy it on creation or
  rotate. Losing `WEBHOOK_ENCRYPTION_KEYS` means every endpoint must rotate its secret.
- Like project workflows, a delivery whose workflow start fails (Temporal down at that instant)
  stays `pending` until replayed; the transactional outbox in docs/TODO.md covers both.
- Migrations: `apikey` (auth table, not tenant-scoped, like the other Better Auth tables) and
  four tenant tables with the standard RLS policy.
