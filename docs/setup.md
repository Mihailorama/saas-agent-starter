# Set up the infrastructure: `pnpm run infra`

One command on your Mac (or Linux machine) takes a fresh VPS to the running, verified stack:
it asks a few questions, prepares the server, writes the encrypted settings, deploys and checks
every component. Re-run it any time: it shows what would change and keeps everything it already
generated. Decision and alternatives: [ADR 0032](adr/0032-infra-setup.md). The deploy it drives:
[deploy.md](deploy.md).

## Before you start

- **A server**: Debian 12+ or Ubuntu 22.04+, 4 GB RAM or more (the plan prints what your choices
  need), a public IP, and SSH as `root` (or a user with passwordless `sudo`). A password is fine:
  you type it once into OpenSSH, the tool never sees it.
- **A domain** with an A (and AAAA, if the server has IPv6) record pointing at the server: the app
  runs on it, and the optional on-box services on `s3.`, `umami.` and `vault.` subdomains of it.
  Let's Encrypt needs those records to resolve before the first run.
- **On your machine**: Node 22.18+, pnpm, OpenSSH, [sops](https://github.com/getsops/sops) and
  [age](https://github.com/FiloSottile/age): `brew install sops age`. An SSH key
  (`ssh-keygen -t ed25519` if `~/.ssh/id_ed25519.pub` does not exist). No Docker needed.
- For each component you **connect** rather than install: its URL and credentials (SMTP server,
  managed Postgres or S3, PostHog key, LLM provider key).

## One command

```sh
pnpm i
pnpm run infra                # environment "production"; `pnpm run infra -- staging` for another
```

(`pnpm setup` is a pnpm built-in, hence `run infra`.)

Rather talk it through? In Claude Code, `/setup-infra [environment]` asks the same questions in
the chat, recommends choices for your case, writes `deploy/setup/<env>.answers.json` and explains
the `plan`. It never asks for a secret: you run `pnpm run infra -- <env>` yourself at the end and
type them there.

It asks:

1. The server's address (IP, host name or an alias from `~/.ssh/config`), and the admin user.
2. The app's domain, and the e-mail for Let's Encrypt (`internal`: Caddy's own CA, for intranets).
3. Nothing about releases: it deploys the newest `v*` release of the images, looked up at each
   run (the plan names it). Until your fork publishes its own, the upstream
   `ghcr.io/mihailorama/saas-agent-starter/{api,worker,web}` are used; `images.repo` in the answers
   file switches to yours, `images.version` pins a tag instead of `latest`.
4. For each component: **install** it on the server, **connect** one you already have, or
   **skip** it, then the connect details. Secrets are typed hidden and never shown again.

| Component | Install (on the server)                 | Connect                                      | Skip             |
| --------- | --------------------------------------- | -------------------------------------------- | ---------------- |
| Postgres  | Postgres 17 (`db` profile)              | owner URL, app URL, Temporal's role          | -                |
| S3        | SeaweedFS (`s3` profile), `s3.<domain>` | endpoint, bucket, keys (AWS, R2, ...)        | -                |
| SMTP      | -                                       | `SMTP_URL`, sender                           | no sign-in mails |
| Analytics | Umami (`analytics`), `umami.<domain>`   | PostHog key and host                         | off              |
| LLM       | -                                       | provider, model, key (config/ai-models.json) | AI features off  |
| Vault     | Vaultwarden (`vault`), `vault.<domain>` | Bitwarden Cloud or your Vaultwarden          | -                |

Everything else (backups to off-site S3, Temporal UI, PII redaction, llm-cli, booking, Chatwoot,
Twenty, Stripe, Langfuse, error tracking) is listed in [config/components.json](../config/components.json)
and comes later through `pnpm run infra -- add <component>` (docs/TODO.md). The plan shows the RAM
the choices reserve (`mem_limit` sums from [STACK.md](STACK.md)) against the server's RAM.

## What happens

1. **Preflight** on your machine: the tools are there, the age key exists (created on the first
   run, its public half written into `.sops.yaml`), the domain and the subdomains resolve to the
   server (`node:dns`).
2. **Plan**: the profiles and env **key names** that are added, changed or removed, and the RAM
   budget. Nothing has changed yet; confirm to continue. `pnpm run infra -- plan` stops here.
3. **State**: `deploy/setup/<env>.answers.json` (choices, hosts, URLs, never a secret) and
   `deploy/env/<env>.enc.env` (every setting and secret, encrypted with sops; values generated with
   `crypto.randomBytes` and piped into sops on stdin, never written in plain text). Commit both.
4. **Server bootstrap** over `ssh ... sh -s` (`deploy/setup/bootstrap.sh`), each step checked
   before it acts: your key for the admin (`ssh-copy-id`, only if a password is all there is),
   Docker Engine and Compose from Docker's apt repository, a `deploy` user in the `docker` group
   with your key, the deploy directory, a firewall that lets in only SSH, 80 and 443. The SSH
   ports kept open are the one you connected to plus every port sshd and a socket-activated
   `ssh.socket` listen on; if none can be found the firewall is not turned on. Docker's apt key is
   checked against its published fingerprint. Only after a key login as `deploy` works does it
   turn password login off (an sshd drop-in sorted before cloud-init's `50-cloud-init.conf`,
   checked with `sshd -T`). Root keeps key-only login (`prohibit-password`, not `no`): every run
   bootstraps again as the admin, and the deploy user has no sudo.
5. **Deploy**: `scripts/deploy.mjs` with the release's digests (resolved from the registry's HTTP
   API), then the after-deploy steps: Umami's default `admin`/`umami` login is replaced by
   `UMAMI_ADMIN_PASSWORD`; until then its site answers 503 (`sites/umami.ready` opens it).
6. **Vault**: with the vault installed or connected and `node scripts/vault.mjs status` unlocked,
   generated values not saved there yet go to the item `app/<env>` (`put`, or `replace` after a
   rotation). You approve each in your terminal; values travel on stdin only. The answers file
   keeps a fingerprint per saved key (`vaultPushed`, a truncated SHA-256, never a value), so a
   run that stopped early saves the rest next time.
7. **Verify**: the deploy's health probe through Caddy, then each component's check on the
   server: `python -m worker.selfcheck s3` (put/get/delete), `smtp` (one test mail to the sender
   address, only on the first run, when the SMTP settings change, or with `--mail`), `llm` (a one-token call through the AI gateway, logged in `ai_calls`), Postgres,
   Umami and Vaultwarden health. `pnpm run infra -- verify` runs them again any time. The LLM
   check needs an organization (the call is billed to it): sign up, then
   `pnpm run infra -- verify --org <organization id>`.

## Re-runs and changes

Run the same command again: the answers are the defaults, secrets already in the env file are
kept (you are asked whether to keep each connect secret), and the plan shows only what changes.
Generated values (database passwords, `BETTER_AUTH_SECRET`, S3 keys) stay unless you rotate one:

```sh
pnpm run infra -- --rotate BETTER_AUTH_SECRET      # a new value; signs everyone out
pnpm run infra -- add analytics                    # answer for one component, then apply
pnpm run infra -- plan                             # what a run would change; touches nothing
```

`--rotate` accepts only keys the server applies again (`install.rotate` in the catalog):
`BETTER_AUTH_SECRET`, `DATABASE_URL` (the migration sets the role's password), `VAULT_DB_PASSWORD`
and `UMAMI_DB_PASSWORD` (their one-shots set it), `UMAMI_APP_SECRET`. It refuses the rest:
`POSTGRES_PASSWORD` (Postgres keeps its first password: `ALTER ROLE postgres` first, then edit the
env with `sops edit`), `UMAMI_ADMIN_PASSWORD` (change it in Umami), `WEBHOOK_ENCRYPTION_KEYS`
(add a key in front instead, docs/public-api.md), the S3 keys. Settings you added by hand
(`sops edit`) and that no component owns stay as they are.

If `deploy/env/<env>.enc.env` is missing while its answers file exists or the server already has
a `.env`, the run stops instead of generating new secrets that would replace the live ones:
restore the file from git or a backup (and the age key), or rebuild it from the vault item.

## Non-interactive (CI, managed setups)

```sh
INFRA_SMTP_URL=... INFRA_ANTHROPIC_API_KEY=... \
  pnpm run infra -- --answers deploy/setup/production.answers.json --yes
printf 'SMTP_URL=...\n' | pnpm run infra -- --answers a.json --yes --secrets-stdin
```

`--yes` asks nothing: secrets of connected components come from `INFRA_<KEY>` variables or from
`KEY=value` lines on stdin, otherwise from the existing env file; a missing one stops the run
before anything changes. It needs a key login as the admin already (no `ssh-copy-id`), sets
`SOPS_AGE_RECIPIENTS` or a real key in `.sops.yaml`, and skips the vault step. `DEPLOY_ENV_FILE`
and `DEPLOY_SSH_CONFIG` point at another env file or ssh config.

## When a run fails half-way

Every step is check-then-act, so the fix is: read the message, fix the cause, run the same
command again. It continues where it stopped.

- **ssh fails**: `ssh root@<server>` by hand first. An unknown or changed host key stops the run
  (also with `--yes`): compare the fingerprint with your provider's console, accept it once by
  hand; a changed key is a real warning, find out why before you remove the old one from
  `~/.ssh/known_hosts`.
- **Locked out after hardening** (should not happen: it checks the key login first): use your
  provider's web console, remove `/etc/ssh/sshd_config.d/01-infra.conf`, reload ssh.
- **DNS**: Let's Encrypt fails while the records do not resolve; the run stops before deploying.
- **Deploy failed**: see [deploy.md](deploy.md) section 4; `pnpm run deploy -- <env> --status`,
  `--rollback`.
- **A check failed**: the line names the component; `ssh deploy@<server>`,
  `cd /opt/<project> && docker compose logs <service>`.

## Back up the age key

**The age private key is the single point of loss.** Every secret of every environment is
encrypted to it (`~/.config/sops/age/keys.txt`, or `SOPS_AGE_KEY_FILE`). Without it nobody can
decrypt `deploy/env/`, redeploy or rotate anything, and the server's copy (`.env` on the server)
is then the only one left. Right after the first run:

- copy the key file into your password manager (or the vault) and onto offline media;
- add a second recipient (a teammate's or an offline key) to `.sops.yaml` and run
  `sops updatekeys deploy/env/<env>.enc.env`;
- for CI deploys, a separate CI key (docs/deploy.md "GitHub Actions").

## Tests

`node --test scripts/infra.test.mjs` (in `pnpm check`): catalog check, answers validation, env
rendering and the dry-run plan, and that no generated value is printed. `pnpm check:components`
fails when a compose profile or an `example.env` key has no catalog entry.

`deploy/setup/e2e.sh` (workflow `Infra e2e`, on `main`, nightly-style manual runs and PRs labelled
`infra-e2e`; it builds the images and runs a whole server, too heavy for every PR) starts a fresh
Ubuntu container with sshd, root with a password, cloud-init's sshd drop-in and no Docker
(Docker-in-Docker, the Kamal integration-test pattern), a registry with images built from the
checkout and Mailpit. It runs `infra --answers ci.answers.json --yes` with `CADDY_TLS=internal`
(Postgres, S3, Umami and the vault installed, SMTP connected), runs it again (nothing changes,
the env file is not rewritten), runs `infra verify`, and checks from outside that only key login
is offered, the firewall is on and HTTPS answers. Not covered: `ssh-copy-id` with a typed
password, real ACME certificates and DNS, the interactive questions, the vault push, the LLM
check against a real provider, macOS as the operator machine.

## Next

- `npm create saas-agent@latest`: a separate `create-saas-agent` package that clones the
  template, installs and starts this wizard (deferred, docs/TODO.md).
- A managed offering (we run it for you) uses the same answers file and `--yes`; it is not part of
  this repository.
