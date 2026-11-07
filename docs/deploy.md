# Production deploy

One provider-neutral core, thin targets on top (owner decision 2026-11-07, [ADR 0016](adr/0016-deploy.md)).
The core is the same everywhere:

1. **Images**: `api`, `worker`, `web`, built by CI on a `v*` tag and pushed to GHCR with an
   immutable tag; a deploy pins them **by digest** ([`.github/workflows/release.yml`](../.github/workflows/release.yml)).
2. **[`compose.prod.yaml`](../compose.prod.yaml)**: the production stack. A one-shot `migrate`
   service runs before `api` and `worker` start; Caddy is the only public entry.
3. **[`deploy/Caddyfile`](../deploy/Caddyfile)**: TLS with automatic certificates, HTTP->HTTPS,
   security headers on top of the ones nginx already sets.
4. **`deploy/env/<env>.enc.env`**: every setting and secret of one environment, encrypted with
   SOPS + age and committed. Decrypted only in memory at deploy time.

The default target runs that core with plain `docker compose` on one server over SSH. Coolify,
Kubernetes and customer on-prem are documented options at the end.

Components (licenses in [LICENSES.md](LICENSES.md)): Caddy 2.11 (Apache-2.0), SOPS 3.13
(MPL-2.0, operator CLI) with age 1.3 (BSD-3-Clause), Docker Compose, GHCR. No new code dependency.

## Tiers

| Tier | Shape                                         | Target                                                   |
| ---- | --------------------------------------------- | -------------------------------------------------------- |
| S    | one server, Postgres and S3 on the box        | this guide, `COMPOSE_PROFILES=db,s3`                     |
| M    | one app server, managed Postgres and S3       | this guide, `COMPOSE_PROFILES=` (empty), URLs to managed |
| L    | several nodes, HA, or a customer's Kubernetes | [Kubernetes](#kubernetes--helm-tier-l-customer-clusters) |

A single compose host restarts each changed container in place, so `api` and `web` are briefly
down during a deploy (seconds; Caddy holds requests to `web` for up to 10 s). Tier L gets real
rolling updates; the expand/contract rule below is what makes them, and rollbacks, safe.

## 1. Release images

Merge the release-please PR (docs/releases.md), or push a tag yourself:
`git tag v1.4.0 && git push origin v1.4.0`. The `Release images` workflow builds the three
images, refuses to overwrite an existing tag, pushes `ghcr.io/<owner>/<repo>/{api,worker,web}:v1.4.0`
and prints each digest in the run summary. The `CI` (tsc release typecheck) and `SBOM` workflows
run on the same tag. It uses only the built-in `GITHUB_TOKEN`. Tags created with `GITHUB_TOKEN`
(release-please) do not fire tag pushes, so `Release images` also accepts `workflow_dispatch` on a tag ref
(dispatched on a branch, it does nothing).

- GHCR packages are private by default: make them public, or run
  `docker login ghcr.io` once on the server with a token that has only `read:packages`.
- The web bundle compiles its browser config at build time (`VITE_*`, all public values). CI
  reads them from repository **variables** (unset = feature off). Environments that need
  different browser config need their own web build.
- Images are linux/amd64 only.
- The `llm-cli` image (vendor CLI subscriptions, docs/llm-providers.md) is not built here: it
  contains the proprietary Claude Code CLI. Build it yourself
  (`docker build -f services/llm-cli/Dockerfile -t <private registry>/llm-cli:<tag> .`), push it
  to a private registry, and put `IMAGE_LLM_CLI=<repo>@sha256:...`, `llm-cli` in
  `COMPOSE_PROFILES`, `LLM_CLI_TOKEN` (32+ random characters) and `LLM_CLI_SECRETS_DIR` (a
  host directory with the login files, mode 600) in the env file.

## 2. Secrets: SOPS + age

```sh
age-keygen -o ~/.config/sops/age/keys.txt     # once per operator; prints the public key
# put every operator's public key, plus one for CI, into .sops.yaml (comma-separated)
cp deploy/env/example.env /tmp/production.env  # fill in real values
sops encrypt --filename-override deploy/env/production.enc.env /tmp/production.env \
  > deploy/env/production.enc.env && shred -u /tmp/production.env
git add deploy/env/production.enc.env           # values are encrypted, key names are not
sops edit deploy/env/production.enc.env         # later changes
sops updatekeys deploy/env/production.enc.env   # after adding/removing a recipient
```

- Generate secrets with `openssl rand -hex 32`. Avoid `$` in values (compose interpolates `.env`).
- `deploy/env/example.env` lists every key with fake values. `.gitignore` keeps any other
  `deploy/env/*.env` out of git, so a decrypted copy cannot be committed by accident; gitleaks
  runs on every push.
- `scripts/deploy.mjs` runs `sops decrypt` with the key from `SOPS_AGE_KEY_FILE` (default
  `~/.config/sops/age/keys.txt`) or `SOPS_AGE_KEY`, keeps the result in memory and sends it on the
  stdin of `ssh`. Secrets never appear in argv, logs or CI output.
- On the server the env lives in `secrets.env` and `.env` (both `0600`, owner = deploy user),
  because compose needs it at every restart. Anyone in the server's `docker` group is
  root-equivalent and can read it anyway.
- Removing someone's access means rotating the secrets they could read, not only removing their key.

## 3. Prepare the server (once)

- Linux with Docker Engine and the Compose plugin (tested: Docker 29.6, Compose 5.3), `curl`.
- A deploy user in the `docker` group, reachable by SSH key; `DEPLOY_PATH` (default
  `/opt/<COMPOSE_PROJECT_NAME>`) writable by it.
- DNS `APP_DOMAIN` -> the server; ports 80 and 443 (TCP, plus 443/UDP for HTTP/3) open. Port 80
  must be reachable for the ACME HTTP challenge and the HTTP->HTTPS redirect.
- Backups of the `pgdata` volume (profile `db`) or of the managed database: see section 6.

## 4. Deploy, check, roll back

```sh
pnpm run deploy -- production --version v1.4.0   # `pnpm deploy` is a pnpm built-in: keep `run`
pnpm run deploy -- production --rollback          # previous release's digests, one command
pnpm run deploy -- production --status
```

What `deploy` does:

1. Decrypts `deploy/env/production.enc.env`, resolves `IMAGE_REPO/{api,worker,web}:v1.4.0` to
   digests in the registry (`docker buildx imagetools inspect`).
2. **Stage** (nothing running changes): writes the new `compose.yaml`, `Caddyfile`, Temporal
   files, `secrets.env` and `release.env` as `*.next` on the server and pulls the images. A
   failure here leaves the old release untouched.
3. **Pre-migration backup hook**: runs `pnpm run backup:now` (with `DEPLOY_ENV=<env>`) if the
   repository has that script, otherwise warns and continues (see section 6).
4. **Apply**: makes the last release that passed its health check (`release.good.env`) the
   rollback target `release.prev.env`, so a failed deploy never becomes one; swaps the files in
   place; runs the migration as a one-off container (`docker compose run --rm migrate`). Only if it
   exits 0 does `docker compose up -d --wait` recreate `api`/`worker`/`web` (whose `depends_on`
   also waits for `migrate`). A failing migration stops the deploy before anything restarts, the
   release state goes back to the running release and the database is unchanged (drizzle applies
   pending migrations in one transaction). The migration runs separately on purpose: inside a
   single `up`, Compose removes and recreates the dependent containers _before_ it waits for
   `migrate`, so a failing migration would take the running release down (seen in the rehearsal).
5. Reloads Caddy (an edited Caddyfile applies without dropping connections), then probes
   `https://APP_DOMAIN/api/auth/ok` on the server itself (Caddy -> web/nginx -> api -> Better
   Auth) for up to 90 s, records the release as `release.good.env`, prints `docker compose ps`
   and appends a line to `deploy.log`.

If step 4 or 5 fails it prints the rollback command; it does not roll back on its own.

`--rollback` swaps `release.env` and `release.prev.env` on the server, runs the same `up` and
health check (a second `--rollback` undoes the first). It rolls back image digests only: compose and Caddy files stay at the last
deployed version. To roll those back too, check out the old tag and deploy it with
`--version <old tag>`. The database is never rolled back; expand/contract (section 5) keeps the
previous release working on the newer schema.

Server layout (`DEPLOY_PATH`): `compose.yaml`, `Caddyfile`, `temporal-*.{sh,yaml}`, `secrets.env`,
`release.env`, `release.prev.env`, `release.good.env`, `.env` (= secrets + release, read by compose), `deploy.log`.
Day-to-day commands work there directly: `cd /opt/app && docker compose logs -f api`.

Profiles in `COMPOSE_PROFILES`: `db` (Postgres on the box), `s3` (SeaweedFS on the box; for
browser uploads also enable the S3 site in `deploy/Caddyfile`), `ops` (Temporal UI on
`127.0.0.1:8233`, reach it with `ssh -L 8233:127.0.0.1:8233`). Deliveries that ban AGPL/SSPL
containers set `REDIS_IMAGE=valkey/valkey:9.1-alpine`. Observability (`docker-compose.yml`
profile) is not part of the production file yet, nor are Langfuse (`llmops`) and Chatwoot
(`support`): run those separately or use their cloud offerings and set their URLs/keys; send OTLP to an existing collector with
`OTEL_EXPORTER_OTLP_ENDPOINT` and errors to Sentry/GlitchTip with `SENTRY_DSN`.

### GitHub Actions (optional)

The `deploy` job of the `Release images` workflow is inert until you opt in:

1. Create a GitHub environment, e.g. `production`, with required reviewers (and optionally a
   tag rule `v*`).
2. Add environment secrets: `DEPLOY_SSH_KEY` (private key of the deploy user, ed25519),
   `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`, verified out of band) and
   `SOPS_AGE_KEY` (the CI age private key whose public half is in `.sops.yaml`).
3. Set the repository variable `DEPLOY_ENVIRONMENT=production`.

Each `v*` tag then waits for approval and deploys the exact digests the `images` job pushed.
Rollback stays a local command (`--rollback`) or a re-run of an older tag's workflow.

## 5. Schema changes: expand/contract

During a deploy, and after a rollback, the previous release runs against the new schema. So a
migration may only **expand**: new tables, nullable columns, columns with a `DEFAULT`, indexes,
relaxed constraints. Changes the previous release would break on are split:

1. Release N (expand): add the new column/table; code writes both shapes, reads the new one
   with a fallback; backfill in a migration or a workflow.
2. Release N+1: code stops using the old shape.
3. Release N+2 (contract): drop/rename/`SET NOT NULL`, in a migration file that contains a
   `-- contract: <why it is safe now>` line (e.g. `-- contract: since v1.6 nothing reads x`).

`pnpm check:migrations` (part of `pnpm check`) fails on `DROP TABLE/COLUMN/TYPE/DEFAULT`,
`RENAME`, column type changes, `SET NOT NULL` and `ADD COLUMN ... NOT NULL` without `DEFAULT`
in any file without that marker. Reviewer checklist for a PR that touches
`packages/db/migrations/`:

- [ ] Every statement works with the previous release still running (expand), or the file is a
  marked contract step and the release that stopped using the old shape is already deployed.
- [ ] No long locks on big tables (`CREATE INDEX` on a large table: plan it, drizzle cannot run
  `CONCURRENTLY` inside its transaction); data backfills are batched.
- [ ] `--rollback` to the previous release still works on the new schema.

## 6. Backups before migrations

The deploy calls `pnpm run backup:now` between staging and migrating. That command is being added
on the `backups` branch; until it lands the deploy prints
`WARNING: no backup:now script yet: deploying WITHOUT a pre-migration backup` and continues.
Make it mandatory once it lands (docs/TODO.md). Until then, take a snapshot by hand before a
release with migrations (provider snapshot, or `docker compose exec postgres pg_dumpall -U postgres`
on the server).

## Other targets

### Coolify

Coolify is a host for the same compose file, not a different deploy path. Create a "Docker
Compose" resource from this repository with `compose.prod.yaml` as the compose file, and:

- remove the `caddy` service (Coolify's proxy terminates TLS) and give `web` the domain
  `APP_DOMAIN` on port 8080;
- the bind-mounted Temporal files (`temporal-setup.sh`, `temporal-dynamicconfig.yaml`) must exist
  next to the compose file: copy them from `infra/temporal/` (or point Temporal at Temporal Cloud
  and drop the three Temporal services);
- paste the decrypted env (`sops decrypt deploy/env/production.enc.env`) into Coolify's
  environment variables, and set `IMAGE_API`, `IMAGE_WORKER`, `IMAGE_WEB` to the release
  digests. Coolify then owns secrets and rollbacks (its own deployment history); keep the
  encrypted file as the source of truth and update both together.

### Kubernetes / Helm (tier L, customer clusters)

Not provided. The images, env contract and health endpoints are ready for it; what is missing:

- A Helm chart (or Kustomize): Deployments for `api` (readiness `/readyz`, liveness `/healthz`,
  port 3000), `worker`, `web` (port 8080); the migration as a `Job` run as a Helm pre-upgrade
  hook (`helm.sh/hook: pre-install,pre-upgrade`) so pods roll only after it succeeds; Ingress or
  Gateway with cert-manager in place of Caddy; HorizontalPodAutoscalers; PodDisruptionBudgets.
- nginx in `web` proxies `/api` to the host name `api`; name the API Service `api` or route `/api`
  at the Ingress instead.
- Secrets: SOPS works with Kubernetes too (helm-secrets, Flux or Argo CD with the SOPS plugin),
  or the cluster's External Secrets / Vault. Postgres, Redis, Temporal and S3 come from managed
  services or their own operators/charts (Temporal publishes an official Helm chart).
- Rolling updates require expand/contract (section 5), which the gate already enforces.

### Customer on-prem, data-residency and air-gapped installs

- Same core: the customer runs `compose.prod.yaml` on their host (tier S/M) or the Kubernetes
  path. They need the images, not this repository's CI. Data-residency or air-gapped customers:
  mirror the images to a registry in the required jurisdiction or inside their network (Harbor,
  GitLab or Nexus registry, a cloud registry in that region):
  `crane copy ghcr.io/<owner>/<repo>/api@sha256:... <mirror>/api:v1.4.0` (crane, Apache-2.0,
  copies the manifest unchanged, so the digest stays the same), and set `IMAGE_REPO` to the
  mirror. Fully offline: `docker save`/`docker load` and `DEPLOY_HOST=local`, which pins the
  loaded images by their image ID (the sha256 of the image config, as immutable as a digest).
- Infrastructure images (Postgres, Redis/Valkey, Temporal, Caddy, SeaweedFS) are mirrored the same
  way; list them with `docker compose -f compose.prod.yaml config --images`.
- Without outbound access to an ACME CA use `CADDY_TLS=internal` and distribute Caddy's root, or
  mount the customer's certificate (`tls /path/cert.pem /path/key.pem` in the Caddyfile).
  Self-hosted analytics: Umami (docs/product-analytics.md); AI: a self-hosted or in-region
  OpenAI-compatible endpoint (README "AI").
- Licenses for the delivery: docs/LICENSES.md, SBOMs from `pnpm run sbom`; AGPL-free with
  `REDIS_IMAGE=valkey/valkey:9.1-alpine`.

## Rehearsal

`deploy/rehearsal.sh` runs the real deploy path on one machine: a throwaway age key, the example
env with random secrets encrypted by SOPS, Caddy's internal CA on `127.0.0.1:28080/28443`,
`DEPLOY_HOST=local` (no SSH), profiles `db,s3`. It deploys v1, upgrades to v2 (which adds an
expand migration), rolls back to v1, then deploys a v3 whose migration fails and checks that v1
kept serving and stayed the current release;
then it tears everything down (`KEEP=1` keeps it). Needs `sops`, `age-keygen`, `docker`, `curl`,
`jq`, `ss`. CI runs it on every push (`deploy-rehearsal` job).

Result on the devserver, 2026-11-07 (Docker 29.6.2, Compose
5.3.1, sops 3.13.3, age 1.3.2, Caddy 2.11.9), `REHEARSAL PASSED`, then torn down:

- Secrets: every value (and comment) of the env encrypted; the plaintext copy deleted right after
  encryption.
- v1 deploy: all migrations of the checkout applied (N), health `https://app.localhost:28443/api/auth/ok` ->
  `{"ok":true}` through Caddy's internal CA; `api` runs the v1 image.
- v2 upgrade: the expand migration applied (N+1) before `api`/`worker` restarted; `api` runs v2.
- `--rollback`: `api` back on the v1 image, healthy on the v2 schema (the expand column stays).
- v3 with a broken migration (`ADD COLUMN ... no_such_type`): the deploy stopped with
  "migration failed: nothing was restarted", `api` kept running v1 (container not recreated), the
  migration count stayed N+1, the current release stayed v1 and the site kept answering.
- Each deploy took about 40 s wall time on a warm image cache (`deploy.log`).
- Headers through Caddy: HTTP/2 200, `strict-transport-security`, `content-security-policy` (from
  nginx), `x-content-type-options`, `referrer-policy`, `alt-svc: h3`, no `Server` header;
  `http://` answers `308` to `https://`.

Found on the way and fixed: (1) inside one `docker compose up`, Compose removed and recreated
`api`/`worker`/`web` before waiting for `migrate`, so a failing migration took v1 down; the
migration now runs first as a one-off. (2) An unset pass-through variable (`- NAME` in
`environment`) removes the image's own default; nginx's envsubst then failed on
`${ANALYTICS_ORIGINS}`, so `web` passes its variables with explicit empty defaults.

Not covered by the rehearsal: the SSH transport (`DEPLOY_HOST=local` runs the same script with
`sh -s` instead of `ssh <host> sh -s`), real ACME certificates, a registry pull (`DEPLOY_HOST=local`
pins the locally built images by image ID instead of a registry digest) and the GitHub Actions `Release images` workflow.
