# Service desk (Chatwoot)

Users ask questions, report problems and suggest improvements in one place: the **Help** menu in
the app, plus email and Telegram. Tickets live in [Chatwoot](https://github.com/chatwoot/chatwoot)
(MIT core, self-hosted), backlog items live in the tracker (GitHub Issues by default, Plane
Intake optionally). This repo keeps no ticket table, event journal or link table. The link
between a conversation and an issue lives in the two tools themselves: the conversation URL is
written into the issue (body or "+1" comment), and the issue URL into the conversation's
`tracker_issue_url` custom attribute. Decision record:
[ADR 0013](adr/0013-service-desk-chatwoot.md).

## Flow

```
Help menu (web) ─┐
email inbox ─────┼─> Chatwoot conversation ──webhook──> POST /api/hooks/chatwoot
Telegram bot ────┘                                       (signature checked)
                                                         └─> Temporal SupportTriageWorkflow
                                                             (id support-triage-<acct>-<conv>)
worker: read messages from Chatwoot -> classify (LLM gateway, audited) ->
  bug / feature_request: search open tracker items -> duplicate? "+1 user" comment : new item
  question: draft answer;  billing: hand to a human;  spam: flag
  -> one private note in the conversation (+ custom attributes). Never a reply to the customer.

tracker item closed ──webhook──> POST /api/hooks/{github,plane} -> SupportIssueClosedWorkflow
  -> private note in every linked conversation (+ optional customer message)
```

| Piece                  | Where                                                          |
| ---------------------- | -------------------------------------------------------------- |
| Help menu + widget     | `apps/web/src/lib/support.ts`, `HelpMenu` in `pages/shell.tsx` |
| Widget identity (HMAC) | `GET /api/support/identity` (`apps/api/src/routes/support.ts`) |
| Webhook receivers      | `POST /api/hooks/chatwoot`, `/github`, `/plane` (same file)    |
| Triage + return path   | `services/worker-py/worker/support.py`, `workflows.py`         |
| Prompts (versioned)    | `prompts/support.triage/system.v1.md`, `duplicate.v1.md`       |
| Containers             | `docker compose --profile support` (`docker-compose.yml`)      |

## Run it

```sh
docker compose --profile support up -d      # chatwoot (UI :3200), chatwoot-sidekiq
```

- Image `chatwoot/chatwoot:v4.19.1-ce`: the community build, made by Chatwoot's CI after
  `rm -rf enterprise`. Never use the tag without `-ce` (it contains `enterprise/`,
  docs/LICENSES.md).
- `chatwoot-prepare` (one-shot) runs `rails db:chatwoot_prepare` (creates or migrates the schema),
  then `chatwoot` (Rails, port `CHATWOOT_PORT`) and `chatwoot-sidekiq` (jobs) start.
- Database: its own `chatwoot-postgres` (`pgvector/pgvector:0.8.7-pg16`, the version Chatwoot's
  own compose uses). Not the stack's Postgres: Chatwoot's schema enables the `vector` extension,
  which `postgres:17-alpine` does not have; swapping the stack's image for pgvector would change
  the app database for every user of the template.
- Redis: the stack's `redis`, database 2 (GlitchTip uses 1, rate limits 0). Its default
  `noeviction` policy is what Sidekiq needs. With `compose.permissive.yaml` it is Valkey 9 (same
  protocol), measured below.
- Outbound calls: `DISABLE_TELEMETRY=true` (no instance metrics) and
  `ENABLE_PUSH_RELAY_SERVER=false` (no mobile push relay). Chatwoot still checks
  `hub.2.chatwoot.com` for new versions; block it at the firewall where nothing may leave.
- `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true`: Chatwoot blocks webhooks to private addresses by
  default, and the API is `http://api:3000` on the compose network. Turn it off when the API has
  a public URL.
- Production: set `CHATWOOT_SECRET_KEY_BASE` (`openssl rand -hex 64`), `CHATWOOT_FRONTEND_URL`
  (its public HTTPS URL; Telegram and email need it) and the SMTP variables. Put it behind the
  same reverse proxy as the app.

## Set up Chatwoot (UI, once)

1. Open `http://localhost:3200`, create the admin account and the first account (sign-up is
   otherwise off: `ENABLE_ACCOUNT_SIGNUP=false`). Invite agents under Settings -> Agents.
2. **Website inbox** (Settings -> Inboxes -> Website): any name, your app's domain. Copy the
   **website token** to `VITE_CHATWOOT_WEBSITE_TOKEN`. Under Configuration, turn on **Enforce
   user identity validation** and copy the **HMAC token** to `CHATWOOT_HMAC_TOKEN` (API).
3. **Webhook** (Settings -> Integrations -> Webhooks): URL `http://api:3000/api/hooks/chatwoot`
   (or the public API URL), event **Message created**. Copy its secret (shown in the webhook's
   edit form, or `GET /api/v1/accounts/{id}/webhooks`) to `CHATWOOT_WEBHOOK_SECRET` (API).
4. **Bot user**: invite an agent such as `triage-bot@example.com`, add it to every inbox, sign
   in as it and copy Profile settings -> Access token to `CHATWOOT_API_TOKEN` (worker). Notes it
   writes show under that name.
5. **Custom attributes** (Settings -> Custom attributes), so agents see them in the sidebar:
   conversation and contact `request_kind`, `org_id`, `page`, `replay_url`, `trace_id` (text or
   link), conversation `support_category`, `tracker_issue_url` (link). The API stores them either
   way; the definitions only control display.

### Channels

All channels end in the same conversations, so triage covers them all (it reacts to the first
incoming message of a conversation, whatever the inbox).

- **Website widget**: the Help menu (above). The widget script loads only when a user opens
  Help, so no browser talks to Chatwoot before the user asks. Its cookies are needed for the
  conversation the user started, which is why it is not behind the analytics consent banner.
- **Email**: Settings -> Inboxes -> Email. Either forward your support address to the inbox's
  forwarding address (needs inbound email configured on the server, `MAILER_INBOUND_EMAIL_DOMAIN`
  and a `RAILS_INBOUND_EMAIL_SERVICE`, see Chatwoot's docs), or connect the mailbox over IMAP/SMTP
  (Gmail / Microsoft 365 via OAuth, others with a password). Outgoing notifications use the
  `CHATWOOT_SMTP_*` variables.
- **Telegram**: create a bot with [@BotFather](https://t.me/BotFather), then Settings ->
  Inboxes -> Telegram and paste the bot token. Chatwoot registers the bot's webhook at
  `CHATWOOT_FRONTEND_URL`, so it must be reachable over public HTTPS.
- **API inbox**: for any other source you build later (see docs/TODO.md: social mentions).

### Web app

```sh
VITE_CHATWOOT_BASE_URL=http://localhost:3200   # build-time: where sdk.js and the widget come from
VITE_CHATWOOT_WEBSITE_TOKEN=...                # website inbox token
SUPPORT_ORIGINS=http://localhost:3200          # web container: CSP script/frame/connect/img-src
CHATWOOT_HMAC_TOKEN=...                        # API: signs the user's identifier
```

With the two `VITE_` variables empty there is no Help entry and no request to Chatwoot (the
Playwright smoke test checks both). When a signed-in user opens Help the web app:

- calls `GET /api/support/identity`, which returns the user id as `identifier` and
  `identifierHash = hex(HMAC-SHA256(CHATWOOT_HMAC_TOKEN, identifier))`, plus name and email, and
  passes them to `$chatwoot.setUser`. With identity validation enforced, Chatwoot rejects any
  other hash, so nobody can write as another user;
- sets custom attributes on the contact and, once one exists, the conversation:
  `request_kind` (`question` / `bug` / `feature_request`, the menu item), `org_id` (active
  organization), `page` (path, no query string), `replay_url` (PostHog
  `get_session_replay_url({ withTimestamp: true })`, when PostHog is loaded) and `trace_id` (the
  latest `x-trace-id` the API returned). The starter has no plan/tier or region field; add them
  to the `attrs` object in `support.ts` when your product has them;
- tracks `support_opened` (`kind`) in the analytics catalog;
- on sign-out calls `$chatwoot.reset()`.

The Help menu replaces the PostHog "Report a problem" feedback tab: with the `VITE_CHATWOOT_*`
variables set, `pnpm journeys:sync` no longer creates that survey or its webhook (stop an existing
one in PostHog). Thumbs on AI answers and the PostHog AI-feedback survey are unchanged.

## Triage

`POST /api/hooks/chatwoot` checks `X-Chatwoot-Signature` (`sha256=` + hex HMAC-SHA256 of
`<X-Chatwoot-Timestamp>.<raw body>` with the webhook secret, timestamp within 5 minutes, constant
time compare; no secret configured = 401). A `message_created` event with `message_type:
incoming` that is not private starts `SupportTriageWorkflow` with id
`support-triage-<account>-<conversation>` and `REJECT_DUPLICATE`: one triage per conversation,
later messages are no-ops. Workflow arguments are the two ids; the worker reads the text from
Chatwoot, so no message content is in Temporal's history.

The worker activity (`support_triage`, 3 attempts):

1. Reads the conversation and its customer messages (incoming, not private) from Chatwoot.
2. Classifies it with one LLM call through `Gateway.call_llm`: purpose `support.triage`,
   prompt `support.triage/system` v1, model from `AI_SUPPORT_TRIAGE_PROVIDER` /
   `AI_SUPPORT_TRIAGE_MODEL` (no default: unset = triage off). The answer is JSON:
   `category` (`question`, `bug`, `feature_request`, `billing`, `spam`), an English `title` and
   `summary` without personal data, search keywords, and a draft `answer` for questions.
3. `bug` / `feature_request`: searches open tracker items with the keywords; if there are hits, a
   second call (`support.triage/duplicate` v1) picks the duplicate or none. Duplicate: a comment
   `+1 user: <summary>` with the conversation link. Otherwise a new item: title, summary,
   category, conversation link and the widget context (page, org, replay, trace id).
4. Writes **one private note**: category, summary, and the issue link, or the draft answer
   ("review before sending, not sent"), or "needs a human" (billing) / "looks like spam". It
   sets `support_category` and `tracker_issue_url`. It never sends anything to the customer.

The AI calls are audited like every other one (ADR 0008): an `ai_calls` row with purpose,
model, prompt id and version, tokens, cost, trace id, `actor_id = chatwoot:<account>/<conversation>`,
content in S3 only. They are recorded under `SUPPORT_AI_ORG_ID`, the operator's own
organization: support conversations belong to the operator, not to a tenant, and email or
Telegram conversations have no tenant at all. That org's admins see them on the AI calls page.
Without `SUPPORT_AI_ORG_ID`, triage is off.

System card: [docs/ai/support.triage.md](ai/support.triage.md). Prompts follow the repo's prompt convention: files `prompts/<purpose>/<name>.v<N>.md`, pinned by
hash in `prompts/lock.json`; a changed prompt is a new version file plus a bumped version in
`worker/support.py` (`tests/test_support.py` fails on an edited released file).

Dry runs:

- `CHATWOOT_URL` / `CHATWOOT_API_TOKEN` empty: the workflow logs and ends (`dry-run`).
- Tracker credentials empty: triage and the note happen; the note says which item would have
  been created; nothing is filed.
- No triage model or `SUPPORT_AI_ORG_ID`: the workflow logs `off` and ends.

## Trackers

`SUPPORT_TRACKER` picks the adapter (`github` default, or `plane`).

**GitHub Issues** (`GITHUB_TOKEN` fine-grained with Issues read/write, `GITHUB_REPO`, the same
variables the PostHog hook uses). New items get labels `from-users`, `support` and `bug` or
`feature-request`; a "+1" also adds `support` to the existing issue. Duplicate search uses
`GET /search/issues` (`repo:<repo> is:issue is:open <keywords>`). Note: GitHub is a US
processor. Issues contain the model's summary, not the transcript, but still a description of
a user's problem: use Plane on-prem where that is not allowed.

**Plane Intake** (`PLANE_API_URL` e.g. `https://api.plane.so` or your self-hosted URL,
`PLANE_WORKSPACE` slug, `PLANE_PROJECT_ID`, `PLANE_API_TOKEN` with `projects.intakes:write` and
work item read/write, optional `PLANE_APP_URL` for links when the app host differs). New items:
`POST /api/v1/workspaces/{slug}/projects/{project_id}/intake-issues/` with
`{"issue": {"name", "description_html"}}`, so they land in the project's Intake for a human to
accept, decline or snooze. Duplicates: `GET .../work-items/search/` in the project, finished
items dropped; "+1" is a work item comment. Intake must be enabled for the project.

## Return path

- GitHub: repository Settings -> Webhooks: payload URL `<api>/api/hooks/github`, content type
  `application/json`, secret `GITHUB_WEBHOOK_SECRET`, event **Issues**. The API checks
  `X-Hub-Signature-256` and reacts only to `closed` issues labelled `support`.
- Plane: Workspace settings -> Webhooks: URL `<api>/api/hooks/plane`, event **Work items ->
  Updated** (v2 webhook); optional filter `project_id = "<PLANE_PROJECT_ID>" and state_group in
  ["completed", "cancelled"]`. Secret (`plane_wh_...`, downloaded as CSV) -> `PLANE_WEBHOOK_SECRET`,
  plus `PLANE_PROJECT_ID` on the API. The API checks `X-Plane-Signature` (hex HMAC-SHA256 of the
  raw body) and reacts to state changes in that project. Plane only calls public URLs.

Both start `SupportIssueClosedWorkflow` (one id per close event, so redeliveries do nothing). The
worker re-reads the item, finds every conversation URL in its body and comments, and writes a
private note in each: "Linked issue ... was resolved" or "closed without a fix (not planned)".
With `SUPPORT_NOTIFY_ON_CLOSE=true` it also sends the customer a short "has been resolved"
message, only for items closed as done (GitHub `completed`, Plane state group `completed`). The
text is `RESOLVED_MESSAGE` in `worker/support.py` (English; change it for your audience).

## Data residency

Chats, emails and Telegram messages are personal data. Deployments with data-residency
requirements self-host Chatwoot (this profile) in the required jurisdiction instead of using
Chatwoot Cloud, and keep the rest of the path there too: a self-hosted tracker (Plane, not
GitHub), a triage model served from an allowed endpoint (a contour in `config/ai-models.json`
with an OpenAI-compatible `OPENAI_BASE_URL`), and the Chatwoot version check blocked if nothing
may leave. Telegram messages transit Telegram's own servers; that is the user's choice of channel,
but Chatwoot's copy stays where you host it.

## Resources

Measured on this repo (2026-11-07, `docker stats`, Chatwoot v4.19.1-ce, 8 CPU host):

| Container                         | Idle (after start) | Peak under load | Compose `mem_limit` |
| --------------------------------- | ------------------ | --------------- | ------------------- |
| `chatwoot` (Rails/Puma)           | ~411 MiB           | ~442 MiB        | 1 GiB               |
| `chatwoot-sidekiq`                | ~445 MiB           | ~572 MiB        | 1 GiB               |
| `chatwoot-postgres` (pgvector 16) | ~70 MiB            | ~110 MiB        | 512 MiB             |
| `redis` (shared, whole instance)  | ~6 MiB             | ~14 MiB         | 64 MiB (unchanged)  |

Load: 46 conversations with 3 customer messages each through Chatwoot's public client API
(an API inbox, 10 concurrent senders, ~3 messages/s, 0 errors), each one signed-webhooked to the
API, triaged by the worker (fake LLM) and answered with one private note: 46 of 46 triaged,
exactly one note each, the 2 later messages per conversation rejected as duplicate workflow
starts. Memory does not fall back after the load (Ruby keeps its heap): plan **~1.2 GiB** for the
profile, or about 1.0 GiB idle. The last 5 conversations ran on the permissive twin (Valkey 9
instead of Redis 8) with the same result. Fits the 8 CPU / 24 GB S server next to the app.

## Replacement criteria

Replace Chatwoot if a client needs a feature only its enterprise edition has (SLA policies,
custom roles, audit logs, Captain AI) and will not buy it, or if its license changes for the MIT
core. Candidates (not evaluated in depth): Zammad (AGPL-3.0), FreeScout (AGPL-3.0, email-first).
Both are infra containers, allowed by ADR 0005. The replacement needs a
website widget with signed identity, email and Telegram channels, signed webhooks and an API for
private notes and conversation attributes.
