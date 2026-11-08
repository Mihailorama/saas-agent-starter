# saas-agent-starter

Multi-tenant SaaS starter built for AI-agent coding (Claude Code, Codex): strict types,
one-command quality gate, small colocated files and an `AGENTS.md` that tells agents
exactly how to add things. Secure by default. Licensed **MIT-0**: no attribution, no
obligations: every code dependency is permissive or MPL-2.0, used unmodified (enforced in CI).

**From a fresh VPS to a running stack in one command** ([docs/setup.md](docs/setup.md)):

```sh
pnpm i && pnpm run infra     # server, domain, then install / connect / skip per component
```

It asks for SSH access to a Debian/Ubuntu server, the domain, and for each component (Postgres,
S3, SMTP, analytics, LLM provider, secrets vault) whether to install it on the server, connect
one you already have, or skip it. Then it prepares the server (Docker, a deploy user, firewall,
key-only SSH), writes the settings encrypted with sops, deploys and checks every component.
Re-runs show a plan first and keep what was generated. Needs Node, OpenSSH, `sops` and `age` on
your machine, no Docker. **Back up the age key it creates**: it decrypts every secret.

- **API**: TypeScript, Fastify, Zod, OpenAPI, Better Auth (passwordless sign-in with email
  one-time codes, orgs, roles, 2FA, passkeys, SSO), Drizzle + Postgres
  Row-Level Security, audit log, Redis-backed rate limits, S3 presigned uploads.
- **Web**: React, Vite, TanStack Router/Query/Table, shadcn/ui, dark mode; a UI kit of shadcn/ui
  components and page patterns (app shell, data table, forms, empty/loading/error states,
  command palette), a dev gallery, and CI checks for accessibility, visual regressions and
  design anti-patterns ([docs/ui.md](docs/ui.md)).
- **Workflows**: Temporal; Python worker (uv, ruff, pyright, pytest) for AI/data work,
  Rust hot paths via PyO3 with a pure-Python fallback.
- **AI layer**: one logged gateway for every LLM call (Anthropic, any OpenAI-compatible
  endpoint), model registry per contour, append-only `ai_calls` audit table, OpenTelemetry
  GenAI spans, human confirm/correct, admin log + JSONL export, `/ai-transparency` page.
  See [docs/ai-act.md](docs/ai-act.md) for what this does and does not cover.
- **Billing**: plans with limits in `config/plans.json`, prices per currency, Stripe behind a
  swappable provider interface (one provider per contour), webhooks via Temporal, per-org LLM
  spend limit enforced in the AI gateway. See [docs/billing.md](docs/billing.md).
- **Public API**: organization API keys with scopes (Better Auth API key plugin), per-key
  rate limits, OpenAPI; outbound webhooks signed per Standard Webhooks, retried by Temporal,
  with delivery attempts and replay in the UI ([docs/public-api.md](docs/public-api.md)).
- **MCP server**: customers' AI agents (Claude, ChatGPT, Gemini, Cursor) use the product at
  `/mcp` with an API key; tools wrap the REST routes, behind a flag ([docs/mcp.md](docs/mcp.md)).
- **Product analytics**: typed event catalog + `track()`, consent banner, journeys as code
  synced to PostHog (default) or self-hosted Umami, alerts and user feedback as GitHub issues.
- **Service desk**: Chatwoot CE (`support` profile) behind one Help menu, plus email and
  Telegram; AI triage writes private notes and files or "+1"s GitHub / Plane Intake items, and
  closed items are reported back to the conversation.
- **CRM and booking**: Twenty (`crm` profile) gets people, companies, subscription deals, product
  signals and support/booking notes from Temporal workflows; "Book a demo" / "Talk to us" on a
  self-hosted Cal.diy (`booking` profile) or one you connect ([docs/crm.md](docs/crm.md)).
- **Secrets vault for agents**: Vaultwarden (`vault` profile) or a Bitwarden you connect; coding
  agents read and save credentials through `scripts/vault.mjs` and the `bw` CLI instead of chat,
  `.env` files or git ([docs/secrets.md](docs/secrets.md)).
- **Idea validation**: `/validate-idea` in Claude Code chains an opt-in, pinned founder-skill plugin
  (board, competitors, buyer panel, pricing, CFO), adds SaaS unit economics and ends with a waitlist
  page, price survey and interview plan ([docs/validate-idea.md](docs/validate-idea.md)).
- **Ops**: Docker Compose locally; production from versioned images (GHCR, by digest) with
  Caddy auto-TLS, SOPS-encrypted env files and one-command deploy/rollback over SSH, Coolify or
  Kubernetes as options ([docs/deploy.md](docs/deploy.md)), OpenTelemetry everywhere,
  `observability` profile (Grafana + Loki + Prometheus + Jaeger, logs linked to traces,
  dashboards, alert rules), Sentry-protocol error tracking (GlitchTip profile), a
  permissive-license twin of the whole stack, SBOMs + third-party notices, CI with gitleaks,
  osv-scanner, CodeQL, Dependabot.

## 5-minute quickstart

Prerequisites: Docker, Node 22.18+ with pnpm (`corepack enable`), [uv](https://docs.astral.sh/uv/),
Rust via [rustup](https://rustup.rs) (for the worker extension and the full gate).

```sh
docker compose up -d --wait postgres redis s3 temporal-ui mailpit
pnpm i
pnpm db:migrate
pnpm dev                 # web http://localhost:5173, API http://localhost:3000
pnpm worker              # in a second terminal: Python Temporal worker
```

Open http://localhost:5173 and create an account; the confirmation mail is in Mailpit at
http://localhost:8025 ([docs/email.md](docs/email.md)). Then create an organization and a project. The project's
fingerprint appears a moment later: the API started a Temporal workflow, the Python worker
computed it with the Rust extension and wrote it back. Watch it in the Temporal UI at
http://localhost:8233. API schema: http://localhost:3000/openapi.json.

Everything in containers instead: `docker compose up -d --build`, then http://localhost:8080.

### Logs, traces, metrics, errors

```sh
# in .env (compose reads it):
API_OTEL_ENDPOINT=http://otel-collector:4318
WORKER_OTEL_ENDPOINT=http://otel-collector:4318
docker compose --profile observability up -d --build
```

Grafana http://localhost:3001 (no login, local only): dashboards API, Temporal server, Worker,
LLM; Explore -> Loki for logs (`{service_name="api"}`), each line with a `trace_id` links to
its trace. Jaeger http://localhost:16686, Prometheus http://localhost:9090 (alert rules at
`/alerts`). Resource budget: [docs/STACK.md](docs/STACK.md).

Error tracking (GlitchTip, Sentry-compatible): `docker compose --profile glitchtip up -d`,
open http://localhost:8000, sign up, create an organization `local` and projects (Node.js for the API, Python for the worker, JavaScript for the web app), then set their DSNs in `.env`
(`API_SENTRY_DSN` / `WORKER_SENTRY_DSN` with host `glitchtip:8000`, `WEB_SENTRY_DSN` with
`localhost:8000` plus `WEB_SENTRY_ORIGIN=http://localhost:8000`) and rebuild with
`GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build api worker web`. For Sentry
use its DSNs instead. `GET /api/debug/error` (non-production only) throws a test error.
Browser source maps (not uploaded by default): build with `vite build --sourcemap hidden`, then
`glitchtip-cli sourcemaps inject ./dist` and `glitchtip-cli sourcemaps upload ./dist --org <org>
--project web` (Sentry: `sentry-cli sourcemaps inject` / `upload`), and delete the `.map` files
before building the image. Both CLIs are separate tools, not dependencies (`sentry-cli` is
FSL-licensed).

Backups (pgBackRest WAL archiving + full/diff, encrypted copy of the app buckets, weekly
automatic restore check, alerts): `COMPOSE_FILE=docker-compose.yml:compose.backup.yaml` in
`.env`, then `pnpm run backup:now` / `pnpm run restore`. Runbook: [docs/backups.md](docs/backups.md).

Permissive-license twin (no AGPL/SSPL containers: Valkey instead of Redis, no Loki/Grafana):
`docker compose -f docker-compose.yml -f compose.permissive.yaml --profile observability up -d`.
What changes: [docs/LICENSES.md](docs/LICENSES.md#permissive-twin-replacement-map).
SBOMs (CycloneDX, per image) + `THIRD_PARTY_NOTICES.md`: `pnpm run sbom` -> `dist/sbom/`.

## Quality gate

```sh
cargo install --locked cargo-deny   # once
pnpm check
```

Format, lint, typecheck, tests (TS, Python, Rust; integration tests hit the real compose
services, including a test proving tenant A cannot read tenant B even with a buggy query),
license gate across npm, PyPI and crates.io, and Playwright end-to-end tests with axe
accessibility checks.
`pnpm bench` prints the Rust vs Python speedup of the example hot path.

## UI

`pnpm dev`, then http://localhost:5173/dev/ui: every component and pattern of the kit in light
and dark, plus reference screens (list, detail, form, settings, empty, loading, error) in the
app shell. Build new screens from them; [DESIGN.md](DESIGN.md) has the tokens and rules,
[docs/ui.md](docs/ui.md) the screen checklist. CI checks every page with axe (WCAG 2.2 AA, light
and dark), compares screenshots with a baseline from `main` (kept as a workflow artifact, not in
git; accept an intended change with the `visual-change-approved` label), runs Lighthouse on the
public pages and the [impeccable](https://github.com/pbakaus/impeccable) design detector.
Agents with the impeccable skill installed read [PRODUCT.md](PRODUCT.md) and DESIGN.md.

## Deploy

Tag a release (`git tag v1.0.0 && git push origin v1.0.0`): CI pushes the images to GHCR. Then
`pnpm run deploy -- production --version v1.0.0` runs migrations, starts the stack behind Caddy
with automatic HTTPS and checks health; `pnpm run deploy -- production --rollback` goes back to
the previous digests. Setup, secrets, other targets: [docs/deploy.md](docs/deploy.md).

## Configuration

All config is environment variables, validated at startup (the API exits on invalid config).
See `.env.example`; put local overrides in `.env` (gitignored). In production set at least
`NODE_ENV=production`, a random `BETTER_AUTH_SECRET` (32+ chars), `BETTER_AUTH_URL`,
`SMTP_URL` + `MAIL_FROM` for the worker (provider choices and DNS setup:
[docs/email.md](docs/email.md)), `DATABASE_URL` (restricted app role) and `MIGRATION_DATABASE_URL` (schema owner, used only by
`pnpm db:migrate` / the `migrate` container), `REDIS_URL`, `TEMPORAL_ADDRESS`, and `S3_*`
(omit `S3_ENDPOINT` for AWS S3).

## AI

Off until you pick a model. The default mode is a vendor CLI subscription: put a Claude Code
login token in `.secrets/llm-cli/claude-1.token` (`claude setup-token`), start the `llm-cli`
container and set `AI_PROJECT_SUMMARY_PROVIDER=claude_cli`,
`AI_PROJECT_SUMMARY_MODEL=claude-haiku-5-5`. Any other provider works the same way: API keys
(Anthropic, OpenAI, Gemini, xAI, Moonshot), OpenRouter, a custom OpenAI-compatible endpoint, or
self-hosted vLLM/Ollama (`--profile local-llm`); organizations can bring their own key. Pick a
provider/model registered for your `AI_CONTOUR` in `config/ai-models.json`, then restart the
worker ([docs/llm-providers.md](docs/llm-providers.md)). New projects with a description get an
AI-generated summary that members can confirm or correct; admins see every call under
"AI calls". Design: [ADR 0008](docs/adr/0008-ai-layer.md).

## Product analytics

Off until you set env. PostHog Cloud (EU or US) is the default: `VITE_POSTHOG_KEY` and
`VITE_POSTHOG_HOST` for the web, then `pnpm journeys:sync` turns `config/journeys.json` into
funnels, alerts, a feedback survey and webhooks that open GitHub issues for agents. Data must
stay in place (on-prem, RU)? `docker compose --profile analytics up -d` runs Umami (MIT) on the
same Postgres. Optional, consent-gated: GA4, Yandex Metrika. AI-answer thumbs go to PostHog AI
observability and/or Langfuse. Events are catalogued in `config/events.json` and checked in CI.
Details: [docs/product-analytics.md](docs/product-analytics.md).

## Service desk

Off until you set env. `docker compose --profile support up -d` runs Chatwoot (MIT core, `-ce`
image) on the stack's Postgres (own database) and S3 (own bucket), so backups cover it. Set the
website inbox token and HMAC token for the Help menu, the webhook secret for triage, and a model
for `support.triage`; tickets stay in Chatwoot, backlog items go to GitHub Issues or Plane Intake. No ticket table of our own.
Details: [docs/support.md](docs/support.md).

## CRM and booking

Off until you set env. `docker compose --profile crm up -d` runs Twenty (AGPL, unmodified) on the
stack's Postgres and Redis, or connect a Twenty you already run or Twenty Cloud; with
`TWENTY_API_URL`/`TWENTY_API_KEY` and `pnpm crm:sync`, verified sign-ups,
organizations, billing changes, PostHog product signals, Chatwoot conversations and bookings land
there, one idempotent workflow per source event. No CRM tables of our own. Booking runs on Cal.diy
(MIT, the open-source successor of Cal.com): `docker compose --profile booking up -d` with the image
CI builds from a pinned commit, or connect an existing Cal.diy or Cal.com Cloud by env. Details:
[docs/crm.md](docs/crm.md).

## LLM-ops

Quality loop ([ADR 0009](docs/adr/0009-llm-ops.md)): prompts are versioned files in `prompts/`;
`pnpm eval` runs the Promptfoo golden sets in `evals/` (key-free; `pnpm eval:real` runs the real
model and judge through your Claude subscription via the `claude` CLI); with `POSTHOG_KEY`
and `POSTHOG_HOST` the worker sends every call to PostHog AI observability (privacy mode on), so
the AI-answer thumbs land on a real generation; online LLM-as-a-judge runs in PostHog or Langfuse
(`pnpm llmops:evaluators`). `docker compose --profile llmops up -d` runs Langfuse self-hosted
(about 1.9 GiB RAM, see [docs/STACK.md](docs/STACK.md)).

## Marketing: site, SEO, social posting

`apps/site` is an Astro static site and Markdown/MDX blog with the SEO basics built in (canonical,
hreflang, Open Graph, schema.org JSON-LD, sitemap, robots.txt, RSS, `llms.txt`), the web app's
design tokens and analytics, and Lighthouse budgets in CI: `pnpm --filter site dev`.
`docker compose --profile marketing up -d` adds Postiz (social posting) and SerpBear (rank
tracking); `pnpm seo:report` (Search Console), `pnpm seo:indexnow` (Bing/IndexNow after a deploy)
and `pnpm geo:check` (is the product named in AI answers?). Details:
[docs/marketing.md](docs/marketing.md).

## Feature flags and releases

New behaviour ships behind PostHog feature flags declared in `config/flags.json`
(`pnpm check:flags`, `pnpm flags:sync`); without PostHog a flag is its catalog default or
`FLAGS_ON`/`FLAGS_OFF`. PR titles are Conventional Commits; release-please keeps a release PR
with `CHANGELOG.md`, and each release comments "Released in vX.Y.Z" on the issues it closed.
Details: [docs/feature-flags.md](docs/feature-flags.md), [docs/releases.md](docs/releases.md).

## SSO

- **OIDC** (any provider: Authentik, Okta, Entra ID, Google Workspace, Keycloak...): set
  `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and restart the API. The sign-in page
  then shows "Sign in with SSO" (Better Auth's generic OAuth plugin, provider id `oidc`,
  authorization code + PKCE S256; on the client: `authClient.signIn.social({ provider: 'oidc' })`).
  Register this redirect URI at the IdP: `${BETTER_AUTH_URL}/api/auth/callback/oidc`.
  First SSO login creates the user; they then create or are invited to an organization like any
  other user. Accounts are not auto-linked to an existing email-code user unless the IdP
  sends `email_verified: true`.
- **SAML** or per-organization IdPs: add Better Auth's `@better-auth/sso` plugin to
  `apps/api/src/auth.ts`, regenerate the auth schema and run `pnpm db:generate`.
- Sign-up protection: disposable email domains are refused at sign-up, SSO and invitations
  (`SIGNUP_BLOCK_DISPOSABLE`, allow/deny lists): [docs/security.md](docs/security.md).
- Need a standalone IdP instead (user federation, admin console)? Run Keycloak and connect it
  over OIDC as above. See `docs/adr/0003-auth.md`.

<details>
<summary>Example: Authentik (tested with 2026.8)</summary>

In Authentik, create an **OAuth2/OpenID Provider**:

- Client type: Confidential. Authorization flow: `default-provider-authorization-implicit-consent`
  (or explicit consent). Invalidation flow: `default-provider-invalidation-flow`.
- Grant types: **authorization_code** (and refresh_token). Recent Authentik versions reject the
  authorize request with `invalid_request` when this list is empty, which is the default for
  providers created through the API.
- Redirect URI (strict): `https://app.example.com/api/auth/callback/oidc`
  (locally `http://localhost:5173/api/auth/callback/oidc`).
- Scopes: the default `openid`, `email`, `profile` mappings. Signing key: any key pair
  (RS256 ID tokens).

Then create an **Application** bound to that provider (slug e.g. `my-app`), and optionally bind
a group to it to restrict who can sign in. App env:

```sh
OIDC_ISSUER=https://auth.example.com/application/o/my-app/   # trailing slash is fine
OIDC_CLIENT_ID=<provider client id>
OIDC_CLIENT_SECRET=<provider client secret>
```

</details>

## Layout and decisions

See [AGENTS.md](AGENTS.md) for the architecture map, recipes and rules,
[docs/adr](docs/adr) for decisions and [docs/LICENSES.md](docs/LICENSES.md) for container
licenses.

## License

[MIT-0](LICENSE).
