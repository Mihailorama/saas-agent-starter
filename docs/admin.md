# Operator console

An internal back office at `/admin` (web) and `/api/admin/*` (API) for the operator and support
staff, so nobody has to query the database by hand. Customers never see it: every route answers
403 to anyone who is not an operator, organization owners included. Design and alternatives:
[ADR 0025](adr/0025-operator-console.md).

## Who is an operator

An account is an operator when all of these hold:

- its email is in `OPERATOR_EMAILS` (comma-separated, case-insensitive) and verified;
- it has TOTP two-factor authentication on (Settings -> Security; a passkey alone does not count,
  as for the org 2FA policy in ADR 0017);
- the session used is younger than `OPERATOR_SESSION_MAX_AGE_MINUTES` (default 60), so operator
  access always rests on a recent sign-in with the second factor. After that the console asks
  to sign in again.

Organization roles (owner, admin, member) have nothing to do with it. An operator is a normal
account that may or may not belong to organizations of its own.

The list is mirrored into the Better Auth admin plugin's `user.role` (`operator` / `user`), which
the plugin needs for impersonation. Access is always decided by the list, never by the role
alone.

## Bootstrap

1. The person signs up like any user and confirms the email address.
2. Add the address to `OPERATOR_EMAILS` in the deployment's env file (`deploy/env/<env>.enc.env`,
   docs/deploy.md) and deploy, or set it in `.env` locally.
3. They turn on TOTP under Settings -> Security and open `/admin` (also in the user menu).

The role is applied at API start, on the operator's first request, and by
`pnpm --filter api operators:sync` (in production:
`docker compose -f compose.prod.yaml exec api node apps/api/src/operators-sync.ts`). Removing an
address takes effect with the next deploy (the list is checked on every request); the sync resets
the account's role to `user`.

## Screens

- **Organizations**: search by name, slug or id; filter by plan, status (active, suspended,
  payment past due) and creation date. Columns: plan, created, members, LLM spend this billing
  period against the limit (per cost currency), last activity (newest `audit_log` row).
- **Organization**: members (name, email, role, 2FA) with "View as"; subscription state with a
  link to the subscription in the payment provider's dashboard (Stripe: `dashboard.stripe.com`,
  `/test` for test keys); seats, projects and LLM spend against the plan's limits; API keys
  (prefix, active/expired, last use; never the key); webhook endpoints (URL without query string,
  enabled or why disabled, failures in a row); the latest 50 `audit_log` entries. Opening it
  writes `operator.org.viewed` to that organization's audit log.
- **Users**: search by email, name or id. Email verified, 2FA, organizations, last sign-in (newest
  session created by the user, not by an operator), created.
- **User**: organizations and roles, sign-in methods, passkeys, active sessions (start, expiry,
  IP, device; never tokens; operator views marked), and the operator actions on this account.

Support conversations: the Chatwoot integration (docs/support.md) stores no link per user or
organization, so the console shows none. Search Chatwoot's contacts by the user's email or id
(the widget identifier is the user id).

## Actions

Every action needs a reason (3-500 characters). It is stored with the operator's user id, the
action and the target in `audit_log` (`reason` column, action `operator.<name>`), in the same
transaction as the change wherever the change is ours.

| Action                 | API                                             | Effect                                                                                                                                                                                                                                                                                                                                                              | Audit row                                                               |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Suspend organization   | `POST /api/admin/orgs/:id/suspend`              | Members get `403 organization suspended` on every tenant route and see "This organization is suspended" in the app; they cannot switch to it or change it through Better Auth (`ORG_SUSPENDED`), but can leave it. Its API keys get the same 403. Nothing is deleted or revoked.                                                                                    | `operator.org.suspended`, in the org                                    |
| Unsuspend organization | `POST /api/admin/orgs/:id/unsuspend`            | Everything works again.                                                                                                                                                                                                                                                                                                                                             | `operator.org.unsuspended`, in the org                                  |
| Adjust limits          | `PATCH /api/admin/orgs/:id/limits`              | Seats and projects up to the plan's `limitsMax` in `config/plans.json` (`null` = back to the plan's limit), stored in `organization.limit_overrides` and applied by `entitlements()`. The LLM spend limit up to the plan's `llmSpendMax`, only on plans with `llmLimitRaise` and a subscription: the same value an org admin can set, read by the worker's gateway. | `operator.limits.changed`, in the org; target lists the changes         |
| Revoke sessions        | `POST /api/admin/users/:id/revoke-sessions`     | Deletes all of the user's sessions, signing them out everywhere.                                                                                                                                                                                                                                                                                                    | `operator.user.sessions_revoked`, in each of the user's orgs            |
| Resend verification    | `POST /api/admin/users/:id/resend-verification` | Mails a new confirmation link (409 if already verified).                                                                                                                                                                                                                                                                                                            | `operator.user.verification_resent`, in each of the user's orgs         |
| View as user           | `POST /api/admin/users/:id/impersonate`         | See below.                                                                                                                                                                                                                                                                                                                                                          | `operator.impersonation.started` / `.ended`, in each of the user's orgs |

Each organization's admins thus find operator actions on their organization and its members in
their own audit log. A user who belongs to no organization (typically an unconfirmed sign-up)
gets a **platform row** instead: `audit_log.org_id` null, visible to operators only (policy
`platform_audit`: such a row must be an `operator.*` action). Rows for user-level actions are
written after the change (as in mfa.ts): a crash in between can lose the row, never the other
way round.

Reads are logged as structured log lines (`operator listed organizations`, operator id); the
organization page writes its `operator.org.viewed` row.

## View as user (impersonation)

- Better Auth admin plugin `impersonateUser`, called by our route with the reason. It creates a
  session of the user marked `impersonatedBy = <operator id>`, valid for
  `OPERATOR_IMPERSONATION_MINUTES` (default 30, max 240), and keeps the operator's own session in
  a signed `admin_session` cookie. "View as" from an organization page opens that organization.
- **Read-only, no exceptions**: while `impersonatedBy` is set, `requireRole` answers
  `403 read-only while viewing as a user` to every POST/PUT/PATCH/DELETE, and a Better Auth hook
  (`apps/api/src/operator-guard.ts`) refuses every Better Auth POST (`READ_ONLY`) except sign-out,
  switching organization and stopping. The operator cannot get operator access, open the support
  widget in the user's name (`/api/support/identity` 403), or have their browsing join the user's
  analytics person (the web does not identify while viewing).
- A persistent amber banner shows "Viewing as <name> (<email>). Read-only" with the end time and
  "Stop viewing", which ends the session and returns to the user's page in the console.
- Operators cannot be viewed as (neither by the plugin nor by our route). The user's own
  session list never shows the operator's session.
- When the time runs out the session simply expires; the start row plus the configured duration
  bound it. "Stop viewing" writes the end row.

## Data access and the RLS exception

Auth tables (users, sessions, members, organizations, API keys) are not tenant-scoped (ADR 0002)
and are read directly. Tenant tables (subscriptions, `ai_calls` for spend, `audit_log`, projects,
webhook endpoints) are read across organizations through exactly one path, `withOperatorRead`
(`packages/db/src/index.ts`):

- a read-only transaction that switches to the `app_operator_read` role (`SET LOCAL ROLE`);
- that role has `SELECT` only, and an `operator_read` RLS policy (`FOR SELECT ... USING (true)`)
  on every table with RLS, created by `packages/db/src/migrate.ts` (also for tables added later);
- the app role is a member **without inheriting it** (`NOINHERIT`, and `WITH INHERIT FALSE` on
  PostgreSQL 16+), so outside that transaction nothing changes; the API refuses to start if its
  role inherits it (`assertRlsEnforced`);
- only the console routes (`apps/api/src/routes/admin-orgs.ts`, `admin-users.ts`) call it, behind
  `requireOperator`; a test fails if any
  other file calls it or switches roles. Queries inside must filter by organization themselves.

Changes never use it: they run in `withOrg` for the one organization concerned.

## Configuration

| Variable                           | Default              | Meaning                                      |
| ---------------------------------- | -------------------- | -------------------------------------------- |
| `OPERATOR_EMAILS`                  | empty (no operators) | Operator accounts, comma-separated           |
| `OPERATOR_SESSION_MAX_AGE_MINUTES` | 60                   | Max session age for operator routes          |
| `OPERATOR_IMPERSONATION_MINUTES`   | 30                   | Length of a "view as user" session (max 240) |

## Limitations

- Webhook deliveries and workflows already started for a suspended organization still run; only
  new requests are refused.
- "Last sign-in" comes from existing sessions; deleted or expired sessions are not counted.
- The organization list computes LLM spend per row (one index range scan each, at most 100 rows
  per page); a rollup would be needed for very large pages.
