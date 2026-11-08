# 0026. CRM in Twenty, booking on self-hosted Cal.diy, sync as Temporal workflows

Status: accepted (owner decisions, 2026-11-07: Twenty; booking host self-hosted Cal.diy)

## Context

Every product built on the template needs customer records (who signed up, which company, what
they pay, what they asked support, when they booked a call) and a way to book a call, from the
first day. Building CRM tables and a calendar into the app would re-implement two product
categories badly and still lack their UIs, integrations and webhooks. The owner approved Twenty
for the CRM and Cal.com for booking: external open-source tools, no own CRM tables. Cal.com went
closed source on 2026-04-14; the owner then chose its MIT successor Cal.diy, self-hosted, with
Cal.com Cloud as the documented alternative. Every external tool can be installed with the
template (a compose profile) or connected (an existing instance or the vendor cloud) by env alone.

## Decision

- **Twenty (AGPL-3.0, unmodified container) is the CRM**, `crm` compose profile, image
  `twentycrm/twenty:v2.56.1`, server + worker. It reuses our Postgres (own role and database,
  so pgBackRest covers it) and our Redis (db 4; BullMQ needs `noeviction`, Redis' default without
  `maxmemory`). Its LICENSE adds an AGPLv3 section 7 "Application Exception": software that only
  uses its published REST/GraphQL APIs and webhooks is not governed by the AGPL, which is exactly
  how the worker talks to it. Files marked `/* @license Enterprise */` are commercial; nothing we
  use (REST, custom fields, select options) needs them.
- **Booking is a self-hosted Cal.diy** (MIT), `booking` compose profile (also in
  `compose.prod.yaml`), on our Postgres (own role and database, so pgBackRest covers it). Upstream
  publishes no image, so CI builds it from a commit pinned in `infra/caldiy/build.sh` with
  upstream's unmodified Dockerfile, scans it with Trivy, boots it on our Postgres, and `release.yml`
  pushes it by digest next to our images. An existing Cal.diy or Cal.com Cloud is connected by env
  only: they speak the same protocol, the `embed.js` modal and webhooks signed with
  `X-Cal-Signature-256` (hex HMAC-SHA256 of the raw body; Cal.diy `sendPayload.ts`). The entry
  points are behind the `booking` feature flag.
- **Sync is a Temporal workflow per source event** (`CrmSyncWorkflow`, id `crm-<source event id>`,
  `REJECT_DUPLICATE`) in the Python worker. The TS API only starts it: Better Auth hooks for
  email verification (a person is never matched by an unverified address) and organization
  creation, the PostHog hook for product signals, the Chatwoot hook for new conversations, a new
  signed `/api/hooks/calcom`. Billing reuses `BillingEventWorkflow`: when an event changed our
  subscription state it starts the CRM workflow as an abandoned child, which maps the subscription
  row as it is then (not the event type), so a retried older child never moves a deal back and a
  CRM outage never holds billing open (`workflow.patched` keeps in-flight runs replayable).
- **Cross-links live in the CRM**, not in our database: unique custom fields `appUserId`
  (person), `appOrgId` (company, deal) and `appEventId` (note). They are the lookup keys and the
  idempotency keys; a lost race is Twenty's own `400 duplicate entry`. `pnpm crm:sync` creates them,
  the extra deal stages and the PostHog signal destinations, from `config/crm.json`.
- **One small `Crm` protocol** (six methods) between the activity and Twenty, so another CRM is one
  class. It mirrors the tracker adapters of the service desk (ADR 0013).
- **Product signals are judged by both sides**: PostHog says the user is active (a destination on an
  event, like the journey alerts), our tables say whether the team qualifies (member count,
  effective plan). The company gets a `productSignals` tag and one note.
- **Consent before the embed**: booking entry points are plain links to the Cal.com page; the
  embed script loads only after the visitor allows the new "Booking calendar" consent category.
- Everything is env-driven: no `TWENTY_API_*` = dry run (the worker logs), no
  `BOOKING_WEBHOOK_SECRET` = 401, no `VITE_BOOKING_ORIGIN`/`LINK` or flag off = no entry points.
- Data-subject rights reach Twenty (export; hard delete of the person, company, deal and the
  sync's notes). Cal.diy's own bookings are not reached yet (docs/TODO.md).

Picks that are not obvious, one line each:

- REST over GraphQL for Twenty: one URL per object, filter syntax in a query parameter, the same
  calls a human can try with curl; GraphQL introspection is disabled on Twenty's server anyway.
- Custom fields instead of matching by name or email only: emails change and company names repeat;
  a unique field also makes a retried create fail loudly instead of duplicating.
- No deal amount: prices are in `config/plans.json` and Stripe; one source of truth until sales asks.
- The booking webhook's fields go to S3, the workflow gets the key (ids only in Temporal):
  reading the booking back would need Cal.diy's separate API v2 server (or a Cal.com key), just to
  learn what the signed webhook already said. The worker deletes the object after the note,
  retention deletes leftovers. Free-text answers are dropped at the API.

## Alternatives

- Own CRM tables or an "activities" table: rejected by the owner.
- EspoCRM (AGPL-3.0, PHP) and SuiteCRM (AGPL-3.0): older stacks and UIs; Twenty is the most active
  open-source CRM with a modern API (60k GitHub stars, releases every few days in 2026).
- Krayin (MIT, Laravel) and Atomic CRM (MIT, React + Supabase): permissive, not checked in depth;
  candidates for the permissive twin, which currently just disables Twenty.
- HubSpot / Pipedrive (SaaS): fine for many clients; they fit behind the same `Crm` protocol.
- Twenty's own workflow automation or webhooks to pull from us: puts our business events' logic
  in a CRM-specific tool and needs it to reach our database.
- Cal.com's last AGPL image (`calcom/cal.com:v6.2.0`, 2026-03-02) in compose: unmaintained since
  the source was closed; shipping a calendar that handles customer data without security fixes is
  worse than no container.
- Cal.com Cloud as the default (the first draft of this ADR): nothing to run, team scheduling on
  the paid plan, but attendee data leaves for a US SaaS. The owner chose self-hosting; Cloud stays
  a connect option.
- A third-party Cal.diy image (e.g. community builds on Docker Hub): another party's build of a
  calendar that holds customer data; building upstream's Dockerfile ourselves is the same work in
  CI and keeps the supply chain to upstream + us.

## Consequences

- New infra container `twentycrm/twenty` (AGPL-3.0 + Application Exception), listed in
  docs/LICENSES.md, disabled by the permissive twin, covered by `pnpm sbom`. New image `caldiy`
  (MIT, built by us from upstream, listed there too; permissive, so no twin needed). No new code
  dependency: the worker uses `httpx2`, the web loads the booking host's `embed.js` by URL.
- RAM: ~1.45 GiB for the profile (server ~650-750 MiB, worker ~700-790 MiB), more than twice the
  default stack (docs/STACK.md); first start ~11 minutes on a loaded host. On a small server, run
  it on another host or use Twenty Cloud.
- We own Cal.diy's image: a Next.js monorepo build (6 GB heap, 20-40 minutes in CI on every
  run) and its patch cadence (bump the pinned commit, CI rescans). Cal.diy has no team
  scheduling and its README calls it "strictly recommended for personal, non-production use";
  where that is not acceptable, connect Cal.com Cloud instead.
- PII stays in our stack by default (Twenty and Cal.diy self-hosted); it leaves only when a
  deployment connects Twenty Cloud or Cal.com Cloud.
- Webhook starts are not transactional (same gap as ADR 0013): an event that arrives while
  Temporal is down is lost unless the sender retries.
