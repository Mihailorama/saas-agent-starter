# 0025. Operator console: platform role, one audited RLS exception, read-only impersonation

Status: accepted (owner decision, 2026-11-07: an internal panel for the operator and support
staff, not visible to customers, so support does not query the database by hand)

## Context

Support needs to find an organization or user, see its plan, usage, keys, webhooks and recent
activity, and act: suspend an abusive organization, adjust limits, sign a user out, resend a
confirmation mail, and see the app as a user sees it. Every tenant table is behind RLS (ADR
0002) and the app role must never bypass it, and every change must be traceable to a person and
a reason. Usage: [docs/admin.md](../admin.md).

## Decision

- **Better Auth admin plugin** (`better-auth/plugins`, MIT, the installed 1.7.18; [docs](https://www.better-auth.com/docs/plugins/admin))
  for the platform role and impersonation: it adds `user.role` and `session.impersonatedBy`,
  creates impersonation sessions with a configurable lifetime (`impersonationSessionDuration`),
  keeps the operator's own session in a signed cookie for `stopImpersonating`, refuses to
  impersonate admin roles (`allowImpersonatingAdmins: false`), and hides impersonation sessions
  from the user's session list. Own roles: `user` and `operator` (least privilege: list, get,
  impersonate users; list, revoke sessions). **Its HTTP endpoints are closed** (`/api/auth/admin/*`
  answers 404, like the API key plugin's): our `/api/admin` routes call it server-side so each use
  carries a reason and an audit row.
- **Operators are config**: `OPERATOR_EMAILS` (verified address) + TOTP on + a session younger
  than `OPERATOR_SESSION_MAX_AGE_MINUTES`. The list is mirrored into `user.role` at start, on first
  request and by `pnpm --filter api operators:sync`; the role alone grants nothing. Organization
  roles never make an operator. A list in the reviewed env file instead of a "make admin" button
  means no account can promote another.
- **One RLS exception, read-only**: `withOperatorRead` runs a `READ ONLY` transaction under
  `SET LOCAL ROLE app_operator_read`, a NOLOGIN role with `SELECT` only and an `operator_read`
  policy on every RLS table (created by `migrate.ts`, so new tenant tables get it too). The app
  role is a member without inheritance (`NOINHERIT`; `WITH INHERIT FALSE` on PostgreSQL 16+), so
  nothing changes outside that call; `assertRlsEnforced` refuses to start otherwise. Only
  the console routes (`routes/admin-*.ts`) call it (enforced by a test). No role has `BYPASSRLS`; tenant policies are
  untouched. Changes go through `withOrg` for the one organization concerned.
- **Audit in `audit_log`**, no new journal: actions `operator.*`, actor = operator id, new
  nullable `reason` column (required for operator actions). Organization actions write one row in
  that organization in the same transaction; user actions one row in each of the user's
  organizations, so customers' admins see what was done to them. For users without organization
  `org_id` may be null (platform row, invisible to tenants; policy `platform_audit` admits only
  `operator.*` rows, and only for the NOLOGIN `app_operator_audit` role with INSERT on `audit_log`,
  which the console switches to for that one insert). User-level actions and their rows run in one
  transaction (`auditUser`). "View as" start rows carry `expires_at`, the time the session ends by
  itself, so no cleanup job is needed for the end of the trail. Viewing an organization's page writes `operator.org.viewed` there.
- **Suspension** is `organization.suspended_at` (+ an internal reason): `requireRole` and
  `requireScope` answer `403 organization suspended`; a Better Auth hook blocks entering or
  changing the organization (`ORG_SUSPENDED`), leaving still works. The web shows a notice. The
  worker checks it inside each activity (project workflows, `Gateway.call_llm`, webhook delivery),
  so queued work stops too. Data export and deletion stay allowed (owner decision 2026-11-07:
  data-subject rights do not end with a suspension). Nothing is deleted or revoked, so
  unsuspending restores everything.
- **Limit overrides** stay inside `config/plans.json`: seats/projects up to a plan's new optional
  `limitsMax` (stored in `organization.limit_overrides`, applied in `entitlements()`), the LLM
  spend limit up to `llmSpendMax` through the existing `subscriptions.llm_spend_limits` (same rule
  and same reader in the worker's gateway as the org admin's own setting).
- **Impersonation is read-only, not "confirm each destructive action"**: every mutating request
  of an impersonation session is refused, on our routes (one Fastify hook for every mutating
  `/api/*` request, plus `requireRole`) and Better Auth's (hook),
  except sign-out, switching organization and stopping. Reasons: what support needs is to see
  what the user sees; anything the operator changed would be recorded as the user's own action
  (`withTenant` audits the session's user), which a second confirmation would not fix; and a
  confirmation dialog is a UI rule that an API call skips, while a server-side refusal holds for
  every client. Operators act through the console's audited actions instead. Also blocked while
  viewing: operator routes, the support widget identity (no messages in the user's name),
  analytics identification of the user. Time-boxed by `OPERATOR_IMPERSONATION_MINUTES`; a
  persistent banner shows who is being viewed and until when.

## Alternatives

- **Separate DB login with its own pool** (`OPERATOR_DATABASE_URL`): the same policy, but a second
  secret and connection pool for a read path the role switch already isolates. Revisit if the
  console moves into its own service.
- **`BYPASSRLS` role or a "skip tenant filter" setting**: forbidden (AGENTS.md); either would be a
  general bypass any code could use.
- **SECURITY DEFINER functions per report**: explicit, but every new column or screen needs a
  migration; harder to review than one read-only role.
- **Own admin role table / custom impersonation cookies**: re-implements what the auth library
  ships, on the session tables it already owns.
- **Retool, Appsmith, AdminJS, Forest Admin**: generic database UIs; they would need direct
  database credentials that bypass RLS, would not write our audit rows with a reason, and cannot
  impersonate through Better Auth.

## Consequences

- **No feature flag** (owner decision, 2026-11-07): the console is exempt from the feature-flag
  rule (AGENTS.md). It is gated by `OPERATOR_EMAILS` + TOTP + a fresh session, so it is off until
  an operator is listed, and the template has no live users before 1.0.
- Migration `0006_operator_admin`: nullable/defaulted columns and one policy (expand-only).
  `migrate.ts` creates the roles, grants and policies on every run; managed PostgreSQL must allow `CREATE ROLE`
  for the migration owner (it already creates the app role).
- The operator read role sees every column of tenant tables; the routes choose what to show
  (never key hashes, tokens, webhook secrets or query strings).
- **Remaining risk: the app DB login can `SET ROLE app_operator_read` (and
  `app_operator_audit`).** Membership without inheritance keeps normal queries tenant-scoped, but
  any SQL the app login runs may switch: a SQL injection anywhere in the API would read every
  tenant's rows (read-only) or write org-less `operator.*` audit rows, instead of one tenant's.
  Mitigations: parameterised queries only (AGENTS.md), a test that only `packages/db` and `db.ts`
  name the roles. Removing it needs a separate DB login for the console (Alternatives).
- Support conversations are not linked: the Chatwoot integration stores no per-user link
  (ADR 0013); operators search Chatwoot by email or user id.
