# 0029. Secrets vault for humans and coding agents

Status: accepted (owner decision, 2026-11-08: teams adopting agentic development need a vault in
the stack; the owner runs Vaultwarden with the `bw` CLI)

## Context

Coding agents need credentials to do real work. Without a defined place they refuse, ask for
secrets in chat (where they stay in transcripts), or write them into `.env` files and git. The
stack already keeps production runtime env in SOPS + age encrypted files (ADR 0016), but those
are a deploy artifact, not a place where people and agents create, share and look up secrets.
Usage: [docs/secrets.md](../secrets.md).

## Decision

- **Bitwarden protocol, `bw` CLI.** One client for every backend: Bitwarden Cloud, a self-hosted
  Bitwarden, or Vaultwarden. Agents already know it, it has an API-key login for headless
  machines, and the vault data is end-to-end encrypted by the client.
- **Install: Vaultwarden in the `vault` profile**, unmodified, pinned by digest, on the stack's
  Postgres (own role + database, so pgBackRest covers it), signups closed, accounts invited from
  `/admin`, which is on only while `VAULT_ADMIN_TOKEN` is set. Attachments and Sends off, so the
  `/data` volume holds no secrets. Dev puts Caddy's local CA in front because `bw` refuses plain
  HTTP even on localhost; prod reuses the existing Caddy (opt-in site in `deploy/Caddyfile`).
- **Connect: env only** (`BW_SERVER_URL`, API key `BW_CLIENTID`/`BW_CLIENTSECRET` for login),
  documented side by side.
- **`scripts/vault.mjs`, ~200 lines, no dependencies.** `get` prints a value only to a pipe,
  `run` injects it into one command's environment, `put` reads stdin and pipes base64 JSON to
  `bw create/edit`, `status`, `login`, `unlock`, `lock`. The session key lives in a 0600 file
  outside the repo and reaches `bw` through its environment, never argv. A locked vault is exit 2
  with an instruction for agents to stop and ask a human.
- **Claude Code integration**: allow-list for `status/get/run/put`, deny for the session file and
  for `bw get`/`bw list` (values would land in the transcript), `/save-secret` command, an
  AGENTS.md section.
- **SOPS stays the runtime path.** The vault is the source of truth; values reach the encrypted
  env file with `get | jq -Rs . | sops set --value-stdin`. No sync engine.

## Alternatives

- **OpenBao** (MPL-2.0, the Vault fork) and **Infisical** (MIT core, `ee/` under an enterprise
  license that requires a subscription in production): would make a permissive twin, but each
  has its own API and CLI, so the wrapper, the agent rules and Bitwarden Cloud as the connect
  option would all fork in two. The permissive contour disables the profile and connects instead.
- **HashiCorp Vault**: BUSL-1.1, not open source.
- **1Password CLI / Doppler**: SaaS only, no self-hosted install path.
- **SOPS files as the vault**: no per-person access, no sharing UI, every read decrypts the whole
  file; good for deploys, poor for daily work.
- **An own secrets service**: owner rule, no own vault code.

## Consequences

- Vaultwarden is AGPL-3.0 (unmodified container, like Grafana or Twenty); the `bw` CLI is GPL-3.0
  and installed by each developer, never a dependency ([LICENSES](../LICENSES.md)).
- Every wrapper call starts `bw` three or four times (status, sync, list, create/edit): about a
  second each on a normal machine.
- An unlocked session gives the agent the whole account: teams give agents their own account with
  access to only some collections (docs/secrets.md).
- The `bw` item JSON for `put` is built by hand (login item, hidden custom fields); a change in the
  Bitwarden item schema needs the wrapper updated. Checked against `@bitwarden/cli` 2026.10.1 and
  Vaultwarden 1.37.5.
