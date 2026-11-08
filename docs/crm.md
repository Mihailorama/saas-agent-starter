# CRM and booking

Every product gets customer records and a way to book a call from day one, in external tools with
their own UI, webhooks and integrations. There are no CRM tables in our database (owner decision
2026-11-07, [ADR 0026](adr/0026-crm-and-booking.md)):

- **CRM: [Twenty](https://twenty.com)** (AGPL-3.0, unmodified container). Install it with the
  `crm` compose profile, or connect a Twenty you already run or Twenty Cloud. People, companies,
  deals and notes live there.
- **Booking: self-hosted [Cal.diy](https://github.com/calcom/cal.diy)** (MIT, the open-source
  successor of Cal.com; owner decision 2026-11-07). Install it with the `booking` profile (image
  built by our CI from a pinned upstream commit), or connect a Cal.diy you already run. Cal.com
  Cloud speaks the same protocol and stays an alternative: only URLs change.
- **Sync: one Temporal workflow per source event** in the Python worker (`worker/crm.py`,
  `CrmSyncWorkflow`); the API only verifies webhooks and starts workflows.

## Data flow

```
 app sign-up ───────────┐  Better Auth hook            (ids)
 organization created ──┤  Better Auth hook            (ids)
 PostHog event ─────────┤  destination -> POST /api/hooks/posthog {signal}   (event uuid, user id)
 Chatwoot conversation ─┤  webhook -> POST /api/hooks/chatwoot               (account, conversation)
 Cal.diy booking ───────┘  webhook -> POST /api/hooks/calcom (signature)     (event id + S3 key)
                           │
                           ▼  startCrmSync(): workflow id crm-<source event id>, REJECT_DUPLICATE
 Stripe/billing webhook -> BillingEventWorkflow ──(state changed)──> child CrmSyncWorkflow
                           │
                           ▼  worker: CrmActivities.sync (reads names/emails from Postgres,
                              Chatwoot or the booking's S3 object, plan and team size from our tables)
                        Twenty REST API
             person (appUserId) ── company (appOrgId) ── deal "Subscription" (appOrgId, stage)
                     └────────── notes (appEventId) ─────────┘   productSignals tag on company
```

Workflow arguments carry ids only. For a booking the API writes the fields the note needs
(trigger, booking uid, title, start, attendee name and email, earlier booking) to S3
(`crm-bookings/<day>/<sha256 of the event id>.json` in `S3_BUCKET`) and passes the key; the
activity reads it, writes the note and deletes the object. Cal.diy's web container has no API to
read a booking back (its API v2 is a separate server), so S3 is the hand-over. Leftovers (a sync
that failed for good, a redelivery after the sync ran) are deleted by the daily privacy retention
after `BOOKING_PAYLOAD_DAYS` (default 7). Nothing else from the webhook (free-text answers,
cancellation reasons) is kept.

## Setup

Every external tool here is either **installed with the template** (a compose profile) or
**connected** (an instance you already run, or the vendor's cloud). The app side is the same env
either way; nothing in the code knows which one it talks to.

1. **Twenty**, one of:
   - **Install** (`crm` profile): `docker compose --profile crm up -d`. It uses our Postgres (role
     and database `twenty`, created by the `twenty-db` one-shot) and our Redis (db 4). The first
     start runs about 580 migration steps: 11 minutes on a loaded 8-core host, ~5 minutes later
     on. Open `http://localhost:3400`, create the workspace and the first user. Worker env:
     `TWENTY_API_URL=http://twenty:3000` (compose network; `http://localhost:3400` for
     `pnpm worker` on the host).
   - **Connect** an existing Twenty (self-hosted v2.x) or [Twenty Cloud](https://twenty.com/pricing):
     no profile. `TWENTY_API_URL` is its base URL (e.g. `https://crm.example.com`; Twenty Cloud:
     the API URL shown next to your key, e.g. `https://api.twenty.com`).
2. **API key**: in Twenty, Settings -> APIs & Webhooks -> create a key with the Admin role (it
   creates custom fields). Set `TWENTY_API_KEY` for the worker and for `pnpm crm:sync`; both use
   only `TWENTY_API_URL` + `TWENTY_API_KEY`, so they work the same against an installed or a
   connected Twenty.
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

| Source                | Workflow id                             | Written to Twenty                                                                  |
| --------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| verified sign-up      | `crm-user:<userId>`                     | person (name, email, `appUserId`); an existing person with that email gets the id  |
| organization created  | `crm-org:<orgId>`                       | company (name, `appOrgId`); the creator joins it if they have no company yet       |
| billing event         | `crm-billing:<provider>:<eventId>`      | the organization's "Subscription" deal moved to `stages[<subscription status>]`    |
| PostHog signal        | `crm-posthog:<event uuid>`              | `productSignals` tag + one note, for each qualifying organization of the user      |
| Chatwoot conversation | `crm-chatwoot:<account>:<conversation>` | note "Support conversation #N" with the conversation link, on the person + company |
| booking change        | `crm-cal:<trigger>:<uid>:<start>`       | note "Booked / Rescheduled / Cancelled: <title>" with the booking link             |

Deal stages (`stages`) map our subscription status, read inside the activity under the
organization's RLS scope: `active` -> `CUSTOMER`, `past_due` -> `PAST_DUE`, `canceled` ->
`CHURNED`; `incomplete` (or no row) leaves the deal alone. `PAST_DUE` and `CHURNED` are not in
Twenty's default stage list (`NEW, SCREENING, MEETING, PROPOSAL, CUSTOMER`); `stageOptions` makes
`crm:sync` add them. Only billing events that changed our subscription state start a sync, and the
sync maps the row as it is when it runs, not the event that started it: a retried child of an older
event (activated, retried after canceled) sets the current stage (`CHURNED`), never an old one. The deal carries no amount: prices live in `config/plans.json` and Stripe; add an
`amount` in `Twenty.deal` if sales wants it.

Product signals (`signals`): PostHog decides "active" (the event fired), our data decides "team on
the free plan": the worker counts members and reads the effective plan of every organization the
user belongs to. The shipped one, `ACTIVE_TEAM_FREE`, fires on `project_created` for organizations
with at least 2 members on `free`. To add one: a new entry (name, label, PostHog event, plans,
minMembers), `pnpm crm:sync`, done. A tagged company gets one note the first time.

Limit: `project_created` is sent by the browser with PostHog's public project key, and there is no
server-side PostHog event to use instead, so the event can be forged: anyone can send it for any
user id. What a forged event can do is bounded by our own data: the worker tags only organizations
that really have the members and plan the signal asks for, once per company. Treat the tag as a
hint for sales, not as a fact; for a signal that must not be spoofable, emit the event from the API
(`POSTHOG_KEY` is already there for flags) and point the destination at that event.

People are matched by `appUserId`, then by email. Our user's person is synced only once their
email is verified (Better Auth's `afterEmailVerification`, or at sign-up when the IdP vouches for
the address): otherwise anyone could sign up with a lead's address and have the CRM hand them that
lead. A user who books a demo and signs up later stays one person; an organization created before
the email was verified gets its creator once they verify. A Chatwoot contact counts as our user
only when the widget's identity hash was verified (`meta.hmac_verified`). Chatwoot and booking
notes otherwise match people by the email the visitor typed, which nobody verified: such a note
can land on the person of whoever owns that address, and an unknown address becomes a new person
(a lead).

## Idempotency and failure

- The workflow id is derived from the source event (`REJECT_DUPLICATE`): a redelivered webhook or
  a second hook call starts nothing.
- Inside the activity every write is check-then-write on a unique custom field; a lost race
  returns Twenty's `400 duplicate entry`, and the activity reads the winner. A crash between a
  note and its targets is repaired on retry (missing targets are added).
- Twenty down: the activity retries with backoff for a few hours (25 attempts, up to 10 minutes
  apart), then the workflow shows as failed in the Temporal UI; restart it there.
- A user or organization row not yet visible to the worker is retried, not dropped.
- Webhook starts are not transactional: if Temporal is down when the booking host or Chatwoot
  calls, the API answers 5xx and the event is lost unless the sender retries (Chatwoot does not).
  Same gap as the support triage (docs/TODO.md, outbox). A booking payload already written to S3
  is then removed by retention.

## Booking

**Default: self-hosted Cal.diy** (owner decision 2026-11-07). On 2026-04-14 Cal.com moved its
product to closed source ([announcement](https://cal.com/blog/cal-com-goes-closed-source-why)) and
relaunched the open-source code as Cal.diy under MIT ([v6.4 changelog](https://cal.com/blog/calcom-v6-4),
[github.com/calcom/cal.diy](https://github.com/calcom/cal.diy)). Upstream publishes no image, so CI
builds one (below). Three ways to run booking, same app code and env:

### Install: the `booking` profile

```sh
infra/caldiy/build.sh caldiy:local                  # ~6 GB RAM, ~15 GB disk, 20-40 minutes
docker compose --profile booking up -d              # Cal.diy on http://localhost:3500
```

- `infra/caldiy/build.sh` builds upstream's own Dockerfile (repository root) at the commit pinned
  in the script, with the build args its README lists (`MAX_OLD_SPACE_SIZE`,
  `CALCOM_TELEMETRY_DISABLED`); no source changes. CI job `caldiy-image` builds the same, scans it
  with Trivy (`infra/caldiy/scan.sh`: fails on fixable critical vulnerabilities; it skips three
  build-only Go binaries in `node_modules`, with the reasons in the script) and boots it on our Postgres; on a `v*`
  tag `release.yml` pushes `ghcr.io/<owner>/<repo>/caldiy:<version>` and deploys pin it by digest
  (`IMAGE_CALDIY`, [docs/deploy.md](deploy.md)). Locally `CALDIY_IMAGE` can point at that image
  instead of building.
- Database: role and database `caldiy` on our Postgres (one-shot `caldiy-db`), so pgBackRest
  covers it. Upstream's start script runs its Prisma migrations on every start. Mail goes to
  Mailpit locally (`CALDIY_SMTP_*` for a real server).
- First start: open `http://localhost:3500`, the setup wizard creates the first user; skip the
  calendar step via `/event-types` if you do not connect one. Create the event type (e.g. `demo`).
- Production values: `CALDIY_PUBLIC_URL` (its own domain, deploy/Caddyfile), `CALDIY_NEXTAUTH_SECRET`
  (`openssl rand -base64 32`), `CALDIY_ENCRYPTION_KEY` (`openssl rand -base64 24`),
  `CALDIY_CRON_API_KEY`, `CALDIY_DATABASE_URL`, `CALDIY_EMAIL_FROM`, `CALDIY_SMTP_*`.
- Bumping Cal.diy: change `REF` in `infra/caldiy/build.sh` to a newer upstream commit; CI rebuilds,
  scans and boots it.

### Connect: a Cal.diy you already run

No profile, no image: set the env below to its URL. Cal.diy has no API key in this setup, the
webhook carries everything the CRM note needs.

### Alternative: Cal.com Cloud

Hosted, closed source, a processor of your attendees' data; free for individuals, team scheduling
(round robin "Talk to sales") needs the paid Teams plan ([pricing](https://cal.com/pricing)). Same
connect path: its URL is `https://app.cal.com`.

### The env (all three)

- **Webhook**: in Cal.diy (or Cal.com), Settings -> Developer -> Webhooks, subscriber URL
  `https://<app domain>/api/hooks/calcom`, triggers Booking Created, Rescheduled, Cancelled, and a
  secret, which goes into the API's `BOOKING_WEBHOOK_SECRET`. The API checks
  `X-Cal-Signature-256` = hex(HMAC-SHA256(secret, raw body)) in constant time; that is Cal.diy's
  scheme (`createWebhookSignature` in `packages/features/webhooks/lib/sendPayload.ts` at the
  pinned commit), unchanged from Cal.com. There is no timestamp in the scheme, so replay
  protection is the per-booking workflow id. Without the secret the endpoint answers 401 (Cal.diy
  then sends `no-secret-provided`, also refused).
- **Links in notes**: the worker's `BOOKING_PUBLIC_URL` (the Cal.diy URL; empty = no links).
- **Entry points**: `VITE_BOOKING_ORIGIN` (the Cal.diy URL) and `VITE_BOOKING_LINK`
  (`<user>/<event type>`, e.g. `acme/demo`), build-time for the web and the site, **and the
  `booking` feature flag** (`config/flags.json`, default off). With all three, the site renders
  "Book a demo" next to "Read the blog" in the hero and the app shows "Talk to us" in the sidebar
  (prefilled with the user's name and email). The app follows the flag per user (PostHog rollout);
  the static site decides at build time (`VITE_FLAGS_ON=booking`, `apps/site/src/flags.ts`). Add
  the origin to `BOOKING_ORIGINS` (CSP `script-src`, `connect-src`, `frame-src` of the web and site
  containers).
- **Consent**: the links are plain links to the booking page (new tab), so nothing from the
  booking host loads on our pages by default. The consent banner gets a "Booking calendar"
  category (only while booking can show: configured and the flag not off for everyone); once the
  visitor allows it (opt-in regime) or has not refused it (opt-out regime), a click opens the
  host's `embed.js` modal instead (`apps/web/src/lib/booking.ts`, shared with the site).
- **Analytics**: `booking_opened` (link clicked, `source` site|app) and `booking_completed` (the
  embed's `bookingSuccessfulV2`) in `config/events.json`, journey `demo-booking`. Bookings made on
  the booking page itself are not seen by the browser; the CRM note from the webhook is the
  complete record.

**Cal.diy's own limits.** Cal.diy has no enterprise code and no license key, but also no Teams,
Organizations, Routing Forms, Workflows, Insights, SAML SSO or API v1
([what was removed](https://cal.com/blog/cal-diy-open-source-to-closed-source)): a "Talk to sales"
round robin across several people is not possible, each person books on their own event type. Its
README says "Use at your own risk" and calls it "strictly recommended for personal,
non-production use"; it is a community fork whose changes do not flow back to Cal.com. Treat it
as a self-hosted tool you patch yourself (the pinned commit, CI's scan), or use Cal.com Cloud where
that is not acceptable.

### Products whose own users book appointments

Not built here; when a product needs it (patients booking a clinic, customers booking a service):

- **Cal.com Platform** ([cal.com/platform](https://cal.com/platform)): API v2 plus "managed users"
  (calendar accounts your backend creates per customer) and the `@calcom/atoms` React components
  (booker, availability settings) embedded in your UI. Closed-source SaaS with its own pricing and
  data processing terms; check the `@calcom/atoms` license against ADR 0005 before adding it.
- **Cal.diy's API v2** on your own host (a separate server, `apps/api/v2` in its repository, not in
  our profile): same idea without managed users at scale; note that Cal.diy stopped publishing
  `@calcom/atoms` (2026-11-03), so the UI is yours to build.
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
key.

Cal.diy (`booking` profile), measured 2026-11-07 in CI (`caldiy-image`, GitHub runner, 4 cores):
708 MiB of its 1 GiB limit one minute after the first request (migrations done, login page served),
Postgres +~10 MiB. Plan ~0.7-1 GiB for the profile; the image build itself needs ~6 GB RAM, which
is why CI builds it.

## Backups

Twenty's database is on our Postgres server, so pgBackRest covers it ([docs/backups.md](backups.md)).
Attachments uploaded in Twenty (`twenty-data` volume, `STORAGE_TYPE=local`) are not covered; set
Twenty's `STORAGE_TYPE=s3` with a bucket listed in `BACKUP_APP_BUCKETS` if they matter. Cal.diy
from the `booking` profile keeps everything in its `caldiy` database on our Postgres server, so it
is covered; a connected Cal.diy is covered only if its database is on that server too. Cal.com
Cloud data is Cal.com's.

## Privacy

Data export and deletion ([docs/privacy.md](privacy.md)) include Twenty: a user's person (by
`appUserId`) and the notes the sync wrote on it; an organization's company and deal (by
`appOrgId`) and their sync notes. Deletion is Twenty's hard delete (destroy). Notes people wrote in
Twenty stay without the link, and leads matched only by a typed email are not found by a user's
deletion. Cal.diy's bookings (attendee name, email, answers) are not reached: delete them in
Cal.diy's UI for now (docs/TODO.md).
