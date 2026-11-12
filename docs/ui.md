# Building UI

The web app (`apps/web`) ships a component catalog, page patterns, a dev gallery and automated
checks so that every product built on the starter gets a conventional, clean interface without
a designer. Why it is built this way: [ADR 0023](adr/0023-ui-kit-and-checks.md). Visual rules
(tokens, type, spacing, do/don't): [DESIGN.md](../DESIGN.md). Product context for design
tools: [PRODUCT.md](../PRODUCT.md).

## What is where

| Path                                | What                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/index.css`            | Design tokens (CSS variables for light and dark, radius). The only place colors are set.                                                                                                          |
| `apps/web/src/components/ui/`       | shadcn/ui components, copied source (Radix, Tailwind 4, cva). Edit freely, keep the API.                                                                                                          |
| `apps/web/src/components/patterns/` | Page building blocks: `AppShell`, `PageHeader`, `DataTable`, `EmptyState`, `ErrorState`, `QueryView`, `ConfirmDialog`, `SettingsSection`, `CommandMenu`, `Combobox`, `DatePicker`, `ThemeToggle`. |
| `apps/web/src/dev/`                 | The UI gallery and reference screens, development builds only.                                                                                                                                    |
| `apps/web/e2e/a11y.spec.ts`         | axe accessibility checks and layout guards of every page and the gallery.                                                                                                                         |
| `apps/web/e2e/layout.ts`            | Layout guards: horizontal overflow, clipped text, overlapping controls, broken images (DOM checks, no pixels).                                                                                    |
| `apps/web/e2e/layout.spec.ts`       | Layout guards, axe and console errors on the gallery, reference screens and public pages at desktop/mobile × light/dark.                                                                          |
| `apps/web/e2e/visual.spec.ts`       | Screenshots for the local comparison against main (`scripts/visual.mjs`).                                                                                                                         |
| `apps/web/.visual-intent`           | The screens a change means to change (committed, plain text).                                                                                                                                     |
| `apps/web/lighthouserc.cjs`         | Lighthouse CI budgets.                                                                                                                                                                            |

Open the gallery with `pnpm dev` and http://localhost:5173/dev/ui: every component and pattern,
the theme toggle at the top, and links to the reference screens (list, detail, form, settings,
empty, loading, error) inside the real app shell. It is not part of production builds (the
lighthouse CI job checks that the build contains no gallery code).

## Build a screen

1. **Pick the pattern.** Find the closest reference screen in the gallery and copy its
   structure from `apps/web/src/dev/ui-screens.tsx`:
   - a collection: list screen (`PageHeader` + `DataTable` + `EmptyState`);
   - one object: detail screen (`PageHeader` with actions, `Tabs` or `Card`s);
   - create/edit: form screen (`Form` + zod schema), or a `Dialog` for 1–3 fields;
   - preferences: settings screen (`SettingsSections` of `SettingsSection`s).
2. **Add the route** in `apps/web/src/main.tsx` under the `app` route (it renders inside
   `AppShell`) with `staticData: { crumbs: [...] }` for the breadcrumb trail, and a nav item in
   `pages/shell.tsx` if it is a top-level destination (it also becomes a command-palette entry).
3. **Use only catalog components and tokens.** Need something new? Look in the gallery first;
   then add a shadcn/ui component with the CLI (`cd apps/web && pnpm dlx shadcn@latest add
   <name>`), keep `cn` imported from `@/lib/utils`, check its new dependencies with
   `pnpm check:licenses`, and add a gallery section for it.
4. **Cover every state** before calling it done:
   - [ ] loading: skeleton shaped like the content (`QueryView`/`DataTable` do it);
   - [ ] empty: `EmptyState` with what belongs here and the action that adds it;
   - [ ] error: `ErrorState` with the reason and Retry (`QueryView`/`DataTable` do it);
   - [ ] success feedback: a toast for actions that leave the page as it was;
   - [ ] destructive actions behind `ConfirmDialog`;
   - [ ] forms: labels, help text, validation messages (zod), disabled submit while pending;
   - [ ] keyboard: everything reachable with Tab, visible focus, Esc closes overlays;
   - [ ] light and dark, desktop and a 390px-wide phone; secondary table columns hidden on
     small screens (`meta: { className: 'hidden md:table-cell' }`);
   - [ ] copy: sentence case, verbs on buttons, no blame, no exclamation marks (DESIGN.md).
5. **Run the checks** below; with the `impeccable` skill installed, run
   `/impeccable critique <screen>` and `/impeccable audit <screen>` on new or changed screens.

## Dark patterns

Never trick or pressure people. In particular:

- No hidden fees: price, billing period, taxes and the renewal date are on screen before paying
  (billing page; the taxes note is `billing.taxNote` in `config/legal.json`).
- Cancelling takes no more steps than subscribing, and its button is as visible as the ones next
  to it. The confirmation states the facts (until when the plan runs) and offers "Keep plan" and
  "Cancel plan": no confirm-shaming ("No, I like paying more"), no guilt, no fake urgency.
- Consent is never pre-ticked or bundled: terms, age and product news are separate checkboxes,
  product news is optional, and saying no has the same weight as saying yes (cookie banner too).
- No fake scarcity, countdowns, reviews or social proof, no disguised ads, no "trick questions"
  with double negatives, no making account deletion or data export harder than sign-up.

## The checks

| Check                                                                                                                                             | Where                         | Blocks the PR?                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------ |
| Biome lint, all `a11y` rules as errors                                                                                                            | `pnpm check` (CI `check` job) | yes                                  |
| axe-core, WCAG 2.2 A/AA, light + dark, every page and the gallery; serious/critical fail                                                          | `pnpm e2e` (CI `check` job)   | yes                                  |
| impeccable detector: source + rendered gallery, screens and public pages, desktop + mobile                                                        | CI `UI / impeccable`          | yes                                  |
| Layout guards (overflow, clipped text, overlapping controls, console errors, broken images) + axe at desktop/mobile × light/dark                  | `pnpm check` (CI `check` job) | yes                                  |
| Screenshots vs main rendered on the same machine; changed screens must be in `.visual-intent`                                                     | `pnpm check`, pre-push hook   | yes, locally (CI compares no pixels) |
| Lighthouse CI: accessibility ≥ 0.95, best practices ≥ 0.95, entry JS ≤ 230 kB compressed (performance reported) on `/sign-in`, `/ai-transparency` | CI `UI / lighthouse`          | yes                                  |

The `UI` workflow (`.github/workflows/ui.yml`) runs on PRs that touch `apps/web`, the AI
config shown on the transparency page, or the lockfile.

Locally:

```sh
pnpm e2e                         # includes the axe checks (needs the stack, see AGENTS.md Setup)
pnpm --filter web visual         # layout guards + screenshots compared with main (below)
pnpm --filter web build && pnpm --filter web lhci   # with the API running
```

The impeccable detector locally: install the skill (below) and run its engine,
`~/.claude/skills/impeccable/scripts/impeccable detect apps/web/src`, or with the dev server up,
`... detect http://localhost:5173/dev/ui`. A finding you decide to keep gets an inline
`impeccable-disable` comment with the reason (see `impeccable detect --help`).

### Visual checks: decided without a human

Nobody looks at screenshots, and none are committed (no media in git). `pnpm --filter web visual`
(part of `pnpm check` and the pre-push hook) decides on its own:

1. **Layout guards, always** (`e2e/layout.ts`, also in CI): on every gallery section, reference
   screen and public page at desktop and mobile, light and dark: no horizontal overflow, no text
   spilling out of or cut off by its button, link, heading, label, tab, badge or cell (deliberate
   `truncate` is fine), no overlapping controls, no broken images, no console errors, and axe.
   The e2e suite runs the same DOM guards wherever it runs axe, so signed-in pages are covered
   too. `e2e/layout.spec.ts` proves on a deliberately broken page that each guard fires. Text
   counts as cut off vertically only when its box clips it (`overflow-y` not `visible`); a
   control fully inside an input (password reveal, clear button) is not an overlap; anything
   else that overlaps on purpose gets `data-layout-overlap-ok` on a common ancestor.
2. **Screenshots against main, locally only.** The script takes the merge-base of `HEAD` with
   `origin/main`, checks it out in a temporary git worktree, renders it with the working tree's
   `e2e/visual.spec.ts` and caches the result in `apps/web/.visual/main/`, keyed by sha,
   Playwright version and a hash of the screenshot harness (`visual.spec.ts`, `visual-pages.ts`,
   `playwright.visual.config.ts`); a render with failures is used once and not cached. Then it
   screenshots the working tree and compares (tolerance: 0.2% of pixels). Both sides come from
   the same machine, browser and fonts, so there is no stored baseline to go stale. With no UI
   change against main (`apps/web`, the config files it imports, `.env.example`, the lockfile)
   it skips the screenshots. A run where no test executed, or Playwright failed for a reason no
   test explains, fails. Another remote than `origin`: `VISUAL_BASE=<remote>/main`.
   `VISUAL_BASE` takes any git ref, so when you sync a fork whose own `main` predates the visual
   system, compare with the starter's main instead: `git fetch starter main`, then
   `VISUAL_BASE=starter/main pnpm --filter web visual`.
3. **A changed screen needs a declared intent.** Add its id (from the report) to
   `apps/web/.visual-intent`, one per line, `*` as a wildcard (`gallery-*`), `#` for a reason:

   ```text
   page-sign-in   # one-time code field
   ```

   The file is read from the working tree (uncommitted lines count) and only the lines your
   branch adds to it count (`git diff` against the merge-base), so an intent is spent once
   merged, never hides the next change, and an id can be declared again by adding it again;
   delete old lines whenever you like. A wildcard that matches every screen, or more than five
   changed ones, is rejected: list the screens. The report starts with what each line matched;
   an undeclared changed or new screen fails, and `apps/web/.visual/report.md` lists it with
   the expected, actual and diff images.
4. **AI review, optional and advisory:** `pnpm --filter web visual -- --review` sends each
   declared diff (before, after, diff and the intent) to the `claude` CLI on your subscription
   (`--model claude-opus-5-5`, read-only tools, no API key) and writes an OK/REGRESSION verdict
   into the report. It never changes the result, never runs in CI, and is skipped without the
   CLI.

### UI council: make it good, not only unbroken

The checks above stop regressions; they do not make a screen good. `pnpm ui:council` scores it.
One run is one round:

1. It screenshots the working tree (the reference screens and public pages, the `projects` and
   `screens` of `config/ui-council.json`) and takes main's screenshots from the visual cache.
   Screenshots of products you want to beat go into `apps/web/.visual/references/<product>/*.png`
   (gitignored like everything under `.visual/`).
2. The images are copied under neutral labels (`product-1`, ...) in a shuffled order: a member
   cannot tell which one is the new version, and none is told the target, because both change
   the scores.
3. Each member of the config scores every product 1-10 per category and lists up to ten findings
   for this branch (screen, problem, fix). Members are CLIs on your own subscriptions (`claude`,
   `codex`), read-only, with an explicit `model`, API keys removed from their environment. Use
   models from different providers: one model's taste is not a council.
4. The round is appended to `apps/web/.visual/council/history.json`; `report.md` shows the climb
   round by round, by category and the findings. Paste its round table into the PR.

A member passes when it rates every category at least `target` and rates this branch at least as
high as every reference product. Exit 0: the whole council passed this round; 2: the members
you asked for (`--members codex`) passed, so add the next, more expensive one; 1: not yet.
`--reset` starts a new climb. The loop is the `/ui-council` command: run a round, fix the
findings, run again; it stops after 8 rounds without a pass.

Scores are model judgements, not measurements: the same screenshots can score a point apart on
two runs, and scores of the references drift as yours improve. That is why the bar is several
models from different providers agreeing, against references, on a target that is hard to reach
by noise. It is a tool, not a gate: a project uses it when its owner wants to. Like `--review`, it never runs in CI and is never part of `pnpm check`. Rounds cost
subscription usage (a full climb can take hours): start with one member, add the rest when it
passes.

CI compares no pixels and has no approval label: the deterministic guards run there through
`pnpm check`. The pixel comparison is skipped by `git push --no-verify`, by `CI=1`, and by any
push from a machine without the hook (`pnpm install` sets `core.hooksPath` unless another
hooks path is already configured, and never in CI); such a push still has to pass the guards
in CI, and `pnpm check` stays the definition of done. The hook does nothing when the UI did not
change.

### Bundle size

Signed-in pages load on first visit (`lazyRouteComponent` in `main.tsx`) and the command
palette on first open, so the data table, forms, zod and cmdk are not in the entry chunk. The
Lighthouse job fails when an entry page transfers more than 230 kB of JavaScript
(`resource-summary:script:size` in `apps/web/lighthouserc.cjs`). New pages get the same lazy
route; a heavy widget on an eager page loads with `lazy()` on first use.

## Install the impeccable skill (optional, for agents)

[impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0) is a design skill for coding
agents: critique, audit, polish and an anti-pattern detector. It is not vendored into this
repository. It reads `PRODUCT.md` and `DESIGN.md` from the repository root.

```sh
npx impeccable install       # skills for Claude Code, Codex, Cursor, ... (prompts for targets)
```

Then in Claude Code: `/impeccable critique apps/web/src/pages/projects.tsx`,
`/impeccable audit`, `/impeccable polish <target>`. CI runs only the detector binary
(pinned version and SHA-256 in `ui.yml`), never a model.
