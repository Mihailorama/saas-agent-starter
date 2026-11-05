# 0001. Stack

Status: accepted

## Context

The starter must be easy for coding agents to extend correctly, deploy on any Docker host,
and stay free of license obligations. Picks should be mainstream so agents and humans
already know them.

## Decision

- TypeScript (strict) in a pnpm workspace; Node 22 runs `.ts` directly (no build step for
  the server).
- API: Fastify, the most widely used performance-focused Node framework, with official
  helmet/cors/rate-limit/swagger plugins; Zod through `fastify-type-provider-zod` so one
  schema validates, types and documents (OpenAPI) each route.
- Web: React + Vite + TanStack Router/Query/Table, shadcn/ui (Radix + Tailwind), lucide
  icons, Sonner toasts. A static SPA served by nginx; no Next.js or platform-specific code.
- Data: Postgres + Drizzle ORM and drizzle-kit migrations.
- Tooling: Biome (format + lint), Vitest, Playwright, one `pnpm check` gate.

## Consequences

- One language for API and UI; Python and Rust are added only where they pay off (ADR 0006).
- Tailwind stays on v3 because v4's engine depends on an MPL-licensed package (ADR 0005).
