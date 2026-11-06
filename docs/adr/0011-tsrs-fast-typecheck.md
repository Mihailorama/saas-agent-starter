# 0011. tsrs as a fast, non-authoritative typecheck

Status: accepted (experimental)

## Context

Agents run the typechecker many times per task; `tsc` 5.9 takes 8-26 s per package here.
tsrs is a Rust port of the TypeScript compiler by the Oxc project with Cloudflare and VoidZero,
built in collaboration with the TypeScript team (announced 2026-11:
https://blog.cloudflare.com/typescript-rust-port). npm `tsrs`, Apache-2.0, version
`0.22.0-ts7.1.0-beta`: it follows TypeScript 7.1 beta semantics and is explicitly experimental;
known differences include diagnostic ordering.

Measured on this repo (2026-11-06, same machine, `--noEmit`):

- apps/api: tsc 26.3 s / 754 MB, tsrs 6.7 s / 205 MB
- apps/web: tsc 16.7 s / 588 MB, tsrs 1.7 s / 181 MB
- packages/db: tsc 7.8 s / 317 MB, tsrs 1.1 s / 85 MB

Both report zero errors on the clean tree, and tsrs reports injected type errors with the
same TS error codes.

## Decision

- `pnpm typecheck:fast` (tsrs) for the inner loop; `pnpm typecheck` (tsc) stays in
  `pnpm check` and CI as the gate.
- CI runs tsrs as a non-blocking step to surface divergence early.
- `baseUrl` removed from apps/web tsconfig (removed in TypeScript 7; `paths` alone works on 5.9
  too).

## Consequences

- Revisit when tsrs ships a stable release: then consider making it the gate, or move the gate
  to TypeScript 7 native (`tsgo`), whichever is the mainstream choice at the time.
- Pinned exact version; bump deliberately, not via a range.
