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

"Done" is never stored: `GET /api/onboarding` derives every item from existing data, inside
`withTenant` (the active organization, RLS for tenant tables, an explicit org filter for the Better
Auth tables). The ids are a contract: never rename one, add a new id instead.

| Id                 | Done when                                                                                                  | Scope        |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ------------ |
| `org_profile`      | the organization's `metadata` (Better Auth, JSON) has non-empty `size` and `website` (`OrgProfile` schema) | organization |
| `first_project`    | the organization has at least one project                                                                  | organization |
| `teammate_invited` | an invitation exists for the organization (any status), or it has more than one member                     | organization |
| `two_factor`       | the **requesting user** has two-factor authentication on (`user.two_factor_enabled`)                       | user         |
| `api_key`          | the organization has at least one API key (revoked keys are deleted, so it means "has one now")            | organization |

Company name is the organization's name. Size and website are optional organization metadata set
through Better Auth's `organization.update` (admins and owners), so there is no new table or
migration.

### For rewards rules

Rewards (`config/rewards.json`, granted server-side by the rewards engine) reference these ids,
for example "`org_profile` done → bonus". The server-side check is
`onboardingStatus(tx, { orgId, twoFactor })` in `apps/api/src/routes/onboarding.ts`: call it inside
`withTenant` (or a transaction with `app.org_id` set) and it returns `Record<id, boolean>`. Grant a
reward from the server, never from the `onboarding_item_completed` analytics event: that event is
per browser and only for analytics. `two_factor` is per user; the others are per organization.

## Product tour

Tours are data: `TOURS` in `apps/web/src/lib/onboarding.ts` maps a route path to steps, each
pointing at an element with a stable `data-tour="<id>"` attribute (never a CSS class). A step whose
element is not on screen (for example the sidebar on a phone) is shown centred.

It starts once per user, 0.5 s after a page with a tour renders, and is restarted from the user
menu (**Product tour**). driver.js gives the popover `role="dialog"`, a focus trap (Tab), Esc to
close and arrow keys to move; the styles in `apps/web/src/index.css` (`.app-tour`) use the app's
tokens, so contrast holds in light and dark mode (the e2e test runs axe on it in both).

"Seen" and "checklist dismissed" live in the browser's `localStorage`, keyed by user and
organization id (`onboarding-tour-seen:<userId>`, `onboarding-checklist-dismissed:<orgId>`).
That avoids a new table and a migration; the cost is that a user on a new device sees the tour once
more. PostHog person properties were not used because PostHog loads only after analytics consent
and cannot be read back reliably in the browser. If that matters, move the flag to a user column.

## Add a checklist item

1. API: add the id to `ONBOARDING_ITEMS` and its condition in `onboardingStatus()`, from data that
   already exists (no new table for onboarding state).
2. Web: add its copy and action to `ITEMS` in `onboarding-checklist.tsx`: a `to` link to the page
   where it is done, or a handler in `click`.
3. Test: extend `apps/api/test/onboarding.test.ts` (not done, then done after the real action).
4. Add a row to the table above. `pnpm api:types` (the id enum is in the API schema), `pnpm check`.

## Add a tour step

1. Put `data-tour="<id>"` on the element (a wrapper `div` is fine if the component does not pass
   attributes through).
2. Add `<id>` to `TourTarget` and a step `{ element, title, description }` to the route's list in
   `TOURS`. A new route gets its own key; it starts on that route for users who have not seen a
   tour yet.
3. Copy: sentence case, one or two short sentences, no exclamation marks (DESIGN.md).
4. `pnpm e2e` runs the tour with axe (`e2e/onboarding.spec.ts`); adjust the step count there.

## Analytics

Events (`config/events.json`): `onboarding_tour_started` (`tour`, `manual`),
`onboarding_tour_completed` (`tour`), `onboarding_tour_dismissed` (`tour`, `step`),
`onboarding_item_completed` (`item`, once per item and browser when first seen done) and
`onboarding_checklist_dismissed` (`done`). The `onboarding-tour` journey (`config/journeys.json`)
is the started → completed funnel.
