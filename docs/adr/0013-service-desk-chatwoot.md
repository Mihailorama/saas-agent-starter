# 0013. Service desk in Chatwoot, backlog in the tracker

Status: accepted (owner decision, 2026-11-07)

## Context

Users need one place to ask questions, report problems and suggest improvements, from the app,
by email and in Telegram. The product team needs those requests sorted, deduplicated and turned
into backlog items, and the people who reported them told when they are done. A first-party
ticket table, event journal or conversation-to-issue table would re-implement a help desk and
still lack channels, an agent inbox and a widget.

## Decision

- **Chatwoot is the service desk**: conversations, contacts, agents and channels (website
  widget, email, Telegram, API inbox) live there. Self-hosted from the `support` compose profile,
  image `chatwoot/chatwoot:<version>-ce`, which Chatwoot builds with `enterprise/` removed: only
  the MIT core runs, no enterprise feature is used.
- **Backlog items live in the tracker**: Plane by default, new items in the project's Intake so
  they wait for a human to accept them (owner decision 2026-11-07: tasks go to Plane, alerts never
  open GitHub issues). One tracker contract serves every producer (PostHog hook, this triage,
  release comments): one client in the worker, `worker/tracker.py` on Plane's official Python
  SDK, configured by `TRACKER` and `config/tracker.json` (labels, Intake or a target state per
  producer). The API only stores the redacted text in S3 and starts a workflow. GitHub Issues
  stays an optional adapter (`TRACKER=github`, plain REST) for installations that want it. No code
  closes an item or moves it to a completed state; a completed or cancelled target state stops
  the worker at start.
- **No link table**: the conversation URL goes into the issue (body or "+1" comment), the issue
  URL into the conversation's `tracker_issue_url` custom attribute. Both survive without us.
- **Triage is a Temporal workflow in the Python worker** (`SupportTriageWorkflow`, id per
  conversation, `REJECT_DUPLICATE`), started by a signed Chatwoot webhook
  (`X-Chatwoot-Signature`, HMAC-SHA256 over timestamp and raw body). The worker reads the text
  from Chatwoot; workflow arguments are ids only. It classifies through the existing AI gateway
  (purpose `support.triage`, versioned prompt files, `ai_calls` audit under the operator's
  `SUPPORT_AI_ORG_ID`), files or "+1"s the tracker item and writes **one private note**. It never
  replies to a customer. A draft answer for questions is a note for an agent to review.
- **Return path**: signed Plane (`X-Plane-Signature`) and GitHub (`X-Hub-Signature-256`)
  webhooks start `SupportIssueClosedWorkflow`, which notes the outcome in every linked
  conversation; a customer message only with `SUPPORT_NOTIFY_ON_CLOSE=true` and only for items
  closed as done. With the release flow (ADR 0020) the `Released in vX.Y.Z` comment (Plane work
  item or GitHub issue) adds a
  "live in" note, and `SUPPORT_NOTIFY_ON_CLOSE=release` moves the customer message there.
- **Widget identity**: `GET /api/support/identity` returns the user id and
  `HMAC-SHA256(CHATWOOT_HMAC_TOKEN, id)`; the inbox enforces identity validation. The widget is
  loaded with Chatwoot's own `sdk.js` (no npm dependency), only when the user opens Help.
- **One entry point**: with the widget configured, the PostHog "Report a problem" feedback tab
  is not created; AI-answer thumbs stay in PostHog / Langfuse (ADR 0012).
- Everything is env-driven and off by default: no env, no Help entry, no request, endpoints
  answer 401/404, the worker logs dry runs.

Picks that are not obvious, one line each:

- Chatwoot's database on the stack's Postgres server (own database and role), its attachments
  in the stack's S3 (bucket `chatwoot`), so the backup overlay (ADR 0015) covers them. Its schema
  enables `vector`, so the stack's image is `postgres:17-alpine` plus the pgvector extension
  files; databases that do not create the extension are unchanged. (Until 2026-11-07 Chatwoot had
  its own `pgvector/pgvector` server and a file volume, which no backup reached.)
- Shared Redis (db 2): Sidekiq needs `noeviction`, which the stack's Redis/Valkey already has;
  measured fine on both twins.
- Agent access token of a bot user, not an Agent Bot: notes then appear under a named agent and
  the same token works for every inbox.
- Duplicate check by tracker search plus a second small LLM call: search alone ranks, it does
  not decide; a wrong "+1" on someone else's issue is worse than a new item.

## Alternatives

- Own tickets table and inbox UI: rejected by the owner; it rebuilds a help desk badly.
- Zammad (AGPL-3.0, a heavier stack) and FreeScout (AGPL-3.0, email-first): not checked in
  depth; both allowed as containers and kept as candidate replacements.
- Chatwoot Cloud: fine where data may leave, but not for on-prem or data-residency
  deployments; the self-hosted profile covers all tiers with one setup.
- Chatwoot's Captain AI and Agent Bots for triage: Captain is an enterprise feature; an Agent
  Bot would put the LLM call outside our audited gateway.
- PostHog surveys as the bug/feature channel: no conversation, no email or Telegram, no agent
  workflow; kept only for AI-answer thumbs.

## Consequences

- New infra container: `chatwoot/chatwoot` (MIT, `-ce` only); the stack's Postgres image is
  built with pgvector (PostgreSQL License). Listed in docs/LICENSES.md and covered by `pnpm sbom`
  (all profiles). Measured ~1.0 GiB idle, ~1.2 GiB under load for the profile (docs/support.md).
- No new code dependency: the worker uses `httpx2` (already there), the web Chatwoot's script.
- Chatwoot still checks `hub.2.chatwoot.com` for new versions with telemetry off; block it at
  the network where nothing may leave.
- Deployments with data-residency requirements self-host Chatwoot in the required jurisdiction
  and use a self-hosted tracker and an allowed model endpoint there.
- GitHub receives the model's summary of a user's problem (US processor); use Plane on-prem
  where that is not allowed.
- Webhook starts are not transactional: if Temporal is down when Chatwoot calls, that triage is
  lost (Chatwoot does not retry account webhooks). Same gap as the project workflow start
  (docs/TODO.md, outbox).

## Amendment (2026-11-08): lite Telegram support without Chatwoot

Owner request: support done simply in Telegram, built into the boilerplate, for products whose
users live in Telegram (the first one is a marketplace built from the template). Chatwoot's
Telegram inbox works but brings Rails, Sidekiq and ~1 GiB for what is a relay.

- **Pattern**: a bot plus the team's forum supergroup, one topic per Telegram user; the team
  replies in the topic and the bot copies the reply back (`copyMessage`, so media pass and no
  "forwarded from" header shows). Behind the flag `telegram-support`, off by default.
- **Built in, no container, no new dependency**: plain Bot API over `httpx2` in the worker
  (`worker/telegram.py`, five methods). Checked 2026-11-08 for an "install" option:
  [MasterGroosha/telegram-feedback-bot-topics](https://github.com/MasterGroosha/telegram-feedback-bot-topics)
  (MIT, aiogram 3 + its own PostgreSQL, the closest match) says "still under development", has had
  no release since v2025.02.1 (February 2025) and is built from source;
  [bostrot/telegram-support-bot](https://github.com/bostrot/telegram-support-bot) is active but
  GPL-3.0 and ticket-per-staff-thread rather than topic-per-user. Neither could link app accounts
  or file through our tracker without being modified. aiogram (MIT) would add a framework and its
  dispatcher for five calls; python-telegram-bot is LGPL-3.0 (banned by ADR 0005).
- **Same shape as the Chatwoot path**: a webhook on the API (`POST /api/hooks/telegram`, Telegram's
  `X-Telegram-Bot-Api-Secret-Token` compared in constant time) signals one Temporal workflow
  per chat or topic (signal-with-start), which relays its messages in order, one activity per step;
  the worker does the Bot API calls. Ids only in workflow arguments: the API verifies `/start`
  links (10 minutes, single use) and puts `/bug` titles in S3. `/bug` and
  `/feature` in a topic use the triage's producers and tracker client; the return path notes the
  outcome in linked topics as it does in conversations (the topic link in the item is the link).
- **Two small tables**: `telegram_support_users` (Telegram user, group, topic, linked app user;
  Telegram has no "find topic by user" call; deleted with the app user) and
  `telegram_support_links` (used link signatures). Not tenant data.
- **The support group is the trust boundary**: private, no invite links, no anonymous admins.
- **Keys derived from the bot token** (HMAC with a purpose label) for the webhook secret and the
  deep-link signature: one secret to manage, rotated with the token.
- **"Connect" for teams that outgrow it** is the Chatwoot Telegram inbox above: same bot, unset
  the `TELEGRAM_SUPPORT_*` variables.

Consequence: support content is processed by Telegram only (no self-hosted variant), and a busy
group hits Telegram's 20-messages-per-minute group limit (docs/support.md, "Limits").
