---

description: Add a tenant-scoped resource end to end (schema, RLS, API, tests, page)
argument-hint: <resource name, e.g. invoices>
---

Add the tenant resource `$ARGUMENTS` following the "Recipe: add a tenant resource" section of
AGENTS.md exactly, using `projects` as the reference implementation:

1. `packages/db/src/schema.ts`: table with `orgId: orgId()` and `tenantIsolation()`.
   `pnpm db:generate`, check the SQL has `ENABLE ROW LEVEL SECURITY` and the policy,
   `pnpm db:migrate`.
2. `apps/api/src/routes/$ARGUMENTS.ts`: Zod schemas, `preHandler: requireRole(...)`, all DB
   access inside `withTenant`. Register in `apps/api/src/app.ts`.
3. `apps/api/test/`: success, 400, 401/403 and cross-tenant 404 cases.
4. `apps/web/src/pages/`: page built from the list/detail/form reference screens and the
   catalog components (docs/ui.md, AGENTS.md "UI rules"), route in `main.tsx` with
   `staticData.crumbs`, nav item in `pages/shell.tsx`, page added to `e2e/a11y.spec.ts`.
5. Run `pnpm check`. Done means it is green; report the tail of its output.

Ask before adding any dependency. Never weaken RLS, tests or the license gate to get green.
