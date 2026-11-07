# CRM and booking

Every product gets customer records and a way to book a call from day one, in external tools with
their own UI, webhooks and integrations. There are no CRM tables in our database (owner decision
2026-11-07, [ADR 0026](adr/0026-crm-and-booking.md)):

- **CRM: [Twenty](https://twenty.com)** (AGPL-3.0, unmodified container, `crm` compose profile).
  People, companies, deals and notes live there.
- **Booking: Cal.com's protocol** (embed + signed webhooks), served by **Cal.com Cloud** by
  default or a self-hosted **Cal.diy**. See [Booking](#booking) for why there is no booking
  container: Cal.com went closed source in April 2026.
- **Sync: one Temporal workflow per source event** in the Python worker (`worker/crm.py`,
  `CrmSyncWorkflow`); the API only verifies webhooks and starts workflows.

## Data flow

```
 app sign-up ───────────┐  Better Auth hook            (ids)
 organization created ──┤  Better Auth hook            (ids)
 PostHog event ─────────┤  destination -> POST /api/hooks/posthog {signal}   (event uuid, user id)
 Chatwoot conversation ─┤  webhook -> POST /api/hooks/chatwoot               (account, conversation)
 Cal.com booking ───────┘  webhook -> POST /api/hooks/calcom (signature)     (booking + attendee)
                           │
                           ▼  startCrmSync(): workflow id crm-<source event id>, REJECT_DUPLICATE
 Stripe/billing webhook -> BillingEventWorkflow ──(state changed)──> child CrmSyncWorkflow
                           │
                           ▼  worker: CrmActivities.sync (reads names/emails from Postgres or
                              Chatwoot, plan and team size from our tables)
                        Twenty REST API
             person (appUserId) ── company (appOrgId) ── deal "Subscription" (appOrgId, stage)
                     └────────── notes (appEventId) ─────────┘   productSignals tag on company
```

Workflow arguments carry ids only, except bookings: Cal.com has no API on every tier we support,
so the API passes the attendee's name and email with the event (as `SendEmail` passes a
recipient). Nothing else from the webhook (free-text answers, cancellation reasons) is kept.

## Setup

1. **Start Twenty**: `docker compose --profile crm up -d`. It uses our Postgres (role and
   database `twenty`, created by the `twenty-db` one-shot) and our Redis (db 4). The first start
   runs about 580 migration steps: 11 minutes on a loaded 8-core host, ~5 minutes later on.
   Open `http://localhost:3400`, create the workspace and the first user.
2. **API key**: in Twenty, Settings -> APIs & Webhooks -> create a key with the Admin role (it
   creates custom fields). Set the worker env: `TWENTY_API_URL=http://twenty:3000` (compose
   network; `http://localhost:3400` for `pnpm worker` on the host) and `TWENTY_API_KEY`.
3. **Fields, stages, signals**: `pnpm crm:sync` (env as above on the machine you run it from;
   `--dry-run` prints the plan). It creates the custom fields below, adds the extra deal stages
   and creates one PostHog webhook destination per product signal (needs the `journeys:sync`
   PostHog env plus `PUBLIC_API_URL` and `POSTHOG_WEBHOOK_SECRET`). It only adds what is missing.
4. **Chatwoot** (optional, [docs/support.md](support.md)): tick `conversation_created` in the
   existing account webhook; the worker needs `CHATWOOT_URL` and `CHATWOOT_API_TOKEN` to read the
   contact.
5. **Booking**: see [Booking](#booking).
6. Restart the worker: its start line says `crm twenty` (or `crm dry run`).

Without `TWENTY_API_URL`/`TWENTY_API_KEY` every sync is a **dry run**: the workflow runs and the
worker logs `dry run: ... user.created user:<id>`, nothing is sent. The API always starts the
workflows (they are cheap); a Temporal outage never blocks a sign-up (the start error goes to
Sentry).

## Mapping

Custom fields (created by `pnpm crm:sync`, all unique, labelled "Set by the app sync"):

| Twenty object | Field                           | Holds                                 | Used for                                |
| ------------- | ------------------------------- | ------------------------------------- | --------------------------------------- |
| person        | `appUserId`                     | our user id                           | finding the person on later events      |
| company       | `appOrgId`                      | our organization id                   | finding the company                     |
| company       | `productSignals` (multi-select) | signal names from `config/crm.json`   | sales views: "Active team on free plan" |
| opportunity   | `appOrgId`                      | our organization id                   | one subscription deal per organization  |
| note          | `appEventId`                    | source event id (`user:`, `cal:` ...) | idempotency: one note per source event  |

Source events (`config/crm.json` holds the configurable parts):

| Source                 | Workflow id                             | Written to Twenty                                                                  |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| sign-up                | `crm-user:<userId>`                     | person (name, email, `appUserId`); an existing person with that email gets the id  |
| organization created   | `crm-org:<orgId>`                       | company (name, `appOrgId`); the creator joins it if they have no company yet       |
| billing event          | `crm-billing:<provider>:<eventId>`      | the organization's "Subscription" deal moved to `stages[<event type>]`             |
| PostHog signal         | `crm-posthog:<event uuid>`              | `productSignals` tag + one note, for each qualifying organization of the user      |
| Chatwoot conversation  | `crm-chatwoot:<account>:<conversation>` | note "Support conversation #N" with the conversation link, on the person + company |
| Cal.com booking change | `crm-cal:<trigger>:<uid>:<start>`       | note "Booked / Rescheduled / Cancelled: <title>" with the booking link             |

Deal stages (`stages`): `subscription.activated` and `subscription.renewed` -> `CUSTOMER`,
`subscription.past_due` -> `PAST_DUE`, `subscription.canceled` -> `CHURNED`; `payment.*` events
leave the deal alone. `PAST_DUE` and `CHURNED` are not in Twenty's default stage list
(`NEW, SCREENING, MEETING, PROPOSAL, CUSTOMER`); `stageOptions` makes `crm:sync` add them. Only
events that changed our own subscription state reach the CRM, so a late, older webhook cannot move
a deal back. The deal carries no amount: prices live in `config/plans.json` and Stripe; add an
`amount` in `Twenty.deal` if sales wants it.

Product signals (`signals`): PostHog decides "active" (the event fired), our data decides "team on
the free plan": the worker counts members and reads the effective plan of every organization the
user belongs to. The shipped one, `ACTIVE_TEAM_FREE`, fires on `project_created` for organizations
with at least 2 members on `free`. To add one: a new entry (name, label, PostHog event, plans,
minMembers), `pnpm crm:sync`, done. A tagged company gets one note the first time.

People are matched by `appUserId`, then by email. A Chatwoot contact counts as our user only when
the widget's identity hash was verified (`meta.hmac_verified`); otherwise the email is used, as for
Cal.com attendees, and an unknown email becomes a new person (a lead). A user who books a demo and
signs up later stays one person.

## Idempotency and failure

- The workflow id is derived from the source event (`REJECT_DUPLICATE`): a redelivered webhook or
  a second hook call starts nothing.
- Inside the activity every write is check-then-write on a unique custom field; a lost race
  returns Twenty's `400 duplicate entry`, and the activity reads the winner. A crash between a
  note and its targets is repaired on retry (missing targets are added).
- Twenty down: the activity retries with backoff for a few hours (25 attempts, up to 10 minutes
  apart), then the workflow shows as failed in the Temporal UI; restart it there.
- A user or organization row not yet visible to the worker is retried, not dropped.
- Webhook starts are not transactional: if Temporal is down when Cal.com or Chatwoot calls, that
  event is lost (Cal.com Cloud retries on 5xx, Chatwoot does not). Same gap as the support triage
  (docs/TODO.md, outbox).

## Booking

**What happened to Cal.com** (checked 2026-11-07): on 2026-04-14 Cal.com moved its product to
closed source ([announcement](https://cal.com/blog/cal-com-goes-closed-source-why)) and relaunched
the open-source code as **Cal.diy** under MIT ([v6.4 changelog](https://cal.com/blog/calcom-v6-4),
[github.com/calcom/cal.diy](https://github.com/calcom/cal.diy)). Cal.diy has no enterprise code and
no license key, but also no Teams, Organizations, Routing Forms, Workflows, Insights, SAML SSO or
API v1 ([what was removed](https://cal.com/blog/cal-diy-open-source-to-closed-source)); its README
calls it "strictly recommended for personal, non-production use" and it is maintained by former
Cal.com interns. Docker Hub has no `calcom/cal.diy` tags; the last `calcom/cal.com` image is
v6.2.0 (2026-03-02), AGPL, and gets no fixes any more. So:

- **Default: Cal.com Cloud** (hosted, closed source, a processor of your attendees' data). Free
  for individuals; team scheduling (round robin "Talk to sales") needs the paid Teams plan
  ([pricing](https://cal.com/pricing)). Nothing to run.
- **Self-hosted: Cal.diy**, built from its repository on a separate host with its own
  `docker-compose.yml` (the build needs a 6 GB Node heap; it is a Next.js monorepo). Personal event
  types only. Point it at our Postgres server if you want it in the backups (below). Not in our
  compose: an image we would have to build and patch ourselves is not an "unmodified container".

Both speak the same protocol, so the code does not change:

- **Webhook**: Cal.com -> Settings -> Developer -> Webhooks, subscriber URL
  `https://<app domain>/api/hooks/calcom`, triggers Booking Created, Rescheduled, Cancelled, and a
  secret, which goes into the API's `CALCOM_WEBHOOK_SECRET`. The API checks
  `X-Cal-Signature-256` = hex(HMAC-SHA256(secret, raw body)) in constant time; there is no
  timestamp in the scheme, so replay protection is the per-booking workflow id. Without the
  secret the endpoint answers 401 (Cal.com then sends `no-secret-provided`, also refused).
- **Links in notes**: the worker's `CALCOM_PUBLIC_URL` (default `https://app.cal.com`).
- **Entry points**: `VITE_CALCOM_LINK` (`<user>/<event type>`, e.g. `acme/demo`) and, for Cal.diy,
  `VITE_CALCOM_ORIGIN`. With them set, the site renders "Book a demo" in the hero and the app shows
  "Talk to us" in the sidebar (prefilled with the user's name and email). Add the origin to
  `BOOKING_ORIGINS` (CSP `script-src`, `connect-src`, `frame-src` of the web and site
  containers), e.g. `BOOKING_ORIGINS=https://app.cal.com`.
- **Consent**: the links are plain links to the Cal.com page (new tab), so nothing from Cal.com
  loads on our pages by default. The consent banner gets a "Booking calendar" category; once the
  visitor allows it (opt-in regime) or has not refused it (opt-out regime), a click opens Cal.com's
  `embed.js` modal instead (`apps/web/src/lib/booking.ts`, shared with the site).
- **Analytics**: `booking_opened` (link clicked, `source` site|app) and `booking_completed` (the
  embed's `bookingSuccessfulV2`) in `config/events.json`, journey `demo-booking`. Bookings made on
  the Cal.com page itself are not seen by the browser; the CRM note from the webhook is the
  complete record.

### Products whose own users book appointments

Not built here; when a product needs it (patients booking a clinic, customers booking a service):

- **Cal.com Platform** ([cal.com/platform](https://cal.com/platform)): API v2 plus "managed users"
  (calendar accounts your backend creates per customer) and the `@calcom/atoms` React components
  (booker, availability settings) embedded in your UI. Closed-source SaaS with its own pricing and
  data processing terms; check the `@calcom/atoms` license against ADR 0005 before adding it.
- **Cal.diy's API v2** on your own host: same idea without managed users at scale; note that
  Cal.diy stopped publishing `@calcom/atoms` (Nov 2026), so the UI is yours to build.
- Either way the integration shape stays: their webhook -> a signed route -> a workflow, never a
  bookings table of our own unless the product's domain needs it.

## Swapping the CRM

The activity talks to the CRM only through the `Crm` protocol in `worker/crm.py`: `person`,
`company`, `join`, `deal`, `add_signal`, `note`. For HubSpot, Pipedrive, Odoo or a CRM a client
already runs, write one class with those six methods (store our ids in that CRM's custom
properties, key notes by the source event id), construct it in `worker/__main__.py` instead of
`Twenty`, and adapt `scripts/crm.mjs` (or create the fields by hand). The API, the workflows, the
webhooks and the tests' scenarios stay; the fake in `tests/test_crm.py` shows the HTTP contract the
Twenty class expects.

## Resources

Measured 2026-11-07 on the shared 8-core host (load ~20), Twenty v2.56.1 on our Postgres and Redis
(docs/STACK.md): server 650 MiB and worker 792 MiB idle (4 minutes after start, no traffic), 750 +
702 MiB after a smoke test (workspace, API key, custom fields, people, companies, deal, notes);
Postgres grew ~50 MiB, Redis ~10 MiB. **About 1.45 GiB for the profile, more than twice the default
app stack** (~0.6 GiB). Twenty's own minimum is 2 GB RAM. On a small server run it on a separate
host or use [Twenty Cloud](https://twenty.com/pricing); the sync only needs `TWENTY_API_URL` and a
key. Cal.diy was not measured: there is no image to run (see Booking).

## Backups

Twenty's database is on our Postgres server, so pgBackRest covers it ([docs/backups.md](backups.md)).
Attachments uploaded in Twenty (`twenty-data` volume, `STORAGE_TYPE=local`) are not covered; set
Twenty's `STORAGE_TYPE=s3` with a bucket listed in `BACKUP_APP_BUCKETS` if they matter. Cal.com
Cloud data is Cal.com's; a self-hosted Cal.diy is covered only if its database is on our Postgres
server.
