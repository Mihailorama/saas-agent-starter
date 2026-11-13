# Container image licenses

All application code dependencies are checked automatically against the allowlist
(permissive + MPL-2.0; `pnpm check:licenses`, see [ADR 0005](adr/0005-license-policy.md)).
That allowlist does not apply here: infrastructure runs as separate containers, **run
unmodified, not distributed with the app**, so any license is acceptable, AGPL and
source-available included. Every image must still be listed below; `pnpm check:licenses` fails
on an image that is not. Their primary software licenses:

| Image                                              | Used for                                                       | License                     |
| -------------------------------------------------- | -------------------------------------------------------------- | --------------------------- |
| `postgres`                                         | database (app + Temporal)                                      | PostgreSQL                  |
| `redis`                                            | rate-limit store                                               | RSALv2 / SSPLv1 / AGPLv3    |
| `valkey/valkey`                                    | rate-limit store (permissive twin)                             | BSD-3-Clause                |
| `chrislusf/seaweedfs`                              | local S3-compatible storage (dev only)                         | Apache-2.0                  |
| `temporalio/server`                                | workflow engine                                                | MIT                         |
| `temporalio/admin-tools`                           | Temporal schema setup, namespace                               | MIT                         |
| `temporalio/ui`                                    | Temporal Web UI                                                | MIT                         |
| `otel/opentelemetry-collector-contrib`             | telemetry pipeline, container logs (observability)             | Apache-2.0                  |
| `jaegertracing/jaeger`                             | traces (observability profile)                                 | Apache-2.0                  |
| `prom/prometheus`                                  | metrics, alert rules (observability)                           | Apache-2.0                  |
| `grafana/loki`                                     | logs (observability profile)                                   | AGPL-3.0                    |
| `grafana/grafana`                                  | dashboards, single pane (observability)                        | AGPL-3.0                    |
| `glitchtip/glitchtip`                              | error tracking, Sentry API (glitchtip profile)                 | MIT                         |
| `node`                                             | API runtime and web build                                      | MIT                         |
| `nginxinc/nginx-unprivileged`                      | web static files + `/api` proxy                                | BSD-2-Clause                |
| `caddy`                                            | TLS + ingress in `compose.prod.yaml` (ADR 0016)                | Apache-2.0                  |
| `ghcr.io/astral-sh/uv`                             | worker build stage                                             | MIT OR Apache-2.0           |
| `python`                                           | worker runtime                                                 | Python-2.0 (PSF)            |
| `ghcr.io/umami-software/umami`                     | product analytics (`analytics` profile)                        | MIT                         |
| `axllent/mailpit`                                  | catches outgoing mail in dev (UI/API :8025)                    | MIT                         |
| `ghcr.io/promptfoo/promptfoo`                      | eval engine for `pnpm eval` (eval profile)                     | MIT                         |
| `langfuse/langfuse`                                | Langfuse web (llmops profile)                                  | MIT core + `ee/` commercial |
| `langfuse/langfuse-worker`                         | Langfuse worker (llmops profile)                               | MIT core + `ee/` commercial |
| `clickhouse/clickhouse-server`                     | Langfuse trace store (llmops profile)                          | Apache-2.0                  |
| `chatwoot/chatwoot`                                | service desk, `-ce` tag only (`support` profile)               | MIT                         |
| `saas-agent-starter-postgres`                      | Postgres 17 + pgvector extension (built)                       | PostgreSQL                  |
| `ghcr.io/gitroomhq/postiz-app`                     | social post scheduling (`marketing` profile)                   | AGPL-3.0                    |
| `towfiqi/serpbear`                                 | keyword rank tracking (`marketing` profile)                    | MIT                         |
| `twentycrm/twenty`                                 | CRM: people, companies, deals (`crm` profile)                  | AGPL-3.0 + app exception    |
| `caldiy` (built from calcom/cal.diy)               | booking: "Book a demo" (`booking` profile)                     | MIT                         |
| `vaultwarden/server`                               | secrets vault for humans and agents (`vault` profile)          | AGPL-3.0                    |
| `stripe/stripe-mock`                               | Stripe API mock for tests/dev (`billing` profile)              | MIT                         |
| `node` + `@modelcontextprotocol/server-everything` | reference MCP server, run unmodified via `npx` (`mcp` profile) | MIT / Apache-2.0            |
| `vllm/vllm-openai`                                 | self-hosted models, GPU (`local-llm` profile)                  | Apache-2.0                  |
| `vllm/vllm-openai-cpu`                             | self-hosted models, CPU smoke (`local-llm-cpu`)                | Apache-2.0                  |
| `ollama/ollama`                                    | self-hosted models, dev (`local-llm` profile)                  | MIT                         |
| `saas-agent-starter-pgbackup`                      | Postgres + backup tools (`compose.backup.yaml`)                | PostgreSQL + MIT            |
| `prom/pushgateway`                                 | backup metrics for Prometheus (backup overlay)                 | Apache-2.0                  |
| `ubuntu`                                           | fresh-server stand-in of the infra e2e (deploy/setup/e2e/)     | various (Debian/Ubuntu OS)  |
| `registry`                                         | release image registry of the infra e2e (test only)            | Apache-2.0                  |

Base OS layers (Alpine, Debian) contain packages under various licenses, including GPL
utilities. They are separate programs in the image, not linked into or distributed as part of
this project's code.

Notes:

- `redis`: Redis 8.0+ is tri-licensed RSALv2 / SSPLv1 / AGPLv3 at your option; 7.2 and earlier
  are BSD-3-Clause ([redis.io/legal/licenses](https://redis.io/legal/licenses/),
  [LICENSE.txt](https://github.com/redis/redis/blob/unstable/LICENSE.txt)). Run unmodified, not
  distributed with the app. Valkey (BSD-3-Clause) is a drop-in replacement if you prefer.
- Object storage is SeaweedFS, not MinIO, because MinIO no longer publishes a community image
  (checked 2026-11-05): [github.com/minio/minio](https://github.com/minio/minio) is archived and
  says "THIS REPOSITORY IS NO LONGER MAINTAINED" and "The MinIO community edition is now
  distributed as source code only"; the last [release](https://github.com/minio/minio/releases)
  is `RELEASE.2025-10-15T17-29-55Z` (2025-10-16); `hub.docker.com/r/minio/minio` returns 404.
  Details in [ADR 0007](adr/0007-infrastructure.md).
- Grafana and Loki are AGPL-3.0 ([grafana LICENSE](https://github.com/grafana/grafana/blob/main/LICENSE),
  [loki LICENSE](https://github.com/grafana/loki/blob/main/LICENSE)). Run unmodified, not
  distributed with the app; for deliveries that ban AGPL use the permissive twin below.
- `server-everything` (MCP reference server, `mcp` profile) comes from
  [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers), whose
  [LICENSE](https://github.com/modelcontextprotocol/servers/blob/main/LICENSE) says the project is
  moving from MIT to Apache-2.0: new contributions are Apache-2.0, older ones stay MIT until
  relicensed. Both are permissive; it runs unmodified in the `node` image, dev and tests only.
- GlitchTip is MIT ([LICENSE](https://gitlab.com/glitchtip/glitchtip-backend/-/blob/master/LICENSE)).
- Sentry (server, and its self-hosted package) is FSL-1.1-Apache-2.0, a source-available license
  that converts to Apache-2.0 two years after each release
  ([sentry LICENSE.md](https://github.com/getsentry/sentry/blob/master/LICENSE.md),
  [self-hosted LICENSE.md](https://github.com/getsentry/self-hosted/blob/master/LICENSE.md)). It
  is not in compose; use it as SaaS or self-host it from its own repository. The Sentry SDKs we
  use are MIT (`@sentry/react`, `@sentry/node-core`, `sentry-sdk`). `@sentry/node` 11 is not
  used: it depends on the `sentry` CLI package (FSL-1.1-Apache-2.0), which the code license gate
  rejects.
- `saas-agent-starter-pgbackup` is built locally from `infra/backup/Dockerfile`: the
  `saas-agent-starter-postgres` image (below) plus Alpine packages pgBackRest (MIT), rclone (MIT), supercronic (MIT), jq (MIT), curl
  (curl license, MIT-style) and openssl (Apache-2.0); licenses as declared in the Alpine package
  metadata (`apk info -a <pkg>`). `chrislusf/seaweedfs` also runs as `backup-s3`, the local
  stand-in for off-site backup storage. Every backup container is permissive, so the permissive
  twin needs no replacement (ADR 0015).
- Tooling, not part of the stack: `anchore/syft` (Apache-2.0) generates the SBOMs (`pnpm run sbom`).
- Deploy tooling on the operator machine or CI runner, not part of the stack or the images:
  [SOPS](https://github.com/getsops/sops) (MPL-2.0, run unmodified as a CLI) and
  [age](https://github.com/FiloSottile/age) (BSD-3-Clause) for the encrypted env files
  (docs/deploy.md).
- `caddy` is Apache-2.0 ([LICENSE](https://github.com/caddyserver/caddy/blob/master/LICENSE)),
  already permissive: the production stack needs no twin for it.

- `ghcr.io/umami-software/umami` (Umami 3, [MIT](https://github.com/umami-software/umami/blob/master/LICENSE)):
  self-hosted product analytics, see [docs/product-analytics.md](product-analytics.md). For an
  on-prem delivery MIT only asks to keep the copyright notice, which the image already carries;
  the client may run, copy and modify it freely. Its `umami-db` one-shot helper reuses the
  `postgres` image.
- Product-analytics code dependencies (checked by the gate like every npm package):
  `posthog-js` is `Apache-2.0 AND MIT` (both permissive; ship the notices), `@langfuse/browser`
  is MIT, `vanilla-cookieconsent` (consent banner) is MIT with no dependencies. PostHog Cloud, GA4 and Yandex Metrika are external services, not shipped software:
  an on-prem client gets none of them unless it sets their env vars.
- `ghcr.io/promptfoo/promptfoo`: Promptfoo itself is MIT, but its npm dependency tree is not
  (checked 2026-11-06 with `promptfoo@0.125.1`: `@img/sharp-libvips-*` LGPL-3.0-or-later,
  `binaryextensions`/`istextorbinary`/... Artistic-2.0, `sylvester` unknown), so it would fail
  the code-dependency gate. It runs as an unmodified dev-tool container instead
  ([ADR 0009](adr/0009-llm-ops.md)).
- `langfuse/*`: MIT for everything outside the `ee/` directories, which are under a commercial
  license and only active with a license key. Everything this repo uses (OTLP ingestion,
  scores, prompt management) is in the MIT core
  ([LICENSE](https://github.com/langfuse/langfuse/blob/main/LICENSE),
  [license key](https://langfuse.com/self-hosting/license-key)).
- Feature-flag code dependencies ([docs/feature-flags.md](feature-flags.md), checked by the gate):
  `posthog-node` (MIT, API); `posthog-js` (above) in the web; the official `posthog` Python SDK
  (MIT) in the worker, with `requests` (Apache-2.0), `backoff` (MIT) and `distro` (declares
  "Apache License, Version 2.0", an alias for `Apache-2.0` since 2026-11-07).
- GitHub Actions for releases ([docs/releases.md](releases.md)), CI tooling, not shipped and not
  scanned by the gate, pinned by commit SHA: `googleapis/release-please-action` v5.0.0
  ([Apache-2.0](https://github.com/googleapis/release-please-action/blob/main/LICENSE)) and
  `amannn/action-semantic-pull-request` v6.1.1
  ([MIT](https://github.com/amannn/action-semantic-pull-request/blob/main/LICENSE)).

- `axllent/mailpit` ([MIT](https://github.com/axllent/mailpit/blob/develop/LICENSE)): local
  SMTP catcher for transactional email, see [docs/email.md](email.md). Production sends through
  a provider over SMTP instead. Email code dependencies: `@react-email/render` (MIT; React
  Email's renderer, `react`/`react-dom` MIT); the worker sends with Python's standard
  `smtplib`, no package.
- Two-factor and passkey code dependencies ([ADR 0017](adr/0017-two-factor-and-passkeys.md)),
  checked by the gate like every npm package: `@better-auth/passkey` (MIT) with
  `@simplewebauthn/server` and `@simplewebauthn/browser` (MIT; the server's transitive deps are
  `@peculiar/*`, `@hexagon/base64`, `@levischuck/tiny-cbor`, `pvtsutils`, `tsyringe` (MIT),
  `asn1js` (BSD-3-Clause), `reflect-metadata` (Apache-2.0), `tslib` 1.x (0BSD)), `qrcode.react`
  (ISC) for the enrolment QR code, and `otpauth` (MIT, tests only) to generate TOTP codes. The
  TOTP plugin itself ships inside `better-auth` (MIT).

- Public API and webhooks (ADR 0018) add no container. Code dependencies, checked by the gate:
  `@better-auth/api-key` (MIT); in the worker, the official Standard Webhooks library
  `standardwebhooks` (PyPI, MIT, no dependencies), which signs deliveries, and `cryptography`
  (Apache-2.0 OR BSD-3-Clause; with `cffi` MIT-0 and `pycparser` BSD-3-Clause), which decrypts
  the signing secrets. Self-hosted Svix (`svix/svix-server`, MIT) was evaluated and not added:
  its open-source edition has no customer app portal.
- `chatwoot/chatwoot` (service desk, [docs/support.md](support.md)): the repository's
  [LICENSE](https://github.com/chatwoot/chatwoot/blob/develop/LICENSE) puts everything outside
  `enterprise/` under MIT (Expat) and `enterprise/` under its own license (`enterprise/LICENSE`).
  We run only the `-ce` tag (`v4.19.1-ce`), which Chatwoot's
  [publish_foss_docker.yml](https://github.com/chatwoot/chatwoot/blob/develop/.github/workflows/publish_foss_docker.yml)
  builds after `rm -rf enterprise`, so no enterprise code is in the image and none of its
  features (Captain AI, SLA, custom roles, audit logs) are used. The plain `vX.Y.Z` tag
  contains `enterprise/`: do not switch to it. Chatwoot Cloud is an external service, not shipped.
- `saas-agent-starter-postgres`: the stack's Postgres, built locally (`infra/backup/Dockerfile`,
  target `postgres`): `postgres:17-alpine` plus the pgvector extension compiled from its pinned
  release tarball (PostgreSQL License,
  [LICENSE](https://github.com/pgvector/pgvector/blob/master/LICENSE)). Chatwoot's schema enables
  `vector`, so its database can live on this server and be backed up with the rest.
  `saas-agent-starter-pgbackup` is the same image plus the backup tools.
- `stripe/stripe-mock` ([MIT](https://github.com/stripe/stripe-mock/blob/master/LICENSE),
  Stripe's official API mock, v0.206.0, checked 2026-11-07): tests and local development only,
  never deployed. Billing code dependency: `stripe` (official Node SDK, MIT, no runtime
  dependencies). Details in [docs/billing.md](billing.md).

- AI providers ([docs/llm-providers.md](llm-providers.md), [ADR 0024](adr/0024-llm-providers.md)).
  Code dependency: `litellm` (PyPI, MIT; checked 2026-11-07 with 1.108.2). Its repository is MIT
  outside `enterprise/` ([LICENSE](https://github.com/BerriAI/litellm/blob/main/LICENSE)); the
  enterprise code is the separate `litellm-enterprise` package (`LicenseRef-Proprietary`), pulled
  in only by the `proxy` extra, which the worker does not install, and nothing from it is used.
  Open: 8 of LiteLLM's transitive dependencies fail the gate on their metadata (ADR 0024,
  "Consequences"); no exception was added.
- Vendor CLIs in the `llm-cli` image (`services/llm-cli/Dockerfile`, base `node`), installed from
  npm at build time as separate tools, run unmodified, never code dependencies of this repo (no
  package.json lists them, so the gate never sees them):
  - `@anthropic-ai/claude-code` (Claude Code): proprietary, "© Anthropic PBC. All rights reserved.
    Use is subject to Anthropic's Commercial Terms of Service"
    ([LICENSE.md](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)). Allowed only as
    a separately installed tool: CI does not build or publish the llm-cli image; operators build
    it and keep it in a private registry.
  - `@openai/codex` (Codex CLI): Apache-2.0 ([LICENSE](https://github.com/openai/codex/blob/main/LICENSE)).
  - `@google/gemini-cli` (Gemini CLI): Apache-2.0
    ([LICENSE](https://github.com/google-gemini/gemini-cli/blob/main/LICENSE)).
  - Not installed by default, configurable as a `command` CLI: Kimi Code (`MoonshotAI/kimi-code`,
    MIT), xAI Grok Build (`xai-org/grok-build`, Apache-2.0 as detected by GitHub).
    Using a subscription through these CLIs is governed by each vendor's terms of use, not by these
    licenses (docs/llm-providers.md, "Terms of use").
- `vllm/vllm-openai`, `vllm/vllm-openai-cpu` (vLLM, Apache-2.0,
  [LICENSE](https://github.com/vllm-project/vllm/blob/main/LICENSE)) and `ollama/ollama` (MIT,
  [LICENSE](https://github.com/ollama/ollama/blob/main/LICENSE)) are already permissive. Model
  weights have their own licenses: the compose defaults `Qwen/Qwen3-0.6B` (Apache-2.0) and
  `BAAI/bge-small-en-v1.5` (MIT), per their Hugging Face model cards.
- Marketing layer ([docs/marketing.md](marketing.md), [ADR 0021](adr/0021-marketing-layer.md)),
  `marketing` profile, all run unmodified:
  - `ghcr.io/gitroomhq/postiz-app` (Postiz,
    [AGPL-3.0](https://github.com/gitroomhq/postiz-app/blob/main/LICENSE)): social post
    scheduling. Not distributed with the app; the permissive twin disables it. Its `postiz-db`
    and `postiz-namespace` one-shots reuse the `postgres` and `temporalio/admin-tools` images.
  - `towfiqi/serpbear` (SerpBear, [MIT](https://github.com/towfiqi/serpbear/blob/main/LICENSE)):
    keyword rank tracking, SQLite in a volume.
  - The site image (`apps/site/Dockerfile`) is built from `node` and `nginxinc/nginx-unprivileged`,
    like the web app. Site code dependencies (checked by the gate): `astro`, `@astrojs/mdx`,
    `@astrojs/rss`, `@astrojs/sitemap` (MIT), Tailwind (MIT) as in the web. Astro's optional
    `sharp` is not installed (`ignoredOptionalDependencies` in `pnpm-workspace.yaml`): its
    `@img/sharp-libvips-*` binaries are LGPL-3.0-or-later; the site uses Astro's passthrough
    image service instead.
  - CI tooling, not a dependency: Lighthouse CI (`@lhci/cli` 0.16.0,
    [Apache-2.0](https://github.com/GoogleChrome/lighthouse-ci/blob/main/LICENSE)) runs through
    `pnpm dlx` in `.github/workflows/site.yml`. It is not in `package.json` because `lighthouse`
    depends on `@sentry/node` 11, which pulls the FSL-licensed `sentry` CLI (see the Sentry note
    above) that the code gate rejects; nothing of it ships with the app.
  - External services, not shipped software: Google Search Console, Bing Webmaster Tools /
    IndexNow, the social networks Postiz posts to, the SERP scraper SerpBear is configured with.

- CRM and booking ([docs/crm.md](crm.md), [ADR 0026](adr/0026-crm-and-booking.md)), checked
  2026-11-07:
  - `twentycrm/twenty` (Twenty v2.57.0, server and worker from one image): its
    [LICENSE](https://github.com/twentyhq/twenty/blob/main/LICENSE) is AGPL-3.0 for most of the
    code, a commercial license for files marked `/* @license Enterprise */`, and MIT for its SDK
    packages; it adds an AGPLv3 section 7 "Twenty Application Exception": an application that
    talks to Twenty only through its published APIs and webhooks is not governed by the AGPL. The
    worker does exactly that (REST). Run unmodified, not distributed with the app; the permissive
    twin disables it. Its `twenty-db` one-shot reuses the `postgres` image.
  - `caldiy` (Cal.diy, `booking` profile): Cal.com is closed source since 2026-04-14
    ([announcement](https://cal.com/blog/cal-com-goes-closed-source-why)); its open-source
    successor Cal.diy is MIT. Verified at the pinned commit `2eb48ecc` (infra/caldiy/build.sh):
    the root [LICENSE](https://github.com/calcom/cal.diy/blob/main/LICENSE) is MIT ("Copyright (c)
    2020-present Cal.com, Inc."), and so is every other LICENSE file in the tree
    (`apps/api/v2/src/platform`, `packages/app-store/hitpay`, `packages/app-store/stripepayment`,
    `packages/embeds/*`); there is no `ee/` directory and no license key. Upstream publishes no
    image, so CI builds it from that commit with upstream's own Dockerfile (on `node:22`, Debian)
    and pushes it with our release; we change no source. The image is an infrastructure container
    like the others, not distributed with the app; its npm dependencies are upstream's and are
    not part of our code gate (Trivy scans the image for vulnerabilities). The last
    `calcom/cal.com` image, v6.2.0 (2026-03-02, AGPL-3.0 with a commercial `ee/`), is unmaintained
    and not used. Cal.com Cloud, the documented alternative, is an external service. The web and
    the site load the booking host's `embed.js` by URL after consent: no npm dependency.
- Secrets vault ([docs/secrets.md](secrets.md), ADR 0029), checked 2026-11-08:
  - `vaultwarden/server` (Vaultwarden 1.37.5, `vault` profile): its
    [LICENSE.txt](https://github.com/dani-garcia/vaultwarden/blob/main/LICENSE.txt) is the GNU
    AGPL v3. Run unmodified, not distributed with the app; the permissive twin disables it. Its
    `vault-db` one-shot reuses the `postgres` image, and `vault-tls` (local TLS in dev) the `caddy`
    image. Vaultwarden is an unofficial Bitwarden-compatible server, not affiliated with Bitwarden.
  - Bitwarden CLI `bw` (`@bitwarden/cli` 2026.10.1 on npm, or Bitwarden's standalone binary):
    the [bitwarden/clients](https://github.com/bitwarden/clients/blob/main/LICENSE.txt) repository
    is GPL-3.0, with Bitwarden License v1.0 code only under `bitwarden_license/`; the npm package
    declares "SEE LICENSE IN LICENSE.txt". It is a tool each developer installs and
    `scripts/vault.mjs` starts as a separate program: no `package.json` lists it, nothing links or
    ships it, so the code gate never sees it. Do not add it as a dependency.
  - Evaluated as a permissive twin and not added: OpenBao (MPL-2.0,
    [LICENSE](https://github.com/openbao/openbao/blob/main/LICENSE), v2.7.2) and Infisical (MIT
    outside `ee/` directories, whose
    [Enterprise license](https://github.com/Infisical/infisical/blob/main/backend/src/ee/LICENSE.md)
    requires a subscription for production use; its CLI repository has the same split). Both are
    sound vaults, but neither speaks the Bitwarden API, so `bw` and `scripts/vault.mjs` would not
    work with them. The permissive contour connects to Bitwarden Cloud or a server the client
    licenses instead (docs/secrets.md "Connect").
- UI kit ([docs/ui.md](ui.md), [ADR 0023](adr/0023-ui-kit-and-checks.md)); code dependencies,
  checked by the gate: `radix-ui` (MIT; the shadcn/ui primitives, replacing the separate
  `@radix-ui/react-*` packages), `react-hook-form` and `@hookform/resolvers` (MIT), `zod` (MIT),
  `cmdk` (MIT, command palette and combobox), `react-day-picker` (MIT, calendar; brings
  `date-fns`/`@date-fns/tz`, MIT), and `@axe-core/playwright` with `axe-core` (MPL-2.0, tests
  only, unmodified; see ADR 0005). shadcn/ui itself is MIT and copied into the repo by its CLI,
  not installed. Not added: Storybook 10.6.6 and Ladle 5.1.1, which fail the gate through
  `caniuse-lite` (CC-BY-4.0) and, for Ladle, `only` (no license declared); the dev gallery at `/dev/ui`
  replaces them.
  - CI tooling, not dependencies: Lighthouse CI runs through `pnpm dlx` exactly as for the site
    (note above), in `.github/workflows/ui.yml`. The `impeccable` design detector
    ([Apache-2.0](https://github.com/pbakaus/impeccable/blob/main/LICENSE)) runs as the
    upstream release binary, pinned by version and SHA-256 in the same workflow; the impeccable
    skill is installed by developers who want it, not vendored.
- PII redaction ([docs/support.md](support.md#personal-data)) adds no new image: the `pii`
  profile runs the worker image with another command. Code dependencies, checked by the gate:
  `presidio-analyzer` and `presidio-anonymizer` (Microsoft Presidio, MIT), spaCy 3.8 (MIT) with
  `thinc`, `blis`, `srsly`, `cymem`, `preshed`, `murmurhash`, `wasabi`, `weasel`, `confection`,
  `catalogue` (MIT or BSD), the English model `en_core_web_sm` 3.8.0 (MIT, installed from its
  GitHub release wheel, pinned in `uv.lock` by hash), `phonenumbers` (Apache-2.0), `tldextract`
  (BSD-3-Clause), `numpy` (`BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0`) and `regex`
  (`Apache-2.0 AND CNRI-Python`). Zlib and CNRI-Python were added to the allowlist for the last
  two (owner decision 2026-11-07, ADR 0005), and the aliases "BSD License" (`Jinja2`, `blis`),
  "Apache 2.0" (`requests-file`) and "ISC License" (`shellingham`).
- LiteLLM gateway (ADR 0024): `litellm` (MIT) pulls `tiktoken` 0.14.0, whose metadata has no
  License-Expression and no classifiers; its License field is the full MIT text. Checked against
  its LICENSE file and accepted as `MIT` through a reviewed-package entry pinned to that exact
  version (`REVIEWED` in `scripts/license-check.mjs`, owner approval 2026-11-07, ADR 0005); any
  other version fails the gate again until reviewed.
- Sign-up protection (docs/security.md): `mailchecker` (MIT) bundles its disposable-domain list
  inside the package's JS file; the list is part of the MIT-licensed package, not a separate
  data file, and updates only with the dependency version.
- License gate tooling (dev group of the worker, not in the image): `license-expression`
  (Apache-2.0, parses the SPDX expressions) with `boolean.py` (BSD-2-Clause). Its wheel also
  carries the ScanCode LicenseDB index (`license_expression/data/scancode-licensedb-index.json`),
  which its `.ABOUT` file marks CC-BY-4.0 and whose license text ships next to it; the package
  metadata the gate reads says Apache-2.0. It is a data file of a dev tool, run unmodified and
  never shipped.

## Permissive twin (replacement map)

Some enterprise clients ban AGPL (or any non-permissive license) in on-premises deliveries,
even for unmodified separate containers. Every non-permissive container has a permissive twin;
the app code and config do not change, only the compose files:

```sh
docker compose -f docker-compose.yml -f compose.permissive.yaml --profile observability up -d
# or once: COMPOSE_FILE=docker-compose.yml:compose.permissive.yaml in .env
```

| Component            | Default (license)                          | Permissive twin (license)                                                                      | What you lose                                                                                                                                                                                          |
| -------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rate-limit store     | Redis 8 (RSALv2/SSPLv1/AGPLv3)             | Valkey 9 (BSD-3-Clause), same protocol and `REDIS_URL`                                         | Nothing the app uses. Redis-only modules/features (e.g. Redis Query Engine) are not in Valkey.                                                                                                         |
| Logs                 | Loki (AGPL-3.0)                            | none: `docker compose logs`, or ship the collector's logs to any OTLP backend you license      | Central log search, log-to-trace links, log retention. The collector still runs; its Loki log pipeline is dropped.                                                                                     |
| Dashboards/alerts UI | Grafana (AGPL-3.0)                         | Prometheus UI (graphs, `/alerts`) + Jaeger UI (traces), both Apache-2.0                        | Provisioned dashboards, one pane across logs/metrics/traces, Grafana alerting UI. Alert rules still evaluate in Prometheus (`infra/otel/alerts.yml`); add Alertmanager (Apache-2.0) for notifications. |
| Error tracking       | GlitchTip (MIT), already permissive        | (Sentry SaaS / self-hosted is FSL: a bigger, not a more permissive, option)                    | n/a                                                                                                                                                                                                    |
| Object storage       | SeaweedFS (Apache-2.0), already permissive | n/a                                                                                            | n/a                                                                                                                                                                                                    |
| Social posting       | Postiz (AGPL-3.0, `marketing` profile)     | none in compose: post natively, or run Mixpost Lite (MIT, Laravel + MySQL) separately          | One calendar for every network, scheduling, team approval. SerpBear (MIT) and the site are unaffected.                                                                                                 |
| CRM                  | Twenty (AGPL-3.0, `crm` profile)           | none in compose: a SaaS CRM behind the same `Crm` class, or Krayin (MIT, Laravel) separately   | Customer records in the stack. The sync dry-runs until another CRM is wired in (docs/crm.md "Swapping the CRM").                                                                                       |
| Secrets vault        | Vaultwarden (AGPL-3.0, `vault` profile)    | none in compose: connect `scripts/vault.mjs` to Bitwarden Cloud or a licensed Bitwarden server | The vault in the stack. The wrapper, the agent rules and the deploy flow are unchanged (docs/secrets.md "Connect").                                                                                    |

SBOMs and notices for a delivery: `pnpm run sbom` writes one CycloneDX SBOM per image (both
twins, all profiles) and `THIRD_PARTY_NOTICES.md` to `dist/sbom/` (also a CI artifact on
`v*` tags).
