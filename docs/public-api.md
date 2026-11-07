# Public API and webhooks

Every app built on this template exposes its API to customers with **organization API keys**
and notifies them with **outbound webhooks**. Design and alternatives:
[ADR 0018](adr/0018-public-api-webhooks.md).

## Authentication

An org admin creates a key in **Settings -> API keys** (or `POST /api/api-keys` with a
session). The full key (`sk_...`) is shown once; only its SHA-256 is stored
([@better-auth/api-key](https://www.better-auth.com/docs/plugins/api-key), organization-owned
keys). The list shows the first characters, scopes, last use and expiry (30/90/365 days or never).
Revoking deletes the key at once. Create and revoke are written to `audit_log`.

```sh
curl -H "Authorization: Bearer $API_KEY" https://app.example.com/api/projects
```

A key acts in the organization that owns it: the request runs in that tenant's RLS transaction
like a session would (ADR 0002), and `audit_log.actor_id` is `apikey:<key id>`.

### Scopes

Each scope maps to the role a signed-in user needs for the same routes, so a key never does
more than an org role could. The UI only offers scopes the creator's role covers.

| Scope             | Same as role | Routes                                                       |
| ----------------- | ------------ | ------------------------------------------------------------ |
| `projects:read`   | member       | `GET /api/projects...`, attachment list and download         |
| `projects:write`  | member       | create/update projects, attachments, AI summary review       |
| `projects:delete` | admin        | `DELETE /api/projects/{id}`                                  |
| `ai_calls:read`   | admin        | `GET /api/orgs/{orgId}/ai-calls...`                          |
| `webhooks:read`   | admin        | `GET /api/webhooks/...` (endpoints, deliveries, event types) |
| `webhooks:write`  | admin        | manage endpoints, rotate secrets, replay deliveries          |

Only routes declared with `access('<scope>')` (`apps/api/src/tenant.ts`) accept keys. They are
marked in `/api/openapi.json` with the `apiKey` security scheme and "API key scope: ..." in the
description. Everything else (key management, auth) is session-only and answers 403 to a key.
Errors: 401 `invalid API key` (unknown, revoked or expired), 403 `API key lacks scope ...`.

Adding a route to the public API: use `...access('<resource>:<action>')` instead of
`requireRole`, add the scope to `SCOPES` in `tenant.ts` with the role it corresponds to, and add
it to the table above.

### Rate limits

`API_KEY_RATE_LIMIT_PER_MINUTE` (default 600) requests per minute **per key**, counted in Redis
by `@fastify/rate-limit` (shared across API replicas, like the auth limits). Over the limit:
`429` with `x-ratelimit-*` and `retry-after` headers.

## Versioning rule

- The public API is what `/api/openapi.json` marks with the `apiKey` scheme, plus the webhook event
  types in `config/webhook-events.json` and their payloads.
- **Additive changes ship without a new version**: new routes, new optional request fields, new
  response fields, new event types, new scopes. Clients must ignore unknown fields and event
  types.
- **Breaking changes need a new major version**: removing or renaming a route, field, scope or
  event type, changing a type or meaning, or making a field required. Add the new route under
  `/api/v2/...` (or a new event type such as `project.created.v2`), keep the old one working for
  at least 6 months, announce the removal date, and bump `info.version` in `app.ts`.

## Webhooks

An org admin adds endpoints in **Settings -> Webhooks** (or `POST /api/webhooks/endpoints`)
and picks event types. The signing secret (`whsec_...`) is shown once, on creation; rotate it to
get a new one.

### Events

The catalog is [`config/webhook-events.json`](../config/webhook-events.json), also served at
`GET /api/webhooks/event-types`:

| Type                       | `data`                                         |
| -------------------------- | ---------------------------------------------- |
| `project.created`          | Project (as `GET /api/projects/{id}` returns)  |
| `project.updated`          | Project                                        |
| `project.deleted`          | `{ "id": "<project id>" }`                     |
| `project.summary_reviewed` | Project (`aiStatus` is confirmed or corrected) |

Body (Standard Webhooks style):

```json
{ "type": "project.created", "timestamp": "2026-11-07T12:00:00.000Z", "data": { "id": "..." } }
```

Adding an event: add it to `config/webhook-events.json` and call
`publishEvent(req, tx, '<type>', data)` inside the `withTenant` transaction of the change.
TypeScript rejects unknown types and `pnpm check:events` fails on a catalogued type nobody
publishes. The event commits with the change; delivery starts after the commit.

### Delivery

- `POST` with `content-type: application/json` and the
  [Standard Webhooks](https://www.standardwebhooks.com/) headers `webhook-id` (the event id, the
  same on every retry and replay: deduplicate on it), `webhook-timestamp` (Unix seconds) and
  `webhook-signature` (`v1,<base64 HMAC-SHA256 of "id.timestamp.body">`).
- Any 2xx is success. Anything else (or a timeout after 10 s) is retried: 8 attempts with x3
  backoff from 30 s, capped at 6 h (about 30 s, 1.5 min, 4.5 min, 13.5 min, 40 min, 2 h, 6 h).
  Redirects are not followed; response bodies are not read.
- Every attempt (status code or error class, duration) is listed per delivery in the UI and at
  `GET /api/webhooks/deliveries/{id}`. **Replay** (`POST .../replay`) sends the same body and
  `webhook-id` again, whatever the delivery's state.
- Each event is one Temporal workflow (`WebhookEventWorkflow`, Python worker), so operators also
  see every delivery in the Temporal UI.

### Verifying a webhook

Use a Standard Webhooks library (`standardwebhooks` on npm and PyPI, or `svix`), with the raw
request body:

```ts
import { Webhook } from 'standardwebhooks';

const wh = new Webhook(process.env.WEBHOOK_SECRET); // whsec_...
// Throws if the signature or timestamp (5 min tolerance) is wrong.
const event = wh.verify(rawBody, {
  'webhook-id': req.headers['webhook-id'],
  'webhook-timestamp': req.headers['webhook-timestamp'],
  'webhook-signature': req.headers['webhook-signature'],
});
```

```python
from standardwebhooks import Webhook

event = Webhook(secret).verify(raw_body, headers)  # raises WebhookVerificationError
```

### Secret rotation

`POST /api/webhooks/endpoints/{id}/rotate-secret` returns a new secret (once). For 24 hours
deliveries carry two signatures (new and previous secret, space-separated), so receivers verify
with either while they switch.

### Secrets at rest

Signing secrets are encrypted with AES-256-GCM before they are stored:
`v1:<key id>:<iv>:<ciphertext+tag>`, bound to the endpoint id, so a row copied to another
endpoint does not decrypt. Keys come from `WEBHOOK_ENCRYPTION_KEYS` (`id:secret,...`, same value
for API and worker, secrets of 32+ characters such as `openssl rand -base64 32`). The API only
encrypts (`apps/api/src/webhook-secret.ts`); only the worker's signing path decrypts
(`worker/webhooks.py`). A row it cannot decrypt fails with `secret_unreadable` and is never sent.

Key rotation: put a new key first (`new:...,old:...`) in both API and worker. New secrets use it
at once; the daily maintenance schedule re-encrypts existing ones. Once a run has finished, remove
the old key.

### Disabled endpoints

The worker disables an endpoint when it answers **410 Gone** (no retries) or after
`WEBHOOK_DISABLE_AFTER_FAILURES` (default 5, 0 = never) failed deliveries in a row. A delivery
counts as failed once its retries are exhausted; a successful one resets the count. Disabling
writes an `audit_log` row (`webhook_endpoint.disabled`, actor `worker`). Settings -> Webhooks
shows a notice with the reason and a **Re-enable** action (`PATCH ... { "enabled": true }`, which
also resets the count). Events published while it is disabled are not queued for it.

### Retention

A Temporal Schedule (`webhook-maintenance`, created by the worker on start, daily) deletes
webhook events (with their deliveries) and attempts older than `WEBHOOK_RETENTION_DAYS` (default
30, 0 = keep), then re-encrypts secrets still under an older key. It is visible, pausable and
triggerable in the Temporal UI; the worker does not overwrite a schedule that already exists.

### Safety limits

- **SSRF**: the worker resolves the host and refuses private, loopback, link-local, CGNAT,
  multicast and other non-global addresses (IPv4-mapped IPv6 included), then connects to the
  checked address (Host header and TLS SNI keep the hostname, the certificate is verified for
  it), so DNS cannot change the target between check and connect. Refused attempts show
  `blocked_address` and are not retried. `WEBHOOK_ALLOWED_CIDRS` (worker) can allow specific
  ranges, e.g. an on-prem receiver; never set it to broad private ranges in a multi-tenant
  deployment.
- **Payload cap**: `WEBHOOK_MAX_PAYLOAD_BYTES` (default 64 KiB, API and worker). Payloads are our
  own DTOs with bounded fields, so `publishEvent()` throws (and the change rolls back) if one
  exceeds it: a bug to fix, not a runtime condition.
- URLs must be `http(s)` without credentials.
