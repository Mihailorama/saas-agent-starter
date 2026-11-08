---

description: Save a credential to the team vault instead of chat, .env or git (docs/secrets.md)
argument-hint: <item, e.g. stripe/test> <field, e.g. STRIPE_SECRET_KEY>
---

Save the credential for `$ARGUMENTS` to the vault, following "Secrets for agents" in AGENTS.md.

1. `node scripts/vault.mjs status`. Exit 2 (locked or logged out): stop here and ask the human to
   run `node scripts/vault.mjs unlock` in their terminal. Do not look for the value anywhere else.
2. Name: item `<service>/<env>` (lowercase, e.g. `stripe/test`), field = the env variable that
   will hold it (e.g. `STRIPE_SECRET_KEY`), or `username` / `password` / `notes` / `totp`.
3. Pipe the value in, never as an argument and never echoed into this conversation:
   - a command that produced it: `<command> | node scripts/vault.mjs put <item> <field>`;
   - a value to generate: `openssl rand -hex 32 | node scripts/vault.mjs put <item> <field>`;
   - a value only the human has: ask them to run
     `node scripts/vault.mjs put <item> <field>` themselves with the value on stdin
     (e.g. `pbpaste | ...`), not to paste it here.
4. Check it is readable without printing it:
   `node scripts/vault.mjs get <item> <field> | wc -c`.
5. If the value was already in a file, `.env`, a log or this conversation, say so, remove it from
   the file (never commit it), and tell the human it should be rotated.
6. Report the item and field names only, never the value. Use it later through
   `node scripts/vault.mjs get <item> <field> | <consumer>` or `run`.
