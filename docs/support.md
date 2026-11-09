# Service desk (Chatwoot)

Users ask questions, report problems and suggest improvements in one place: the **Help** menu in
the app, plus email and Telegram. For Telegram only, without Chatwoot, see
[Lite: Telegram only](#lite-telegram-only). Tickets live in [Chatwoot](https://github.com/chatwoot/chatwoot)
(MIT core, self-hosted), backlog items live in the tracker (Plane by default, new items in the
project's Intake; GitHub Issues as an optional alternative). This repo keeps no ticket table, event journal or link table. The link
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

tracker item closed or released ──webhook──> POST /api/hooks/{plane,github} -> SupportIssueClosedWorkflow
  -> private note in every linked conversation (+ optional customer message)
```

| Piece                  | Where                                                          |
| ---------------------- | -------------------------------------------------------------- |
| Help menu + widget     | `apps/web/src/lib/support.ts`, `HelpMenu` in `pages/shell.tsx` |
| Widget identity (HMAC) | `GET /api/support/identity` (`apps/api/src/routes/support.ts`) |
| Webhook receivers      | `POST /api/hooks/chatwoot`, `/plane`, `/github` (same file)    |
| Triage + return path   | `services/worker-py/worker/support.py`, `workflows.py`         |
| Tracker (one client)   | `services/worker-py/worker/tracker.py`                         |
| Prompts (versioned)    | `prompts/support.triage/system.v1.md`, `duplicate.v1.md`       |
| Containers             | `docker compose --profile support` (`docker-compose.yml`)      |

## Run it

```sh
docker compose --profile support up -d      # chatwoot (UI :3300), chatwoot-sidekiq
```

- Port: `CHATWOOT_PORT`, default 3300 (Langfuse in the `llmops` profile has 3200).
- Image `chatwoot/chatwoot:v4.19.1-ce`: the community build, made by Chatwoot's CI after
  `rm -rf enterprise`. Never use the tag without `-ce` (it contains `enterprise/`,
  docs/LICENSES.md).
- `chatwoot-prepare` (one-shot) runs `rails db:chatwoot_prepare` (creates or migrates the schema),
  then `chatwoot` (Rails, port `CHATWOOT_PORT`) and `chatwoot-sidekiq` (jobs) start.
- Database: `chatwoot` (role `chatwoot`) on the stack's Postgres server, created by the
  `chatwoot-db` one-shot together with the `vector` and `pg_stat_statements` extensions
  (Chatwoot's schema enables them; neither may be created by a non-superuser). The stack's
  image is `postgres:17-alpine` plus the pgvector extension files (`infra/backup/Dockerfile`,
  target `postgres`); databases that do not create the extension are unaffected. The backup
  overlay therefore covers Chatwoot like every other database (docs/backups.md).
- Attachments: in S3, Chatwoot's `s3_compatible` storage service, bucket `chatwoot` on the
  stack's SeaweedFS by default (`CHATWOOT_STORAGE_ENDPOINT`, `_REGION`, `_BUCKET`,
  `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` for another S3; create the bucket first there). The
  backup overlay copies the bucket hourly (`BACKUP_APP_BUCKETS`). `infra/chatwoot/storage-proxy.rb`
  (mounted as an initializer) makes Chatwoot serve files itself instead of redirecting browsers
  to presigned S3 URLs, so the endpoint can stay internal. Channels that fetch an agent's
  attachment by URL (Telegram, WhatsApp, Facebook, SMS) still get a presigned S3 URL: for those,
  `CHATWOOT_STORAGE_ENDPOINT` must be reachable from the internet.
- Redis: the stack's `redis`, database 2 (GlitchTip uses 1, rate limits 0). Its default
  `noeviction` policy is what Sidekiq needs. With `compose.permissive.yaml` it is Valkey 9 (same
  protocol), measured below.
- Outbound calls: `DISABLE_TELEMETRY=true` (no instance metrics) and
  `ENABLE_PUSH_RELAY_SERVER=false` (no mobile push relay). Chatwoot still checks
  `hub.2.chatwoot.com` for new versions; block it at the firewall where nothing may leave.
- `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true`: Chatwoot blocks webhooks to private addresses by
  default, and the API is `http://api:3000` on the compose network. Turn it off when the API has
  a public URL.
- Production: set `CHATWOOT_DB_PASSWORD` (its database shares the server with app data),
  `CHATWOOT_SECRET_KEY_BASE` (`openssl rand -hex 64`), `CHATWOOT_FRONTEND_URL`
  (its public HTTPS URL; Telegram and email need it) and the SMTP variables. Put it behind the
  same reverse proxy as the app.

**Upgrading an install that ran the earlier layout** (own `chatwoot-postgres`, files in the
`chatwoot-storage` volume). Before updating the checkout, dump the database:
`docker compose --profile support exec -T chatwoot-postgres pg_dump -U chatwoot -Fc chatwoot > chatwoot.dump`.
After it: `docker compose --profile support up -d --wait chatwoot-db`, then
`docker compose exec -T postgres pg_restore -U postgres -d chatwoot --no-owner --role chatwoot < chatwoot.dump`,
then start the profile. Attachments uploaded before the switch keep `service_name = 'local'` in
`active_storage_blobs`; Rails reads each blob from the service it was stored with, so they show
only while the old volume is mounted at `/app/storage` (add `chatwoot-storage:/app/storage` to the
Chatwoot services), and they are not in the backup until copied to the bucket and their
`service_name` set to `s3_compatible`.

## Set up Chatwoot (UI, once)

1. Open `http://localhost:3300`, create the admin account and the first account (sign-up is
   otherwise off: `ENABLE_ACCOUNT_SIGNUP=false`). Invite agents under Settings -> Agents.
2. **Website inbox** (Settings -> Inboxes -> Website): any name, your app's domain. Copy the
   **website token** to `VITE_CHATWOOT_WEBSITE_TOKEN`. Under Configuration, turn on **Enforce
   user identity validation** and copy the **HMAC token** to `CHATWOOT_HMAC_TOKEN` (API).
3. **Webhook** (Settings -> Integrations -> Webhooks): URL `http://api:3000/api/hooks/chatwoot`
   (or the public API URL), event **Message created** (plus **Conversation created** if the CRM
   sync is on: each new conversation becomes a note on the person, docs/crm.md). Copy its secret (shown in the webhook's
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
  `CHATWOOT_SMTP_*` variables (locally they go to the stack's Mailpit, UI on :8025).
- **Telegram**: create a bot with [@BotFather](https://t.me/BotFather), then Settings ->
  Inboxes -> Telegram and paste the bot token. Chatwoot registers the bot's webhook at
  `CHATWOOT_FRONTEND_URL`, so it must be reachable over public HTTPS.
- **API inbox**: for any other source you build later (see docs/TODO.md: social mentions).

### Web app

```sh
VITE_CHATWOOT_BASE_URL=http://localhost:3300   # build-time: where sdk.js and the widget come from
VITE_CHATWOOT_WEBSITE_TOKEN=...                # website inbox token
SUPPORT_ORIGINS=http://localhost:3300          # web container: CSP script/frame/connect/img-src
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

System card: [docs/ai/support.triage.md](ai/support.triage.md). Eval: `evals/support.triage/`
(synthetic golden set, judge `prompts/judge/support.triage.v1.md`; `pnpm eval support.triage`,
`pnpm eval:real support.triage` with your Claude subscription). The duplicate prompt is covered
by `tests/test_support.py` only. Prompts follow the repo's prompt convention: files `prompts/<purpose>/<name>.v<N>.md`, pinned by
hash in `prompts/lock.json`; a changed prompt is a new version file plus a bumped version in
`worker/support.py` (`tests/test_support.py` fails on an edited released file).

Dry runs:

- `CHATWOOT_URL` / `CHATWOOT_API_TOKEN` empty: the workflow logs and ends (`dry-run`).
- Tracker credentials empty (`TRACKER`, below): triage and the note happen; the note says which
  item would have been created; nothing is filed.
- No triage model or `SUPPORT_AI_ORG_ID`: the workflow logs `off` and ends.

## Trackers

Every producer of backlog items files through one tracker client, `worker/tracker.py` (search
open items, create, comment, read): the PostHog alert/survey hook
([docs/product-analytics.md](product-analytics.md)), this triage and the release comments
([docs/releases.md](releases.md), `worker/released.py`). The API never calls a tracker: its
PostHog hook redacts the text, writes `{title, body}` to the uploads bucket under
`tracker-inbox/` and starts `TrackerItemWorkflow` (id = hash of the text, duplicates rejected)
with only the producer and the key; the worker files the item and deletes the object, and the
daily retention schedule deletes any left over after a day. Configuration (worker only):

- `TRACKER`: `plane` (default) or `github` (optional, off by default). Credentials empty = dry
  run everywhere.
- `config/tracker.json`: one entry per producer (`cjm-regression`, `from-users`, `support-bug`,
  `support-feature-request`) with its `labels` and, for Plane, an optional `state` (a state
  name). Without `state` a new item goes to the project's **Intake**; with it, straight into that
  state. The worker resolves the states at start and refuses to start when one is unknown or in
  the `completed` or `cancelled` group. Labels are created in Plane when missing.
- Nothing ever closes an item or moves it to a completed state: accepting, declining and closing
  are for humans.
- Errors from tracker calls carry only the HTTP status or the error class: request URLs (Plane's
  search takes the keywords as a query parameter) never reach logs, Temporal history or Sentry.

**Plane** (default; `PLANE_API_URL` e.g. `https://api.plane.so` or your self-hosted URL,
`PLANE_WORKSPACE` slug, `PLANE_PROJECT_ID`, `PLANE_API_TOKEN`, optional `PLANE_APP_URL` for links
when the app host differs). The worker uses Plane's official Python SDK
([`plane-sdk`](https://pypi.org/project/plane-sdk/), MIT, by Plane Software), REST API v1:

- New item in Intake: `intake.create` (`{"issue": {"name", "description_html"}}`), then the
  producer's labels on the work item behind it (`work_items.update`, Intake takes no labels on
  create). Intake must be enabled for the project. With a `state`: `work_items.create` with that
  state and the labels.
- Duplicates: Plane's work item search (`work_items.search`, narrowed to the project) skips items
  still in Intake (they have the triage state), so the project's Intake list (every page) is read
  as well: items pending or snoozed count as open; accepted ones come from the search, minus
  those in a completed or cancelled state group. Alerts and feedback match the exact title
  (Intake included); the triage passes keywords and lets the duplicate prompt decide.
- "+1" and release notes are work item comments.

**GitHub Issues** (optional: `TRACKER=github`, `GITHUB_TOKEN` fine-grained with Issues
read/write, `GITHUB_REPO`, `GITHUB_API_URL` for GitHub Enterprise Server). Plain REST over
httpx2: PyGithub is LGPL (banned by the license gate) and githubkit (MIT) would add a second HTTP
client stack for six calls. New items get the producer's labels; a "+1" also adds `support` to
the existing issue. Duplicates come from `GET /search/issues` (`repo:<repo> is:issue is:open
<words>`). GitHub is a US processor: issues contain the model's summary, not the transcript, but
still a description of a user's problem; use Plane on-prem where that is not allowed.

### Live smoke run

Against a real Plane test project, once a token is available. It files one alert (`[cjm] smoke test: signup funnel`, a comment on later runs),
one support item and one release comment on that item, all in Intake, and prints their links;
nothing is closed or moved. Decline the items in Intake afterwards.

```sh
cd services/worker-py
PLANE_API_URL=https://api.plane.so PLANE_APP_URL=https://app.plane.so \
PLANE_WORKSPACE=<slug> PLANE_PROJECT_ID=<project uuid> PLANE_API_TOKEN=<token> \
uv run python -m worker.tracker smoke v0.0.0-smoke
```

The project needs Intake enabled. With the Plane webhook configured (below), the release
comment also reaches `POST /api/hooks/plane`; it is ignored unless the token's user wrote it.
A release-comment run over real PRs: `GITHUB_TOKEN=$(gh auth token) PLANE_...=...
uv run --directory services/worker-py python -m worker.released <tag> --dry-run`.

## Return path

- Plane: Workspace settings -> Webhooks: URL `<api>/api/hooks/plane`, events **Work items ->
  Updated** and **Work item comments -> Created** (v2 webhook); optional filter
  `project_id = "<PLANE_PROJECT_ID>"`. The open-source Community Edition only sends v1 webhooks
  (events `issue` / `issue_comment` with `action` and `activity.field`, no event id): subscribe
  to work items and work item comments there; the receiver understands both formats. Secret (`plane_wh_...`, downloaded as CSV) ->
  `PLANE_WEBHOOK_SECRET`, plus `PLANE_PROJECT_ID` on the API. The API checks
  `X-Plane-Signature` (hex HMAC-SHA256 of the raw body) and reacts to state changes in that
  project and to a new `Released in v...` comment (below). Plane only calls public URLs.
- GitHub (optional tracker): repository Settings -> Webhooks: payload URL
  `<api>/api/hooks/github`, content type `application/json`, secret `GITHUB_WEBHOOK_SECRET`,
  events **Issues** and **Issue comments**. The API checks `X-Hub-Signature-256` and reacts only
  to issues labelled `support`: `closed`, or a new `Released in v...` comment.

Both start `SupportIssueClosedWorkflow` (one id per close event, so redeliveries do nothing). The
worker re-reads the item, finds every conversation URL in its body and comments, and writes a
private note in each: "Linked issue ... was resolved" or "closed without a fix (not planned)".
With `SUPPORT_NOTIFY_ON_CLOSE=true` it also sends the customer a short "has been resolved"
message, only for items closed as done (Plane state group `completed`, GitHub `completed`). The
text is `RESOLVED_MESSAGE` in `worker/support.py` (English; change it for your audience).

Releases: when the repo uses the release flow (docs/releases.md), `worker/released.py`
comments `Released in vX.Y.Z (via #PR) ...` on every item a released PR closes: a closing
keyword in the PR title or body (`Fixes PROJ-123` for Plane, `Closes #12` with `TRACKER=github`);
a bare mention is not enough. It never changes an item's state. That comment starts the same
workflow (id per tag), which notes "Linked issue ... is live in vX.Y.Z", also while the Plane
item is still open (nobody has moved it yet). On Plane the worker acts only on release comments
written by its own token's user (`users/me`, looked up once), so give the release workflow the
same `PLANE_API_TOKEN`; a person typing "Released in v9" changes nothing. With
`SUPPORT_NOTIFY_ON_CLOSE=release` the customer message waits for that comment
instead of the close.

## Lite: Telegram only

A support bot users message in Telegram, with the team answering from a Telegram group: no
Chatwoot, no extra containers. Built into the API and the worker, behind the flag
`telegram-support` (default off).

**Which one.** Lite when Telegram is where your users are (markets where it is the main
messenger), a few people answer and the team lives in Telegram anyway. Chatwoot when you need more
than one channel (widget, email), assignment, SLAs, canned answers, reports or the AI triage note,
or when agents should not work from a messenger. Outgrowing lite = connecting the bot to a
Chatwoot Telegram inbox ("Channels" above, `TELEGRAM_SUPPORT_*` unset); the tracker and the return
path stay the same.

```
user ──> bot (private chat) ──webhook──> POST /api/hooks/telegram ──signal──> TelegramChatWorkflow
          (X-Telegram-Bot-Api-Secret-Token, constant time)                    (id telegram-chat-<chat>-<thread>)
worker: one forum topic per Telegram user in the team's supergroup, created on first contact;
  user's message copied into it (copyMessage: text, photos, files, voice), 👍 reaction on it,
  an acknowledgement on first contact (TEXTS in worker/telegram.py, by the user's language)
team reply in the topic ──> same webhook ──> copied to the user's private chat
/bug <title> or /feature <title> in a topic ──> tracker item (support-bug / support-feature-request)
```

- **Order and retries**: one workflow per private chat and one per topic, started or signalled
  per message (signal-with-start); it relays its messages one at a time, in order, drops message
  ids it has already seen (Telegram redelivers when an answer is slow), ends after an idle hour and
  continues as new every 100 messages. The webhook is registered with `max_connections: 1`, so
  Telegram sends updates one after another. Each step of a message (copy, reaction,
  acknowledgement, note) is its own activity: a retry repeats only the failed step. A 429 waits
  Telegram's `retry_after`; steps keep retrying for up to an hour, other 4xx are not retried.
- **Storage**: `telegram_support_users` (Telegram user id, group id, topic id, linked app user id)
  and `telegram_support_links` (signatures of used deep links). Messages are not stored by us: they
  stay in Telegram. Workflow arguments carry ids only: message ids, the app user id of a verified
  link, and for `/bug` the S3 key of the title (`tracker-inbox/`, deleted after filing, leftovers
  purged daily).
- **Account link**: Help -> Telegram in the app fetches a fresh payload from
  `GET /api/support/telegram` on each click and opens `t.me/<bot>?start=<payload>`. The payload is
  `<expiry>_<signature>_<user id>`, signed with a key derived from the bot token, valid for **10
  minutes and once**: the API verifies it when `/start` arrives and stores its signature, so a
  replayed or forwarded link is refused. The user gets "Done: this chat is now linked to your
  account j\*\*\*@example.com" (masked email: they see at once if it is not theirs), or "expired or
  already used"; the team gets "Linked to app user ... (organizations: ...)" in the topic. Without
  a link the user is anonymous to the team (their Telegram name and id are in the topic title).
- **Team commands** in a topic: `/bug <title>` and `/feature <title>` file a tracker item with the
  Chatwoot triage's producers (`config/tracker.json`), or add "+1" to the open item with that exact
  title (not when that item already links this topic: no "+1" on its own item). The title is
  redacted once, in the API (`redact()`: Presidio with the `pii` sidecar, else emails only;
  "Personal data" below); the item carries the topic link, never the user's messages. The bot
  answers in the topic with the link (or "dry run" without tracker credentials). Other commands
  are not relayed: the team can talk in the topic with `/note ...` and similar.
- **Return path**: `SupportIssueClosedWorkflow` also finds topic links (`https://t.me/c/<group>/<topic>`)
  in the item and notes the outcome in each topic; with `SUPPORT_NOTIFY_ON_CLOSE` the user gets
  `RESOLVED_MESSAGE` in Telegram too.
- **Rate limit**: 5 messages per minute per Telegram user (the API's Redis rate-limit store).
  Over it, messages are dropped with a 200 answer, so Telegram does not redeliver them.
- A deleted topic is recreated on the user's next message, a closed one is reopened; a reply the
  user cannot receive (they blocked the bot) gets a "Not delivered" note in the topic.

### Set up

1. [@BotFather](https://t.me/BotFather): `/newbot`, keep the token. `/setprivacy` -> Disable is
   not needed (the bot is an admin, admins get every message).
2. Create a group, Settings -> **Topics** on (it becomes a forum supergroup). Add the team.
   **The group is the trust boundary**: everyone in it reads every user's messages and can answer
   as the bot. Keep it private (Group type: Private), revoke every invite link (Invite links ->
   revoke, add people by hand), and leave _Remain anonymous_ off for every admin: replies from
   anonymous admins come from Telegram's stand-in bot and are not relayed.
3. Add the bot as **administrator** with _Manage topics_ (needed for `createForumTopic` and to
   reopen closed topics).
4. Chat id: send a message in the group, then
   `curl -s https://api.telegram.org/bot<token>/getUpdates` (before the webhook is set) and take
   `message.chat.id` (`-100...`).
5. Configure and roll out:

```sh
TELEGRAM_SUPPORT_BOT_TOKEN=<token>                 # API + worker
TELEGRAM_SUPPORT_CHAT_ID=-1001234567890            # API + worker
TELEGRAM_SUPPORT_WEBHOOK_URL=https://app.example.com/api/hooks/telegram   # worker
VITE_TELEGRAM_SUPPORT_BOT=example_support_bot      # web, build time: the Help menu entry
pnpm flags:sync   # then turn `telegram-support` on in PostHog (or FLAGS_ON / VITE_FLAGS_ON)
```

The worker registers the webhook at start (`setWebhook` with `secret_token` = HMAC of the token,
`allowed_updates: ["message"]`, `max_connections: 1`) while the flag is on; the API checks that header and answers 404
while the flag is off. The flag is one switch for the bot (no per-user rollout: Telegram would
redeliver what a user outside the rollout sends). The webhook URL must be public HTTPS (ports 443,
80, 88 or 8443). To test locally, point a tunnel at the API and set the URL to it.

### Limits

- Telegram lets a bot send at most 20 messages per minute into one group (Bot FAQ). Every user
  message is one copy into the support group, plus notes: beyond roughly 20 incoming messages a
  minute the copies get 429s and wait (`retry_after`, up to an hour per step, then the step is
  dropped). Sustained traffic like that is the point to move to Chatwoot.
- A copy that succeeds just before its activity times out is retried and arrives twice (rare;
  at-least-once delivery).
- Edited messages and reactions are not relayed (the webhook subscribes to `message` only).
  Messages Telegram cannot copy (polls with hidden answers, paid media, service messages) are not
  relayed.
- No assignment, statuses, search or reports beyond what Telegram offers (topic open/closed, pins).
- Telegram is the processor of all support content: the residency notes below apply to it, and
  there is no self-hosted variant.

## Personal data

The triage output that leaves Chatwoot (issue title and body, "+1" comments, the private note's
summary) is redacted with [Microsoft Presidio](https://github.com/microsoft/presidio) (MIT) in
the worker process (`worker/pii.py`), on top of the prompt asking the model for no personal
data. The same code runs as a small HTTP sidecar for the API's PostHog feedback hook
(`POST /api/hooks/posthog`, docs/product-analytics.md): the worker image with
`python -m worker.pii`, compose profile `pii`, opt-in.

- What is replaced: emails `[email]`, phone numbers `[phone]`, card numbers `[card]` (Luhn
  checked), IBANs `[iban]` (checksum), IP addresses `[ip]`, person names `[name]`. URLs, ids and
  product words stay.
- Model: `en_core_web_sm` (spaCy 3.8, MIT), because the triage prompt writes title and summary
  in English. The pattern recognizers (everything but names) work on text in any language; names
  are found in English text only. Survey answers in other languages keep names the English model
  misses.
- Known gaps (measured 2026-11-07, `tests/test_pii.py` `GAPS`): a short first name at the start
  of a sentence ("Ana logged in"), local phone numbers without an area code (`555-0132`),
  obfuscated emails (`john.doe(at)example.com`); and it over-redacts at times ("ask john about"
  loses "about", "Customer Priya" loses "Customer"). Names are best effort, the patterns are not.
- Fail closed: the worker has Presidio built in (a load error fails the activity, which Temporal
  retries; nothing is filed unredacted). With `PII_REDACT_URL` set, the API hook answers 503 when
  the sidecar is down or answers badly, so no survey text is filed; PostHog shows the failed
  delivery. Without `PII_REDACT_URL` the hook masks emails only (the old regex), and the browser's
  `track()` keeps its email regex (no Python there).
- Memory (docs/STACK.md): about +100 MiB in the worker (it loads the model at start when triage
  is configured), 136-189 MiB for the sidecar; load takes 2-15 s. Each more language is one more
  spaCy model in the `NlpEngineProvider` config (`worker/pii.py`), ~160-190 MiB each for the
  small models; the `*_core_web_lg` models are far bigger (Microsoft's `presidio-analyzer`
  image uses one: ~740 MiB idle).
- Enable the sidecar: `COMPOSE_PROFILES=pii` and `PII_REDACT_URL=http://pii:8000` on the API
  (locally: `docker compose --profile pii up -d pii`, `PII_REDACT_URL=http://localhost:8010`).

## Data residency

Chats, emails and Telegram messages are personal data. Deployments with data-residency
requirements self-host Chatwoot (this profile) in the required jurisdiction instead of using
Chatwoot Cloud, and keep the rest of the path there too: a self-hosted tracker (Plane, not
GitHub), a triage model served from an allowed endpoint (a contour in `config/ai-models.json`
with a self-hosted or custom OpenAI-compatible endpoint, docs/llm-providers.md), and the Chatwoot version check blocked if nothing
may leave. Telegram messages transit Telegram's own servers; that is the user's choice of channel,
but Chatwoot's copy stays where you host it.

## Resources

Measured on this repo (2026-11-07, `docker stats`, Chatwoot v4.19.1-ce, 8 CPU host):

| Container                         | Idle (after start) | Peak under load | Compose `mem_limit` |
| --------------------------------- | ------------------ | --------------- | ------------------- |
| `chatwoot` (Rails/Puma)           | ~411 MiB           | ~442 MiB        | 1 GiB               |
| `chatwoot-sidekiq`                | ~445 MiB           | ~572 MiB        | 1 GiB               |
| `redis` (shared, whole instance)  | ~6 MiB             | ~14 MiB         | 64 MiB (unchanged)  |
| `postgres` (shared, whole server) | ~71 MiB (+46 MiB)  | not re-measured | 512 MiB (unchanged) |

Load: 46 conversations with 3 customer messages each through Chatwoot's public client API
(an API inbox, 10 concurrent senders, ~3 messages/s, 0 errors), each one signed-webhooked to the
API, triaged by the worker (fake LLM) and answered with one private note: 46 of 46 triaged,
exactly one note each, the 2 later messages per conversation rejected as duplicate workflow
starts. Memory does not fall back after the load (Ruby keeps its heap): plan **~1.1 GiB** for the
Chatwoot containers plus the shared Postgres's growth, about 0.9 GiB idle. Until 2026-11-07
Chatwoot had its own `chatwoot-postgres` (~90 MiB idle, ~110 MiB under that load, 512 MiB
limit); on the shared server the same idle state costs ~46 MiB (25 -> 71 MiB, measured with
postgres + redis + s3 + chatwoot + chatwoot-sidekiq, ~3 minutes after start), ~44 MiB less in
total. The last 5 conversations ran on the permissive twin (Valkey 9
instead of Redis 8) with the same result. Fits the 8 CPU / 24 GB S server next to the app.

## Replacement criteria

Replace Chatwoot if a client needs a feature only its enterprise edition has (SLA policies,
custom roles, audit logs, Captain AI) and will not buy it, or if its license changes for the MIT
core. Candidates (not evaluated in depth): Zammad (AGPL-3.0), FreeScout (AGPL-3.0, email-first).
Both are infra containers, allowed by ADR 0005. The replacement needs a
website widget with signed identity, email and Telegram channels, signed webhooks and an API for
private notes and conversation attributes.
