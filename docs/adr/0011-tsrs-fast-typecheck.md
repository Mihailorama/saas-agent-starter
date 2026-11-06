# 0011. Typecheck: tsrs day to day, official tsc on releases

Status: accepted (owner decision 2026-11-06)

## Context

Agents run the typechecker many times per task. Two native compilers exist:

- TypeScript 7 (`typescript` 7.0.2 on npm): Microsoft's official port of the compiler to Go,
  stable, the reference implementation.
- tsrs (npm `tsrs` 0.22.0-ts7.1.0-beta, Apache-2.0): a Rust port by the Oxc project with
  Cloudflare and VoidZero, built with the TypeScript team, follows TypeScript 7.1 beta
  semantics; explicitly experimental, with known differences such as diagnostic ordering
  (https://blog.cloudflare.com/typescript-rust-port).

Measured on this repo (2026-11-06, 8 CPU VPS, `--noEmit`, warm cache):

- apps/api: tsc 5.9 26.3 s / 754 MB; tsc 7.0 4.0-5.6 s / 610 MB; tsrs 1.9-2.9 s / 205 MB
- apps/web: tsc 5.9 16.7 s / 588 MB; tsc 7.0 3.3-4.5 s / 600 MB; tsrs 1.3-1.7 s / 180 MB
- packages/db: tsc 5.9 7.8 s / 317 MB; tsc 7.0 1.6-1.8 s / 180 MB; tsrs 0.9-1.0 s / 87 MB

All report zero errors on the clean tree; tsrs reports an injected TS2322 with the same code.

## Decision

- `pnpm check` (the everyday gate for agents and PR CI) typechecks with tsrs.
- Releases are additionally checked with the official compiler: `pnpm check:release` locally,
  and CI runs `pnpm typecheck` (tsc 7) on every `v*` tag. tsc is authoritative: on
  disagreement, fix the code for tsc and record the case in docs/TODO.md.
- Both versions are pinned exactly and bumped deliberately.
- `baseUrl` removed from apps/web tsconfig (removed in TypeScript 7; `paths` alone works).

## Consequences

- A tsrs-only divergence can slip into main and is caught at release time at the latest.
  Accepted by the owner for the speed of the everyday loop.
- Revisit when tsrs ships a stable release.
