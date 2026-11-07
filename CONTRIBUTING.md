# Contributing

1. Read [AGENTS.md](AGENTS.md): layout, recipes, conventions, security rules.
2. Keep changes small and focused; add or update tests with the change.
3. Title the PR as a Conventional Commit (`feat: ...`, `fix: ...`, `chore: ...`); it becomes
   the changelog line ([docs/releases.md](docs/releases.md)). Ship new behaviour behind a flag
   ([docs/feature-flags.md](docs/feature-flags.md)).
4. Run `pnpm check` (needs the compose infra) and make it green before opening a PR.
5. New dependencies must be permissively licensed; the license gate will tell you.
6. Record significant decisions as a short ADR in `docs/adr/`.

By contributing you agree your contribution is licensed under [MIT-0](LICENSE).
