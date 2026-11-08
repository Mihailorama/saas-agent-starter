# Onboarding: setup checklist and product tour

Behind the `onboarding` feature flag (`config/flags.json`, default off; docs/feature-flags.md).
With the flag on, a new user sees a short product tour on the projects page once, and the
projects page shows a **Get set up** card until every item is done or the card is dismissed.

| Part      | Code                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API       | `apps/api/src/routes/onboarding.ts`: item ids, conditions, `GET /api/onboarding`                                                                           |
| Checklist | `apps/web/src/components/onboarding-checklist.tsx` (shadcn `Card`, on `pages/projects.tsx`)                                                                |
| Tour      | `apps/web/src/lib/onboarding.ts` (driver.js, MIT), started in `pages/shell.tsx`                                                                            |
| Tests     | `apps/api/test/onboarding.test.ts` (flag off/on, every condition, cross-org), `apps/web/e2e/onboarding.spec.ts` (flag on, axe), `smoke.spec.ts` (flag off) |

## Checklist items

"Done" is never stored: `GET /api/onboarding` derives every item from existing data in one query
inside `withTenant` (the active organization, RLS for tenant tables, an explicit org filter for
the Better Auth tables). It returns only the items the caller's role can complete; the card is
hidden when none is left, and during an operator's "view as user" session. The ids are a contract:
never rename one, add a new id instead.

| Id                 | Done when                                                                                       | Role   | Scope        |
| ------------------ | ----------------------------------------------------------------------------------------------- | ------ | ------------ |
| `org_profile`      | the organization's `metadata` has both `size` and `website`                                     | admin  | organization |
| `first_project`    | the organization has at least one project                                                       | member | organization |
| `teammate_invited` | a pending, unexpired invitation exists, or the organization has more than one member            | admin  | organization |
| `two_factor`       | the **requesting user** has two-factor authentication on (`user.two_factor_enabled`)            | member | user         |
| `api_key`          | the organization has at least one API key (revoked keys are deleted, so it means "has one now") | admin  | organization |

Company name is the organization's name. Size and website live in Better Auth's organization
`metadata` (no new table or migration), set with `organization.update` by admins and owners. The
API validates it in the organization hooks (`OrgMetadata` in `apps/api/src/auth.ts`, on create
and update): only the keys `size` (one of `ORG_SIZES`) and `website` (an http(s) URL, at most 200
characters); anything else is a 400.

### For rewards rules

Rewards (`config/rewards.json`, granted server-side by the rewards engine) reference these ids,
for example "`org_profile` done → bonus". The server-side check is
`onboardingStatus(tx, { orgId, twoFactor })` in `apps/api/src/routes/onboarding.ts`: call it inside
`withTenant` (or a transaction with `app.org_id` set) and it returns `Record<id, boolean>` for all
ids, whatever the role. `two_factor` is per user; the others are per organization.

## Product tour

The tour is data: `TOUR` in `apps/web/src/lib/onboarding.ts`, a list of steps shown on the projects
page, each pointing at an element with a stable `data-tour="<id>"` attribute (never a CSS class). A
step whose element is not on screen (for example the sidebar on a phone) is shown centred.

It starts once per user, 0.5 s after the projects page renders, and is restarted from the user
menu (**Product tour**). driver.js gives the popover `role="dialog"`, a focus trap (Tab), Esc to
close and arrow keys to move; the styles in `apps/web/src/index.css` (`.app-tour`) use the app's
tokens, so contrast holds in light and dark mode (the e2e test runs axe on it in both).

"Seen" and "checklist dismissed" live in the browser's `localStorage`, keyed by user and
organization id (`onboarding-tour-seen:<userId>`, `onboarding-checklist-dismissed:<orgId>`).
That avoids a new table and a migration; the cost is that a user on a new device sees the tour once
more. If storage is blocked the tour does not start (it could not be remembered) and the checklist
still shows. PostHog person properties were not used because PostHog loads only after analytics
consent and cannot be read back reliably in the browser. If that matters, move the flag to a user
column (docs/TODO.md).

## Add a checklist item

1. API: add the id with the lowest role that can complete it to `ONBOARDING_ITEMS`, and its
   condition to `onboardingStatus()`, from data that already exists (no new table).
2. Web: add its copy and action to `ITEMS` in `onboarding-checklist.tsx`: a `to` link to the page
   where it is done, or a handler in `click`.
3. Test: extend `apps/api/test/onboarding.test.ts` (not done, then done after the real action).
4. Add a row to the table above. `pnpm api:types` (the id enum is in the API schema), `pnpm check`.

## Add a tour step

1. Put `data-tour="<id>"` on the element (a wrapper `div` is fine if the component does not pass
   attributes through).
2. Add a step `{ element: '<id>', title, description }` to `TOUR`.
3. Copy: sentence case, one or two short sentences, no exclamation marks (DESIGN.md).
4. `pnpm e2e` runs the tour with axe (`e2e/onboarding.spec.ts`); adjust the step count there.

## Analytics

Events (`config/events.json`): `onboarding_tour_started` (`manual`), `onboarding_tour_completed`
(closed on the last step), `onboarding_tour_dismissed` (`step`) and
`onboarding_checklist_dismissed` (`done`). The `onboarding-tour` journey (`config/journeys.json`)
is the started → completed funnel. Item completion is not a client event: the item's own event
(`project_created`, `api_key_created`, ...) already marks it, and rewards read the server.
