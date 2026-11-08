# 0032. One-command infrastructure setup (`pnpm run infra`)

Status: accepted (owner decision, 2026-11-08: a founder runs one command on a Mac and gets the
stack provisioned, wired and verified on their VPS; design researched and cross-checked the same
day). Usage: [docs/setup.md](../setup.md).

## Context

The production path (ADR 0016) is solid but assumes an operator: prepare a server, write an env
file of ~50 keys by hand, encrypt it, know which profile needs which key and which Caddy site,
then deploy. Founders using the template stall there. A paid managed offering (outside this
repository) and CI need the same steps without questions. Each component can be installed on
the box, connected to an existing service, or skipped, and the template keeps adding components.

## Decision

- **One script, `scripts/infra.mjs`, on top of the existing core**: questions, server bootstrap,
  env rendering, then the unchanged `scripts/deploy.mjs`, then checks. `pnpm run infra`
  (`pnpm setup` is a pnpm built-in), with `plan` (`--dry-run`), `add <component>` and `verify`.
  Prompts: `@clack/prompts` (MIT), imported only for questions. Node stdlib otherwise.
- **Catalog as data, `config/components.json`**: per component the tier, modes
  (install/connect/skip), connect fields (secret or not, a validator), the compose profile, the
  generated secrets as templates (`{hex:N}`), the public site, the RAM budget, requirements and
  a verify command. `pnpm check:components` fails when a compose profile or an `example.env` key
  has no entry, so "new component -> catalog entry" is enforced like the event catalog.
- **State split by sensitivity**: `deploy/setup/<env>.answers.json` (committed) holds choices,
  hosts and URLs; secrets exist only in `deploy/env/<env>.enc.env`, generated with
  `crypto.randomBytes` and piped into sops on stdin. Each run decrypts the env and prints a plan
  of profiles and key names (never values) plus RAM against the server's. Generated values are
  kept across runs unless `--rotate KEY`; keys no component owns are left alone. `--answers
  file --yes` takes connect secrets from `INFRA_<KEY>` variables or stdin.
- **Bootstrap over `ssh ... sh -s`**, Debian/Ubuntu, every step check-then-act: `ssh-copy-id`
  when only a password exists (OpenSSH prompts; we never read it), Docker from Docker's apt
  repository (not the convenience script), a deploy user in the docker group, ufw with only SSH,
  80 and 443, and password login off through an sshd drop-in that sorts before cloud-init's
  `50-cloud-init.conf`, applied only after a key login as the deploy user worked and checked
  with `sshd -T` and from the client.
- **No Docker on the operator machine**: `deploy.mjs` resolves digests through the registry's
  HTTP API (`fetch`, anonymous or `REGISTRY_AUTH`). Images default to upstream's
  (`ghcr.io/mihailorama/saas-agent-starter`) until a fork releases its own.
- **On-box sites as files**: `deploy/sites/<profile>.caddy`, shipped by the deploy for enabled
  profiles and imported by the Caddyfile, instead of commented blocks to uncomment. New prod
  profile `analytics` (Umami) and one-shots that create the vault and Umami databases.
- **Verify on the server**: the deploy's health probe, then each component's command, among them
  `python -m worker.selfcheck s3|smtp|llm` (the LLM call goes through `Gateway.call_llm` with an
  explicit model, so it is logged like any other).
- **Vault**: generated values go into the vault through `scripts/vault.mjs put/replace` in the
  foreground, where its human approval model applies; never in `--yes` runs.

Considered: Ansible (a second language and runtime on the Mac, playbooks for a dozen steps),
Kamal (its own proxy and stack definition next to compose, ADR 0016), cloud-init user data (one
shot, no re-runs or plans, provider-specific), Terraform/Pulumi (provision VMs, which the founder
already has; good later for multi-server), the Docker convenience script (not for production per
Docker's own docs), `pnpm setup` (taken by pnpm).

## Consequences

- One command from a fresh VPS to a verified stack, and the same file drives CI and a managed
  offering. Re-runs are safe and show their effect first.
- Tier S only: one server, Debian/Ubuntu. Multi-server, Kubernetes, DNS automation, `infra add`
  for the heavy components, the llm-cli install, backups setup and `create-saas-agent` are
  deferred (docs/TODO.md). Without backups configured the wizard deploys with `--skip-backup`
  and says so.
- The web bundle bakes `VITE_*` at build time, so with upstream images browser analytics (PostHog
  or Umami script) stay off until the fork builds its own web image; server-side PostHog works.
- The age key becomes the single point of loss for every environment's secrets; the guide makes
  backing it up the first step after the first run.
- CI covers the whole path in a Docker-in-Docker "server" (separate workflow on `main` and on a
  label, since it builds images and runs a full stack), not real ACME, DNS or macOS.
