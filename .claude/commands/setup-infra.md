---

description: Set up the servers in a conversation; writes the answers file, shows the plan, never sees a secret (docs/setup.md)
argument-hint: [environment, default production]
---

Set up the infrastructure for environment `$ARGUMENTS` (empty: `production`) by talking with the
human, as `pnpm run infra` would ask in the terminal (docs/setup.md, ADR 0032). You prepare the
answers and explain the plan; the human runs the step that types secrets and changes the server.
Done means: a valid `deploy/setup/<env>.answers.json`, its plan shown and explained, and the one
command the human runs next. Stop there.

1. Read `docs/setup.md` and `config/components.json` (modes, `connect` fields, `requires`,
   `available`, `install.ramMiB`). Ask from the catalog, never from memory: it is the source.
   If `deploy/setup/<env>.answers.json` exists, start from it and ask only what changes.
2. Ask a few questions at a time, in the human's language, each with the catalog's default and
   what it costs: the server (host or `~/.ssh/config` alias, admin user), the domain and the
   Let's Encrypt e-mail (or `internal`), the release tag, then for each component install /
   connect / skip with its RAM and what skipping turns off. Recommend for their case (one small
   server: install Postgres and S3, connect SMTP and the LLM provider). Check that the domain and
   the subdomains the choices need resolve (`dig +short <name>`) and say which are missing.
3. Connect fields marked `"secret": true` are never asked for, written or repeated here, even if
   the human offers one: say they will type it into `pnpm run infra` (hidden), or store it first
   with `/save-secret` and pass it as `INFRA_<KEY>` from the vault. Non-secret fields go into the
   answers file.
4. Write the answers file (shape: `deploy/setup/e2e/ci.answers.json`), then run
   `pnpm run infra -- plan <env> --answers deploy/setup/<env>.answers.json` (`plan` first: with
   the environment first it becomes the interactive setup). It validates the answers and changes
   nothing on the server; on the first run it creates the local age key and writes its public half
   into `.sops.yaml` (expected, commit it). `missing secrets: INFRA_<KEY>` is normal here: those
   are typed in step 6. Fix any other error and run it again until it is clean.
5. Explain the plan in plain words: what gets installed where, the subdomains, the RAM against
   the server's, and anything that needs the human first (DNS records, an SSH key, sops and age).
6. Hand over the next step, for the human to run in their own terminal (it asks the secrets
   hidden, bootstraps the server and deploys; approve nothing on their behalf):
   `pnpm run infra -- <env>`. Afterwards offer `pnpm run infra -- verify` and, for staff single
   sign-on into the tools, docs/sso.md.

Never run the apply step yourself, never `--yes`, never read `deploy/env/*.enc.env` decrypted.
