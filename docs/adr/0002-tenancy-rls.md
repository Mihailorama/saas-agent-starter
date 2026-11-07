# 0002. Multi-tenancy with Postgres Row-Level Security

Status: accepted

## Context

A single missing `where org_id = ?` in application code leaks one customer's data to another.
Agents write a lot of queries; review will miss one eventually.

## Decision

- Shared schema; every tenant table has `org_id` and the `tenant_isolation` RLS policy
  (`org_id = current_setting('app.org_id', true)`) for reads and writes.
- Application code reaches tenant tables only through `withOrg(db, orgId, fn)`, which runs a
  transaction with `set_config('app.org_id', orgId, true)` (transaction-local, safe with pooling).
- The app connects as a restricted role (no superuser, no `BYPASSRLS`, not the table owner).
  Migrations run as the owner via a separate URL. The API refuses to start if its role can
  bypass RLS.
- `packages/db/test/rls.test.ts` proves isolation with deliberately buggy queries.

## Consequences

- Isolation does not depend on every query being right. No setting means no rows.
- Every tenant query is in a transaction; fine for OLTP. Cross-tenant admin/reporting jobs need
  an explicit separate role and code path: the operator console's read-only `withOperatorRead`
  is that path (ADR 0025).
- Auth tables (users, sessions, memberships) are not tenant-scoped; Better Auth reads them by user.
