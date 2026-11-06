# saas-agent-starter

Multi-tenant SaaS starter built for AI-agent coding (Claude Code, Codex): strict types,
one-command quality gate, small colocated files and an `AGENTS.md` that tells agents
exactly how to add things. Secure by default. Licensed **MIT-0**: no attribution, no
obligations: every code dependency is permissive or MPL-2.0, used unmodified (enforced in CI).

- **API**: TypeScript, Fastify, Zod, OpenAPI, Better Auth (orgs, roles), Drizzle + Postgres
  Row-Level Security, audit log, Redis-backed rate limits, S3 presigned uploads.
- **Web**: React, Vite, TanStack Router/Query/Table, shadcn/ui, dark mode.
- **Workflows**: Temporal; Python worker (uv, ruff, pyright, pytest) for AI/data work,
  Rust hot paths via PyO3 with a pure-Python fallback.
- **AI layer**: one logged gateway for every LLM call (Anthropic, any OpenAI-compatible
  endpoint), model registry per contour, append-only `ai_calls` audit table, OpenTelemetry
  GenAI spans, human confirm/correct, admin log + JSONL export, `/ai-transparency` page.
  See [docs/ai-act.md](docs/ai-act.md) for what this does and does not cover.
- **Product analytics**: typed event catalog + `track()`, consent banner, journeys as code
  synced to PostHog (default) or self-hosted Umami, alerts and user feedback as GitHub issues.
- **Ops**: Docker Compose (or any Docker host / Coolify), OpenTelemetry everywhere,
  `observability` profile (Grafana + Loki + Prometheus + Jaeger, logs linked to traces,
  dashboards, alert rules), Sentry-protocol error tracking (GlitchTip profile), a
  permissive-license twin of the whole stack, SBOMs + third-party notices, CI with gitleaks,
  osv-scanner, CodeQL, Dependabot.

## 5-minute quickstart

Prerequisites: Docker, Node 22.18+ with pnpm (`corepack enable`), [uv](https://docs.astral.sh/uv/),
Rust via [rustup](https://rustup.rs) (for the worker extension and the full gate).

```sh
docker compose up -d --wait postgres redis s3 temporal-ui
pnpm i
pnpm db:migrate
pnpm dev                 # web http://localhost:5173, API http://localhost:3000
pnpm worker              # in a second terminal: Python Temporal worker
```

Open http://localhost:5173, create an account, an organization and a project. The project's
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
license gate across npm, PyPI and crates.io, and a Playwright smoke test.
`pnpm bench` prints the Rust vs Python speedup of the example hot path.

## Configuration

All config is environment variables, validated at startup (the API exits on invalid config).
See `.env.example`; put local overrides in `.env` (gitignored). In production set at least
`NODE_ENV=production`, a random `BETTER_AUTH_SECRET` (32+ chars), `BETTER_AUTH_URL`,
`DATABASE_URL` (restricted app role) and `MIGRATION_DATABASE_URL` (schema owner, used only by
`pnpm db:migrate` / the `migrate` container), `REDIS_URL`, `TEMPORAL_ADDRESS`, and `S3_*`
(omit `S3_ENDPOINT` for AWS S3).

## AI

Off until you pick a model: set `AI_PROJECT_SUMMARY_PROVIDER=anthropic`,
`AI_PROJECT_SUMMARY_MODEL=claude-haiku-5-5` and `ANTHROPIC_API_KEY` (or `openai_compatible` with
`OPENAI_BASE_URL` / `OPENAI_API_KEY` and a model registered for your `AI_CONTOUR` in
`config/ai-models.json`), then restart the worker. New projects with a description get an
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

## SSO

- **OIDC** (any provider: Authentik, Okta, Entra ID, Google Workspace, Keycloak...): set
  `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and restart the API. The sign-in page
  then shows "Sign in with SSO" (Better Auth's generic OAuth plugin, provider id `oidc`,
  authorization code + PKCE S256; on the client: `authClient.signIn.social({ provider: 'oidc' })`).
  Register this redirect URI at the IdP: `${BETTER_AUTH_URL}/api/auth/callback/oidc`.
  First SSO login creates the user; they then create or are invited to an organization like any
  other user. Accounts are not auto-linked to an existing email/password user unless the IdP
  sends `email_verified: true`.
- **SAML** or per-organization IdPs: add Better Auth's `@better-auth/sso` plugin to
  `apps/api/src/auth.ts`, regenerate the auth schema and run `pnpm db:generate`.
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
