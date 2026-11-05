# saas-agent-starter

Multi-tenant SaaS starter built for AI-agent coding (Claude Code, Codex): strict types,
one-command quality gate, small colocated files and an `AGENTS.md` that tells agents
exactly how to add things. Secure by default. Licensed **MIT-0**: no attribution, no
obligations, and every code dependency is permissive (enforced in CI).

- **API**: TypeScript, Fastify, Zod, OpenAPI, Better Auth (orgs, roles), Drizzle + Postgres
  Row-Level Security, audit log, Valkey-backed rate limits, S3 presigned uploads.
- **Web**: React, Vite, TanStack Router/Query/Table, shadcn/ui, dark mode.
- **Workflows**: Temporal; Python worker (uv, ruff, pyright, pytest) for AI/data work,
  Rust hot paths via PyO3 with a pure-Python fallback.
- **Ops**: Docker Compose (or any Docker host / Coolify), OpenTelemetry everywhere,
  optional Jaeger + Prometheus profile, CI with gitleaks, osv-scanner, CodeQL, Dependabot.

## 5-minute quickstart

Prerequisites: Docker, Node 22.18+ with pnpm (`corepack enable`), [uv](https://docs.astral.sh/uv/),
Rust via [rustup](https://rustup.rs) (for the worker extension and the full gate).

```sh
docker compose up -d --wait postgres valkey s3 temporal-ui
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
Tracing and metrics: add `--profile observability` and set `API_OTEL_ENDPOINT=http://otel-collector:4318`
and `WORKER_OTEL_ENDPOINT=http://otel-collector:4317`; Jaeger at http://localhost:16686,
Prometheus at http://localhost:9090.

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
`pnpm db:migrate` / the `migrate` container), `VALKEY_URL`, `TEMPORAL_ADDRESS`, and `S3_*`
(omit `S3_ENDPOINT` for AWS S3).

## SSO

- **OIDC** (Okta, Entra ID, Google Workspace, Keycloak...): set `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`; the API enables Better Auth's generic OAuth plugin with provider id
  `oidc` (`authClient.signIn.oauth2({ providerId: 'oidc' })` on the client).
- **SAML** or per-organization IdPs: add Better Auth's `@better-auth/sso` plugin to
  `apps/api/src/auth.ts`, regenerate the auth schema and run `pnpm db:generate`.
- Need a standalone IdP instead (user federation, admin console)? Run Keycloak and connect it
  over OIDC as above. See `docs/adr/0003-auth.md`.

## Layout and decisions

See [AGENTS.md](AGENTS.md) for the architecture map, recipes and rules,
[docs/adr](docs/adr) for decisions and [docs/LICENSES.md](docs/LICENSES.md) for container
licenses.

## License

[MIT-0](LICENSE).
