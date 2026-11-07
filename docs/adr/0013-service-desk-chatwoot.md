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
- **Backlog items live in the tracker**: GitHub Issues by default (reusing the labels and
  conventions of the PostHog hook, ADR 0012), Plane Intake optionally (`SUPPORT_TRACKER=plane`),
  so new items wait for a human to accept them.
- **No link table**: the conversation URL goes into the issue (body or "+1" comment), the issue
  URL into the conversation's `tracker_issue_url` custom attribute. Both survive without us.
- **Triage is a Temporal workflow in the Python worker** (`SupportTriageWorkflow`, id per
  conversation, `REJECT_DUPLICATE`), started by a signed Chatwoot webhook
  (`X-Chatwoot-Signature`, HMAC-SHA256 over timestamp and raw body). The worker reads the text
  from Chatwoot; workflow arguments are ids only. It classifies through the existing AI gateway
  (purpose `support.triage`, versioned prompt files, `ai_calls` audit under the operator's
  `SUPPORT_AI_ORG_ID`), files or "+1"s the tracker item and writes **one private note**. It never
  replies to a customer. A draft answer for questions is a note for an agent to review.
- **Return path**: signed GitHub (`X-Hub-Signature-256`) and Plane (`X-Plane-Signature`)
  webhooks start `SupportIssueClosedWorkflow`, which notes the outcome in every linked
  conversation; a customer message only with `SUPPORT_NOTIFY_ON_CLOSE=true` and only for items
  closed as done.
- **Widget identity**: `GET /api/support/identity` returns the user id and
  `HMAC-SHA256(CHATWOOT_HMAC_TOKEN, id)`; the inbox enforces identity validation. The widget is
  loaded with Chatwoot's own `sdk.js` (no npm dependency), only when the user opens Help.
- **One entry point**: with the widget configured, the PostHog "Report a problem" feedback tab
  is not created; AI-answer thumbs stay in PostHog / Langfuse (ADR 0012).
- Everything is env-driven and off by default: no env, no Help entry, no request, endpoints
  answer 401/404, the worker logs dry runs.

Picks that are not obvious, one line each:

- Own pgvector Postgres for Chatwoot: its schema enables `vector`; the stack's
  `postgres:17-alpine` has no pgvector, and changing the app's database image for a profile
  would affect every deployment.
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

- New infra containers: `chatwoot/chatwoot` (MIT, `-ce` only) and `pgvector/pgvector`
  (PostgreSQL License), listed in docs/LICENSES.md and covered by `pnpm sbom` (all profiles).
  Measured ~1.0 GiB idle, ~1.2 GiB under load for the profile (docs/support.md).
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
