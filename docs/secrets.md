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
  no CA file needed), `VAULT_DATABASE_URL` on the app's Postgres server, `VAULT_SMTP_*` for the
  invitations ([deploy](deploy.md), section 4). The same rules: invite, then remove the token.
- Permissive contour: `compose.permissive.yaml` switches the profile off (Vaultwarden is
  AGPL-3.0); use Connect. OpenBao and Infisical were evaluated as twins and do not speak the
  Bitwarden API ([LICENSES](LICENSES.md)).

## Connect (an existing Bitwarden or Vaultwarden)

No container. In your shell profile (not `.env`):

```sh
export BW_SERVER_URL=https://vault.example.com   # unset = bitwarden.com; https://vault.bitwarden.eu for EU
```

Log in with your account (master password + 2FA prompt), or with a personal API key for
headless machines: `BW_CLIENTID` / `BW_CLIENTSECRET` from the web vault (Settings > Security >
Keys), exported only for the `login` command. The API key logs in; the master password still
unlocks.

## Use it

Install the Bitwarden CLI yourself: `npm i -g @bitwarden/cli` or Bitwarden's standalone binary.
It is GPL-3.0 and stays a separate tool, never a dependency of this repository
([LICENSES](LICENSES.md)).

```sh
node scripts/vault.mjs login                 # once per machine (human): server + login + unlock
node scripts/vault.mjs unlock                # each session (human): master password prompt
node scripts/vault.mjs status                # locked / unlocked, server, user (exit 2 unless unlocked)
node scripts/vault.mjs get stripe/test STRIPE_SECRET_KEY | gh secret set STRIPE_SECRET_KEY
node scripts/vault.mjs run stripe/test STRIPE_SECRET_KEY STRIPE_SECRET_KEY -- pnpm crm:sync
printf %s "$value" | node scripts/vault.mjs put stripe/test STRIPE_SECRET_KEY
some-cli create-token | node scripts/vault.mjs put github/ci GITHUB_TOKEN
node scripts/vault.mjs lock                  # bw lock + delete the session file
```

- `unlock` runs `bw unlock --raw` and writes the session key to `~/.config/agent-vault/session`
  (`VAULT_SESSION_FILE`, mode 0600, outside the repo). Every later call passes it to `bw` in the
  environment: never in argv, shell history or `.env`. The file is refused if others can read it.
- `get` writes the bare value to stdout and refuses when stdout is a terminal. `run` passes it to
  one command as an environment variable, so the caller never sees it. `put` reads the value from
  stdin only, builds the item JSON in memory and pipes it base64-encoded to `bw create` / `bw edit`.
  An existing item is edited (other fields kept); a new one is created as a login item.
- New items go to your personal vault, or to an organization collection when
  `VAULT_ORGANIZATION_ID` and `VAULT_COLLECTION_ID` are set in the shell.
- Every call syncs first (about a second per `bw` start), so values saved elsewhere are seen.

## Agent rules

The short version is in AGENTS.md, "Secrets for agents". Claude Code may run `status`, `get`,
`run` and `put` without asking (`.claude/settings.json`); reading the session file and calling
`bw get` / `bw list` directly are denied, so values do not land in the transcript. `get` must
always feed a consumer in the same command: a bare `get` would print the value into the agent's
context. `/save-secret` (`.claude/commands/save-secret.md`) walks an agent through saving a new
credential. When the vault is locked (exit 2) the agent stops and asks a human to run `unlock`;
it never searches files, env, shell history or other tools for the credential.

Least privilege for teams: give agents their own vault account that is a member of only the
collections they need (e.g. `dev` and `ci`), and keep production in a collection only people can
read.

## Vault to deploy

Production runtime env stays in SOPS-encrypted files (`deploy/env/<env>.enc.env`,
[deploy](deploy.md)); the vault is where humans and agents create and keep those values. To
copy one, nothing is written to disk and nothing is in argv (sops 3.10+):

```sh
node scripts/vault.mjs get app/production BETTER_AUTH_SECRET | jq -Rs . |
  sops set --value-stdin deploy/env/production.enc.env '["BETTER_AUTH_SECRET"]'
pnpm run deploy -- production
```

A new secret: generate it straight into the vault (`openssl rand -hex 32 | node
scripts/vault.mjs put app/production BETTER_AUTH_SECRET`), then copy it as above. There is no sync
engine: the vault is the source of truth, the encrypted file is what the deploy reads, and a
rotation updates both. CI keeps its own secrets (`gh secret set`, fed by `get`).

## Threat notes

- An unlocked session is the whole vault for its lifetime. Lock (`vault lock`) when you are done;
  agents only work while a human has unlocked. Anyone who can read your home directory, or run
  code as your user, can use the session file, as with `BW_SESSION` itself.
- `get` to a pipe and `run` keep values out of logs and transcripts, but the consumer can still
  print them: pipe only into tools that do not echo input.
- The admin page creates accounts and can delete them: keep `VAULT_ADMIN_TOKEN` empty except while
  inviting, and use an argon2 hash. Signups stay closed. Settings saved on the admin page go to
  `/data/config.json` and override the environment: keep the configuration in env.
- Vaultwarden is an unofficial, community server; it encrypts nothing on the server side that a
  Bitwarden server would not (vault data is end-to-end encrypted by the clients). Keep it on TLS
  and updated (the image is pinned by digest: bump it deliberately).
- Losing the Postgres backup loses the vault; losing the master password loses that user's items.
  Keep an emergency kit for the owner account outside the vault.
