# Secrets vault (humans and coding agents)

Coding agents (Claude Code, Codex, ...) need credentials: an API key to test an integration, a
token to set a CI secret, the value that goes into a production env file. Without a vault they
refuse, ask for the secret in chat, or write it into `.env` files and git. This stack gives them
one safe place: a Bitwarden-compatible vault, the official `bw` CLI, and a small wrapper,
`scripts/vault.mjs`, that never prints a value except into a pipe. Decision: [ADR 0029](adr/0029-secrets-vault.md).

- **Install**: Vaultwarden (AGPL-3.0, unmodified) in the `vault` profile, data in the stack's
  Postgres (backed up).
- **Connect**: Bitwarden Cloud, or a Vaultwarden / Bitwarden server you already run. Only
  environment variables change.

The wrapper, the agent rules and the deploy flow are the same for both.

## Where secrets live

One vault item per service and environment, named `<service>/<env>`, e.g. `stripe/test`,
`stripe/production`, `app/production` (the values of `deploy/env/production.enc.env`). A field is
`username`, `password`, `notes`, `totp`, or a custom hidden field named like the env variable
(`STRIPE_SECRET_KEY`). Teams share items through an organization collection.

Never in chat, `.env`, `.env.example`, git, issues, logs, screenshots or a scratch file. `.env`
holds local-dev values only; `.env.example` only example values.

## Install (the `vault` profile)

```sh
VAULT_ADMIN_TOKEN=local-dev-only-admin-token docker compose --profile vault up -d --wait vault-tls
mkdir -p ~/.config/agent-vault
docker compose cp vault-tls:/data/caddy/pki/authorities/local/root.crt ~/.config/agent-vault/ca.crt
```

- `vault` is Vaultwarden on the stack's Postgres (database `vaultwarden`, created by the
  `vault-db` one-shot). `vault-tls` is Caddy with its local CA on https://localhost:8222
  (`VAULT_PORT`): the `bw` CLI refuses plain HTTP, even to localhost. `scripts/vault.mjs` hands
  `~/.config/agent-vault/ca.crt` (`VAULT_CA_FILE`) to `bw` as `NODE_EXTRA_CA_CERTS`; the
  browser needs the same root trusted (or accept the warning once) for the web vault.
- **No public signups** (`SIGNUPS_ALLOWED=false`). Open https://localhost:8222/admin with the
  token, "Invite User" for each person; the invitation mail lands in Mailpit (:8025) and its
  link creates the account. Then unset `VAULT_ADMIN_TOKEN` and restart `vault`: `/admin` is off
  while the token is empty. For anything beyond your laptop use an argon2 hash
  (`docker compose run --rm --no-deps vault /vaultwarden hash`), with every `$` doubled to `$$` in `.env`.
- Attachments and Sends are off, so every secret is in Postgres. Backups: the `vaultwarden`
  database is covered by pgBackRest like every database on that server; the `/data` volume holds
  only the JWT key and icons ([backups](backups.md), "Not backed up").
- Production: `COMPOSE_PROFILES=...,vault` with its own domain behind Caddy (public certificate,
  no CA file needed, `deploy/sites/vault.caddy`), `VAULT_DATABASE_URL` on the app's Postgres
  server, `VAULT_SMTP_*` for the invitations ([deploy](deploy.md), section 4). The same rules:
  invite, then remove the token. `pnpm run infra` installs it, or connects to yours, and saves
  the values it generates into the vault ([setup](setup.md)).
- Permissive contour: `compose.permissive.yaml` switches the profile off (Vaultwarden is
  AGPL-3.0); use Connect. OpenBao and Infisical were evaluated as twins and do not speak the
  Bitwarden API ([LICENSES](LICENSES.md)).

## Connect (an existing Bitwarden or Vaultwarden)

No container: point the agent profile (below) at the server you already run, Bitwarden Cloud
(`https://vault.bitwarden.com`, or `https://vault.bitwarden.eu`) or a Vaultwarden. Nothing in
`.env`.

## Log in: a separate profile and a dedicated agent account

Install the Bitwarden CLI yourself: `npm i -g @bitwarden/cli` or Bitwarden's standalone binary.
It is GPL-3.0 and stays a separate tool, never a dependency of this repository
([LICENSES](LICENSES.md)).

`scripts/vault.mjs` never uses your own `bw` login: it runs `bw` with its own CLI profile,
`~/.config/agent-vault/bw` (`VAULT_BW_DIR`, passed as `BITWARDENCLI_APPDATA_DIR`), and strips
every `BW_*` variable of your shell (session, API key) from what it starts. Log that profile in
once, as a **dedicated agent account** (e.g. `agent@example.com`, invited like anyone else) that
is a member of only an organization collection with dev/staging items, never production or your
personal vault:

```sh
alias bw-agent='BITWARDENCLI_APPDATA_DIR=~/.config/agent-vault/bw NODE_EXTRA_CA_CERTS=~/.config/agent-vault/ca.crt bw'
bw-agent config server https://localhost:8222      # or your server; omit for bitwarden.com
bw-agent login agent@example.com                   # or: bw-agent login --apikey (BW_CLIENTID/SECRET)
node scripts/vault.mjs unlock                      # each session: master password prompt
```

(`NODE_EXTRA_CA_CERTS` only for the dev profile's private CA.) Set `VAULT_ORGANIZATION_ID` and
`VAULT_COLLECTION_ID` in your shell so that new items land in that collection, where the team
sees them.

## Use it

```sh
node scripts/vault.mjs status                       # locked / unlocked (exit 2 unless unlocked)
node scripts/vault.mjs get stripe/test STRIPE_SECRET_KEY --stdout | gh secret set STRIPE_SECRET_KEY
node scripts/vault.mjs run stripe/test STRIPE_SECRET_KEY STRIPE_SECRET_KEY -- pnpm crm:sync
some-cli create-token | node scripts/vault.mjs put github/ci GITHUB_TOKEN
openssl rand -hex 32 | node scripts/vault.mjs replace app/staging BETTER_AUTH_SECRET   # rotation
node scripts/vault.mjs lock                          # delete the session file, then bw lock
```

- `unlock` runs `bw unlock --raw` and writes the session key to `~/.config/agent-vault/session`
  (`VAULT_SESSION_FILE`, mode 0600, outside the repo). Every later call passes it to `bw` in the
  environment: never in argv, shell history or `.env`. The file is refused if others can read it.
- `get` prints the bare value only with the explicit `--stdout` flag and only into a pipe or
  redirect, never to a terminal. `run` passes it to one command as an environment variable
  (`BW_*` removed), so the caller never sees it.
- `put` reads the value from stdin only and adds a field that does not exist yet (to a new or an
  existing item); it refuses to overwrite. `replace` overwrites an existing field. Both build the
  item JSON in memory and pipe it base64-encoded to `bw create` / `bw edit`.
- Fields: custom fields (saved hidden, named like the env variable), or the login's `username` /
  `password`, or `notes`.
- Every call syncs first (about a second per `bw` start), so values saved elsewhere are seen.

## Agent rules

The short version is in AGENTS.md, "Secrets for agents". In `.claude/settings.json` only
`status` and `lock` run without asking. Everything that reveals, uses or changes a value asks the
human each time: `get` (the value would enter the agent's context), `run` (it executes any
command, with the secret in its environment), `put` and `replace` (they write to the shared
vault), and `unlock` (a human's password). Reading `~/.config/agent-vault/` and calling `bw get`
/ `bw list` / `bw export` directly are denied.

**Deny rules are not a security boundary.** They stop an agent from doing these things by
accident; an agent that runs arbitrary shell commands (a prompt-injected one, or any command a
human approved) can still reach the session file or `bw`. The boundary is the agent account: it
can only ever see the collections it is a member of, and only while a human has unlocked it.

`/save-secret` (`.claude/commands/save-secret.md`) walks an agent through saving a new
credential. When the vault is locked (exit 2) the agent stops and asks a human to run `unlock`; it
never searches files, env, shell history or other tools for the credential.

## Vault to deploy

Production runtime env stays in SOPS-encrypted files (`deploy/env/<env>.enc.env`,
[deploy](deploy.md)); the vault is where humans and agents create and keep those values. To
copy one, nothing is written to disk and nothing is in argv (sops 3.10+):

```sh
node scripts/vault.mjs get app/production BETTER_AUTH_SECRET --stdout | jq -Rs . |
  sops set --value-stdin deploy/env/production.enc.env '["BETTER_AUTH_SECRET"]'
pnpm run deploy -- production
```

A new secret: generate it straight into the vault (`openssl rand -hex 32 | node
scripts/vault.mjs put app/production BETTER_AUTH_SECRET`), then copy it as above. Production items
belong in a collection only people can read, so a human runs these, not the agent account. There is no sync
engine: the vault is the source of truth, the encrypted file is what the deploy reads, and a
rotation updates both. CI keeps its own secrets (`gh secret set`, fed by `get`).

## Threat notes

- An unlocked session is the agent account's whole vault for its lifetime. Lock (`vault lock`)
  when you are done; agents only work while a human has unlocked. Anyone who can read your home
  directory, or run code as your user, can use the session file, as with `BW_SESSION` itself.
- `get --stdout` into a pipe and `run` keep values out of logs and transcripts, but the consumer
  can still print them: approve only consumers that do not echo input.
- The admin page creates accounts and can delete them: keep `VAULT_ADMIN_TOKEN` empty except while
  inviting. In production the container refuses to start with anything but an argon2 hash, and
  Caddy answers 403 on `/admin` except from `VAULT_ADMIN_IPS`. Signups stay closed. Settings saved on the admin page go to
  `/data/config.json` and override the environment: keep the configuration in env.
- Vaultwarden is an unofficial, community server; it encrypts nothing on the server side that a
  Bitwarden server would not (vault data is end-to-end encrypted by the clients). Keep it on TLS
  and updated (the image is pinned by digest: bump it deliberately).
- Losing the Postgres backup loses the vault; losing the master password loses that user's items.
  Keep an emergency kit for the owner account outside the vault.
