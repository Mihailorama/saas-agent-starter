# 0016. Production deploy: neutral core, thin targets

Status: accepted (owner decision 2026-11-07: the deploy path is not tied to Coolify)

## Context

The starter ran in production only as "any Docker host / Coolify": images were built on the
server, secrets lived in whatever the host offered, there was no TLS, no rollback and no rule
for schema changes. Deliveries range from one small VPS to customer Kubernetes and on-prem
installs with data-residency or air-gap requirements, so the path must not depend on one
provider or panel.

## Decision

One core, the same for every target; targets are documented options on top (docs/deploy.md).

- **Artifact: images by digest.** CI builds `api`, `worker`, `web` on `v*` tags and pushes them
  to GHCR with the version tag (never overwritten: the job fails if it exists). Deploys pin
  `@sha256:` digests, so what was tested is what runs, and a rollback is exact. GHCR because the
  repository lives on GitHub and it needs no extra secret (`GITHUB_TOKEN`); any OCI registry
  works (`IMAGE_REPO`), and customers mirror the same digests.
- **`compose.prod.yaml`**: no `build:`, `restart: unless-stopped`, log rotation, readiness
  health checks, least-privilege env per service (the owner database URL only reaches
  `migrate`). Migrations are a one-shot `migrate` service. The deploy runs it as a one-off
  container before `up` (Compose would otherwise recreate the dependents before waiting for it),
  so a failed migration restarts nothing; `depends_on: service_completed_successfully` keeps the
  same order for a plain `docker compose up`. On-box
  Postgres, SeaweedFS and the Temporal UI are profiles, so tier M points at managed services
  without editing the file.
- **Ingress: Caddy 2** (Apache-2.0). Automatic HTTPS (ACME certificates and renewal), HTTP->HTTPS
  and HTTP/3 with a 20-line config; `tls internal` gives a private CA for rehearsals and
  intranets. The CSP stays in one place (nginx in `web`);
  Caddy only fills HSTS/nosniff/Referrer-Policy if missing and drops `Server`.
  Considered: Traefik (MIT; label-driven, more moving parts for one upstream), nginx + certbot
  (two processes and a renewal cron to get right), Kamal (MIT; its own proxy and conventions,
  a second stack definition next to compose).
- **Secrets: SOPS + age** (MPL-2.0 CLI, BSD-3-Clause), one encrypted dotenv per environment
  committed under `deploy/env/`. Reviewable history, no server-side secret store to run, works
  offline and in any target; key names stay readable, values do not. Considered: a vault
  service (another critical system for tier S), CI-only secrets (ties deploys to one CI), plain
  `.env` on the server (no history, no review).
- **Default target: `docker compose` over SSH** (`scripts/deploy.mjs`, Node stdlib only):
  stage files and pull, pre-migration backup hook, apply, reload Caddy, health check through the
  public URL, keep the previous digests for `--rollback`. Secrets go over the stdin of `ssh`,
  never argv. An optional GitHub Actions job deploys tags through a protected environment and
  stays skipped until `DEPLOY_ENVIRONMENT` is set.
- **Expand/contract** for every schema change, enforced by `pnpm check:migrations` (destructive
  statements need a `-- contract:` marker) and a reviewer checklist.
- Coolify, Kubernetes/Helm and customer on-prem are docs only: they consume the same images,
  env contract and migration rule.

## Consequences

- One compose host recreates changed containers in place: a few seconds without `api` per
  deploy. Zero-downtime rolling updates need two replicas behind a health-aware proxy (tier L);
  expand/contract already makes them safe.
- Rollback restores image digests, not compose/Caddy files or data; deploying an old tag from
  its checkout restores the files as well. Data is protected by the pre-migration backup, which
  becomes mandatory when `pnpm run backup:now` exists.
- Secrets sit decrypted on the server (`0600`), as compose needs them at restart.
- The web bundle bakes its browser config at build time, so one image serves environments that
  share it; others need their own build.
- Images are amd64 only; multi-arch is a `--platform` flag in the release job when needed.
