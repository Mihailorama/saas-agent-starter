# Known limitations / backlog

- **Onboarding: tour "seen" and checklist "dismissed" are per browser** (docs/onboarding.md,
  `apps/web/src/lib/onboarding.ts`). They live in `localStorage` to avoid a table and a migration,
  so a user on a second device sees the tour once more and the card again. If that bothers users:
  a nullable `user.onboarding_tour_seen_at` column (Better Auth `additionalFields`) set from the
  tour and read in the session; the checklist dismissal the same way or per organization.
- **MCP tools: admins type tool names; no "test connection"** (docs/mcp.md "Not covered"). The
  API never connects out. Fix: a small Temporal workflow (`ListMcpToolsWorkflow`) the settings
  page starts, returning the server's tool names through the SSRF pin; offer them as checkboxes.
- **MCP tools: no OAuth servers, no a11y/e2e coverage of the settings page** (flag off in e2e,
  like AI providers). Fix: OAuth via the SDK's client auth provider with tokens stored like the
  auth header; e2e with `VITE_FLAGS_ON=mcp-tools` on the consent build or a third dev server.
- **MCP: OAuth 2.1 sign-in for hosted connectors** (docs/mcp.md, ADR 0027). `/mcp` accepts only
  organization API keys as a bearer header; ChatGPT connectors and claude.ai custom connectors
  expect OAuth 2.1 (RFC 9728 protected resource metadata, PKCE, client registration). Better Auth
  can cover it: `@better-auth/mcp` (MIT, same 1.7.x line as `better-auth`) turns the app into an
  OAuth 2.1 authorization server and protected resource on top of `@better-auth/oauth-provider`
  (the old `oidc-provider` plugin is no longer in `better-auth` 1.7). To do: login/consent pages,
  choose the organization at consent (OAuth tokens are per user, keys per org), map OAuth scopes
  to `SCOPES` in tenant.ts, accept those tokens in `verifiedKey()` next to keys, and check
  `pnpm check:licenses`. Its README recommends `legacy: 'reject'` (2026-07-28 clients only):
  decide that against the clients customers use.
- **Agent protocols A2A, AP2 and UCP are not supported** (agent-to-agent, agent payments, agent
  commerce). Revisit when a customer needs one; MCP (docs/mcp.md) covers tool use.
- **Operator console: no Chatwoot link per user/organization** (docs/admin.md). The integration
  stores none (ADR 0013). If support wants one: read the contact by `identifier` (user id) through
  the Chatwoot API in the worker or API and link `/app/accounts/<id>/contacts/<contact id>`; verify
  the URL scheme against the deployed Chatwoot version first.
- **Operator console: a suspended org's owner who switched away cannot request its export/deletion**
  (`apps/api/src/operator-guard.ts` blocks `organization/set-active` into a suspended org;
  `/api/privacy/org/*` needs it active). Fix: let set-active into a suspended org through (every
  tenant route still answers 403) or give the privacy org routes an explicit org id checked
  against owner membership. Test in `apps/api/test/admin.test.ts`.
- **Operator console: the app DB login can `SET ROLE app_operator_read` / `app_operator_audit`**
  (ADR 0025): a SQL injection in the API could read every tenant or write org-less audit rows.
  Fix if the risk matters: a separate login for the console (`OPERATOR_DATABASE_URL`).
- **LiteLLM's dependencies fail the license gate (blocks CI of ADR 0024).** `pnpm check:licenses`
  rejects `jinja2`, `fastuuid`, `aiosignal`, `s3transfer`, `tokenizers`, `tiktoken`,
  `python-dateutil` (metadata the gate cannot map) and `regex` (`Apache-2.0 AND CNRI-Python`). No
  exception was added. Owner decision needed: amend ADR 0005 (classifier mapping + CNRI-Python),
  or move the LiteLLM route to the LiteLLM Proxy container (docs/adr/0024-llm-providers.md).
- **Billing page does not show the calls/tokens limit** of unmetered models (`llmUsageMonthly`,
  worker/billing.py `check_llm_usage`); the API's billing response and the web page only show the
  money limit. Add a usage block next to `llmSpend`, and an alert on
  `billing_llm_usage_blocked_total` like `LlmSpendLimitHit`.
- **Billing: usage reporting to provider meters** (docs/billing.md "Usage-based"). `metered`
  prices are sold at checkout, but the worker does not report `llm_cost_micros`, `llm_tokens` or
  `api_calls` to the provider's meters yet, so usage is not billed. Next PR (`billing-usage`): an
  idempotent `report_usage` activity, one meter event per `ai_calls` id, batched per org.
- **Billing: prepaid credit packs** (docs/billing.md "Pricing models"). Next PR
  (`billing-credits`): a `credits` price model, top-up checkout, Stripe credit grants after
  payment, balance check in the gateway.
- **llm-cli limits are per process** (services/llm-cli/src/pool.ts): run one replica. If one is not
  enough, move the per-subscription counters and cooldowns to Redis.
- **vLLM CPU path not verified end to end.** On the dev host (AVX2 only, load ~25) the
  `local-llm-cpu` container loaded SmolLM2-135M and allocated its KV cache, then stalled before
  serving (2026-11-07); the vLLM route is tested against an OpenAI-compatible mock only. Retry on
  an AVX-512 host or a GPU box.

- **2FA/passkey audit rows are not atomic with the change** (`apps/api/src/mfa.ts`): written
  after Better Auth commits, so a crash in between loses the row. Fix if it matters: Better Auth
  database hooks inside its transaction once they cover plugin models.
- **Transactional outbox for workflow starts.** `POST /api/projects` starts the Temporal
  workflow after commit; if Temporal is unreachable at that moment the start is logged and lost
  (`apps/api/src/routes/projects.ts`). Fix: write an outbox row in the same transaction and have a
  small relay start workflows from it (still idempotent via the workflow id).
- **Attachment upload confirmation.** The attachment row is created before the browser uploads
  the bytes, so an abandoned upload leaves a row without an object. Fix: add `uploaded_at`, set it
  from a `POST .../attachments/:id/complete` that HEADs the object, and hide/expire rows without it.
- **osv-scanner ignore for `@opentelemetry/core` 1.x** expires 2027-02-01 (`osv-scanner.toml`).
  Remove it once `@temporalio/interceptors-opentelemetry` depends on OpenTelemetry 2.x.
- **AI calls export loads all rows in memory** (`apps/api/src/routes/ai-calls.ts`). Fine for
  thousands of rows; stream with a server-side cursor before orgs reach ~100k calls.
- **`audit_log` is not append-only** for the app role, unlike `ai_calls`. Consider adding it
  to the append-only list in `packages/db/src/migrate.ts` (check nothing updates it first).
- **Alert notifications.** Prometheus evaluates the rules but nothing routes them. Fix: add
  Alertmanager (Apache-2.0) to the observability profile with a receiver per deployment.
- **Collector reads every container's log file on the host** (filtered to this compose project
  by label). Fine on a dedicated host; on a shared Docker host consider the Docker `fluentd`/OTLP
  log driver per service instead, so other projects' files are never opened.
- **Browser errors are not linked to backend traces.** The web app has no OpenTelemetry, so
  GlitchTip/Sentry browser events carry the SDK's own trace id. Fix if needed: browser OTel with
  `traceparent` on `/api` calls, or tag events with the `trace_id` the API now returns in the
  `x-trace-id` response header (already used by the analytics `api_error` event).
- **`@sentry/node` 11 pulls the FSL-licensed `sentry` CLI** via `@sentry/bundler-plugins`, so the
  API uses `@sentry/node-core` 10. Revisit when a `@sentry/node-core` 11 is published or the CLI
  becomes optional upstream.
- **Temporal server traces are not exported** (only its metrics are scraped); the Temporal SDK
  spans in the API and worker cover workflow/activity timing. Enable the server's OTEL env vars
  if server-side spans are needed.
- **Alerting on the Umami tier.** Umami has no alerts or outgoing webhooks, so on-prem/RU
  deployments without PostHog get no `cjm-regression` issue. Grafana is in the observability
  profile: add a PostgreSQL datasource for the `umami` database next to the existing ones in
  `infra/grafana/provisioning/datasources/datasources.yaml` (read-only role), and one Grafana
  alert rule per journey (provisioned under `infra/grafana/provisioning/alerting/`, generated by
  `pnpm journeys:sync` from `config/journeys.json`): first-to-last-step conversion over Umami's
  `website_event` table below `minConversion`. Route it with a webhook contact point to
  `apps/api/src/routes/hooks.ts`, extended to accept Grafana's alert payload and open the same
  `cjm-regression` issue. Until then run `pnpm journeys:report --json` on a schedule
  (docs/product-analytics.md).
- **Feedback channel on the Umami-only tier.** Covered when the service desk is configured: the
  Chatwoot Help menu takes reports on every tier (docs/support.md). Without Chatwoot it remains:
  PostHog Surveys provide "report a problem /
  suggest an improvement"; Umami has no surveys and GlitchTip only implements Sentry's
  crash-report dialog (reports attached to an error; its Sentry User Feedback widget support
  was broken, glitchtip-backend issues #403/#468). Re-check GlitchTip's user feedback support
  (or Umami's error tracking, announced for v3.5.0) before building anything.
- **PostHog `$ai_generation` events from the worker.** Thumbs feedback in PostHog AI
  observability attaches to `$ai_trace_id`, but the worker sends no generations to PostHog, so
  the trace is empty there (Langfuse gets it through OpenTelemetry). To add: in
  `services/worker-py/worker/ai.py`, after each call, capture `$ai_generation` with
  `$ai_trace_id` = the OTel trace id, `$ai_model`, `$ai_provider`, `$ai_input_tokens`,
  `$ai_output_tokens`, `$ai_latency`, cost, and **no** `$ai_input`/`$ai_output_choices`
  (privacy mode; ADR 0008 keeps content in S3 only). Needs the `posthog` Python package
  (run it through the license gate), and a `POSTHOG_PROJECT_KEY`/`POSTHOG_HOST` env on the worker.
- **PostHog alert webhooks via hog functions** (`scripts/journeys.mjs`) follow PostHog's UI
  flow, not a documented API. Verify against a real project once the owner has keys; fall back
  to adding the webhook in the alert UI if the API rejects it.
- **Backups: off-site storage and alert routing are deployment steps.** The backup overlay
  (`compose.backup.yaml`, docs/backups.md) defaults to `backup-s3` on the same host, which does
  not survive losing that host. Each deployment must set `BACKUP_S3_*` to another provider or
  region, store `BACKUP_ENCRYPTION_PASSPHRASE` off the server, and route the `backups` alerts
  (Alertmanager, see "Alert notifications" above).
- **Production SeaweedFS fits only two buckets.** `s3` in `compose.prod.yaml` (profile `s3`)
  runs with SeaweedFS's default `-volume.max` (14 volume slots); each bucket takes 7, so a third
  bucket (e.g. Chatwoot's or Langfuse's, if run there) gets HTTP 500 on its first upload. The
  dev `s3` in `docker-compose.yml` sets `-volume.max=64`; do the same in production, sized to
  the disk (`-master.volumeSizeLimitMB` caps each volume, default 30 GB).
- **Backups: a second repository.** pgBackRest supports `repo2` (e.g. a second provider or
  object-locked bucket). Add `PGBACKREST_REPO2_*` to `compose.backup.yaml` if one off-site copy is
  not enough; the restore check would then also need a run per repository.
- **Backups: Grafana dashboard.** Backup and restore-check metrics only have alert rules
  (`infra/otel/alerts.yml`); a `backups` dashboard (last backup age, WAL archive lag, restore
  check duration) would help operators. Build it per AGENTS.md "Add a dashboard".
- **Short downtime on single-host deploys.** `docker compose up` recreates `api`/`web` in place
  (seconds without the API; Caddy only holds requests to `web`). Zero-downtime on one host needs
  two `api` replicas and a health-aware switch (e.g. a blue/green project pair behind Caddy).
  Tier L on Kubernetes gets rolling updates. docs/deploy.md "Tiers".
- **No Helm chart for tier L / customer clusters.** What it needs is listed in docs/deploy.md
  "Kubernetes / Helm" (migrate as pre-upgrade hook Job, probes, Ingress + cert-manager, secrets).
- **Production observability.** `compose.prod.yaml` has no observability profile; the dev one
  (`docker-compose.yml`) mounts repo files and runs Grafana without login. Add a production
  variant (authenticated Grafana behind Caddy, retention) or document an external backend.
- **Release images are linux/amd64 only** (`.github/workflows/release.yml`). Add
  `--platform linux/amd64,linux/arm64` (and QEMU/arm runners) when an arm64 host is needed.
- **SSH transport of `scripts/deploy.mjs` is not exercised by the rehearsal** (it uses
  `DEPLOY_HOST=local`, same script on `sh -s` instead of `ssh host sh -s`). Run the first real
  deploy to a staging host and note the result in docs/deploy.md.
- **Social mentions into the service desk (later, only if volume appears).** X and LinkedIn
  mentions of the product do not reach Chatwoot. When there is enough volume to matter: a
  scheduled Apify actor (one per network) that posts new mentions into a Chatwoot **API inbox**
  (`POST /public/api/v1/inboxes/{identifier}/contacts/.../conversations/.../messages`), so they
  get the same triage as every other channel (docs/support.md). Do not build it before then.
- **Support triage start is not transactional.** `POST /api/hooks/chatwoot` starts
  `SupportTriageWorkflow` directly; if Temporal is down at that moment the triage is lost, and
  Chatwoot does not retry account webhooks (`apps/api/src/routes/support.ts`). Same fix as the
  project workflow outbox above, or a periodic sweep for conversations without
  `support_category`.
- **Online LLM judges have nothing to judge yet** (ADR 0009 "Open"). PostHog privacy mode is on
  by default and our spans carry no prompt/output text, so PostHog and Langfuse evaluators
  (`pnpm llmops:evaluators`) see empty input/output; both tools also need an LLM provider API key
  stored in the tool. Owner decides: privacy mode off for PostHog (DPA), and/or opt-in content on
  the spans exported to the self-hosted Langfuse only (e.g. `gen_ai.input.messages` /
  `gen_ai.output.messages` behind a flag, on a span processor used only for the Langfuse
  exporter), plus which provider key.
- **PostHog evaluation request is unverified against a live project.** `scripts/llmops-evaluators.mjs`
  follows the API reference example (`output_type: boolean`, `model_configuration`,
  `conditions` on `ai_purpose`); run `--apply` once with the owner's personal API key and check the
  evaluation in the UI, then fix the body if PostHog rejects or reinterprets a field.
- **`pnpm eval:real` may see the operator's Claude Code memory.** `--bare` would drop it but also
  disables subscription auth. Run it from an account without steering CLAUDE.md, or switch to a
  `--settings`/env option if Claude Code adds one that skips memory with OAuth.
- **Open owner decision: does the small single-server tier run Langfuse?** (ADR 0009). PostHog
  Cloud is the default; Langfuse costs about 1.9 GiB RAM measured (docs/STACK.md).
- **Mailed links live in Temporal history.** `SendEmailWorkflow` gets the rendered mail, link
  included, as its argument (`apps/api/src/temporal.ts`), kept until the namespace retention
  drops it. Same trust boundary as Better Auth's `verification` table while Temporal runs on our
  Postgres server; with Temporal Cloud or a separate cluster, add an encrypting `PayloadCodec`
  on the API client and the worker (key from env) for the `email` queue (ADR 0014).
- **Bounce/complaint webhooks.** Providers keep their own suppression lists (docs/email.md);
  nothing in the app reacts to hard bounces or spam complaints. When volumes grow, accept the
  provider's webhook in `apps/api/src/routes/hooks.ts` and alert on bounce rate.
- **No "invite member" UI.** Invitations are sent through Better Auth's
  `organization.inviteMember` API (tested in `apps/api/test/api.test.ts`) and accepted on
  `/accept-invitation/$invitationId`, but the web has no members page to send them from. Add one
  under the shell (list, invite form, role) when member management is needed.
- **Mail language is the request's `Accept-Language`.** Users have no stored locale, so an
  invitation is written in the inviter's browser language. Store a locale on the user (and
  pass it for invitations) when the web gets i18n; strings move to i18next then
  (`apps/api/src/email.ts`).
- **LLM spend rollup.** The spend check sums `ai_calls` per call (index range scan). Past
  ~1M calls per org per month, add a monthly rollup row written in the gateway's insert
  transaction (ADR 0019 "Alternatives").
- **Webhook deliveries lost if Temporal is down at publish time** stay `pending` until a
  replay (`apps/api/src/events.ts` `flushEvents`). The transactional outbox above covers it:
  relay pending deliveries whose workflow never started.
- **Self-hosted Svix app portal.** Re-check svix/svix-webhooks#2026 (open-source the consumer
  portal). If it lands, switch delivery to Svix behind `publishEvent()` (ADR 0018) and replace
  the delivery UI with the portal.
- **PostHog personless `$ai_generation` events may survive a user deletion.** The worker sends
  them with `distinct_id` = user id and `$process_person_profile: false`
  (`services/worker-py/worker/posthog.py`). `persons/bulk_delete` deletes the events of persons it
  finds; for a user who never consented in the web there is no person, and PostHog documents no
  event deletion by distinct id. Verify against a real project; if they remain, send these events
  with `distinct_id = org:<orgId>` (the trace id still links feedback) or a per-call id.
- **GA4 deletion covers only the requesting browser.** The web sends no user id to GA4, so
  `submitUserDeletion` gets the client id of the browser the deletion was requested from
  (`apps/web/src/lib/analytics.ts` `gaClientId`). Other browsers of the same person keep their
  events until GA4's retention. Fix if needed: set GA4 `user_id` to a pseudonymous id after
  consent and delete by `userId` (docs/privacy.md, "Per-tool support").
- **GA4 has no per-user export.** The export README lists it as not supported; a BigQuery export
  filtered by `user_pseudo_id` is the only route. Add it only if a deployment uses BigQuery export.
- **Privacy tool adapters are unverified against live tools** (`services/worker-py/worker/privacy.py`):
  they follow the vendor docs and source (docs/privacy.md, checked 2026-11-07) and are tested with
  HTTP mocks only. Run one export and one deletion against a real PostHog, Langfuse, Chatwoot and
  GA4 property once the owner has keys, and note the result in docs/privacy.md.
- **Export ZIP is built in memory** (`build_export`): fine for exports up to a few hundred MB.
  Stream to a temporary file and use multipart upload when organizations store more files.
- **Every organization is visited for a user's export/deletion and the AI-content retention**
  (`PrivacyActivities._org_ids`, one RLS transaction each). Fine for thousands of organizations;
  for more, keep a per-user list of organizations they ever acted in, or batch by org.
- **IndexNow is not wired into a deploy job.** `pnpm seo:indexnow --since <previous sha>` exists
  (docs/marketing.md) but nothing calls it: `scripts/deploy.mjs` ships the app images only and the
  site deploys separately (docs/deploy.md). Fix: when the site gets a deploy job (or a `site`
  service in `compose.prod.yaml` behind Caddy), run it after a successful deploy with the
  previously deployed sha and `INDEXNOW_KEY`.
- **GEO check covers Claude only.** `scripts/geo-check.mjs` asks one assistant. If buyers use
  others, add a runner per assistant CLI the team is logged in to (same config, same report),
  never an API key in CI.
- **Postiz idle cost.** ~1.2 GiB RAM and ~20 % of a core at rest (docs/STACK.md). Re-measure on
  each Postiz upgrade. Untested lever: Postiz's `EXCLUDE_QUEUE` env (comma-separated provider
  task queues this server does not poll) listing the networks you do not use; measure before and
  after in docs/STACK.md, and never exclude a network you post to.
- **Data-subject rights do not reach Cal.diy's bookings** (2026-11-07; docs/privacy.md, docs/crm.md
  "Privacy"). Attendee name, email and answers live in Cal.diy's database; its web container has
  no API for them (API v2 is a separate server we do not run), so an operator deletes them in
  Cal.diy's UI. Options: run Cal.diy's API v2 in the `booking` profile and add a privacy `Tool`
  (bookings by attendee email: export, cancel + delete), or a reviewed SQL step against the
  `caldiy` database (couples us to its Prisma schema; pin to the commit). Same gap for Cal.com
  Cloud (its own deletion process).
- **Cal.diy image build on every CI run** (`caldiy-image`, 20-40 minutes). Add a layer cache
  (buildx + GHA cache) or run the job only when `infra/caldiy/` or the compose files change, if
  the runner minutes matter.
- **Twenty leftovers after a deletion** (docs/privacy.md "Twenty"): notes people wrote on the
  person stay (unlinked) and Twenty's record history (timeline activities) was not checked on a
  live Twenty; verify, and if it keeps the email, delete those entries through the REST API too.
- **Permissive CRM twin.** `compose.permissive.yaml` only disables Twenty (AGPL); the sync then
  dry-runs. Evaluate Krayin (MIT, Laravel) or Atomic CRM (MIT) behind the `Crm` protocol
  (`services/worker-py/worker/crm.py`) if an AGPL-free delivery needs a CRM.
- **Twenty attachments are not backed up** (`twenty-data` volume, `STORAGE_TYPE=local`,
  docs/backups.md). Point Twenty at a bucket in `BACKUP_APP_BUCKETS` once attachments matter.
- **Pages not yet on the UI patterns.** `ai-calls`, `api-keys`, `webhooks`, `security`,
  `billing`, `sign-in` and `two-factor` still use hand-written headers, native `<select>`,
  `<input type="checkbox">` and `<textarea>` and their own empty/error markup. They pass axe, but
  new pages copy what they see. Fix: move each to `PageHeader`, `QueryView`/`DataTable`,
  `EmptyState`, `Select`/`Checkbox`/`Textarea` and `SettingsSection` (docs/ui.md), one page per PR,
  keeping the e2e selectors (labels, roles) unchanged.
- **`/sign-in` Lighthouse performance ~0.79** (reported, not enforced, in
  `apps/web/lighthouserc.cjs`). Routes and the command palette are code-split since 2026-11-07
  (entry JS 212 kB compressed, budget 230 kB enforced), yet total blocking time is still ~440 ms
  on desktop; `/ai-transparency` scores 1.0. Fix: profile the sign-in boot (Sentry, analytics,
  cookie banner, Better Auth client) and defer what is not needed before first input, then raise
  the performance assertion to `error` at 0.9.
- **Plane Python SDK search has no `project_id`/`limit` params** (`plane-sdk` 0.3.2,
  `WorkItems.search`; `RetrieveQueryParams` ignores extra fields). `worker/tracker.py` passes them
  through a small `RetrieveQueryParams` subclass and also filters hits by project. Ask upstream
  for the params and drop `_SearchParams` once a release has them (AGENTS.md: no patches).
- **Tracker has no end-to-end run against a real Plane** (2026-11-07). The adapters are tested
  against fakes built from Plane's docs and Community Edition source (Intake create + label PATCH,
  search skipping triage items, v1/v2 webhooks). Before relying on it, run the live smoke run
  (docs/support.md "Live smoke run": `python -m worker.tracker smoke`) against the `STARTERDEMO`
  test project (Cloud and self-hosted CE) and check labels, Intake placement, the release
  comment's author check (`users/me`) and the return-path notes. Needs a Plane token.
- **Bot check on sign-up (captcha), not wired yet** (docs/security.md "Sign-up protection",
  2026-11-08). Disposable addresses are refused; scripted sign-ups with real-looking addresses
  are only rate-limited. Better Auth's `captcha` plugin (`better-auth/plugins`) supports Cloudflare
  Turnstile, reCAPTCHA, hCaptcha, CaptchaFox and Vercel BotID, server side in a few lines; it needs
  the provider widget on `apps/web/src/pages/sign-in.tsx` (header `x-captcha-response`) and the
  provider's origins in the web CSP. Plan: default off, env-only "connect" (`CAPTCHA_PROVIDER`,
  `CAPTCHA_SECRET_KEY`, `VITE_CAPTCHA_SITE_KEY`) for Turnstile/hCaptcha. Self-hosted "install"
  path: ALTCHA (MIT, proof of work) has no Better Auth provider; it would be a small own
  `hooks.before` verifying the ALTCHA payload with its library, check its license and
  maintenance first.
