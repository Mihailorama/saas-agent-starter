# Building UI

The web app (`apps/web`) ships a component catalog, page patterns, a dev gallery and automated
checks so that every product built on the starter gets a conventional, clean interface without
a designer. Why it is built this way: [ADR 0022](adr/0022-ui-kit-and-checks.md). Visual rules
(tokens, type, spacing, do/don't): [DESIGN.md](../DESIGN.md). Product context for design
tools: [PRODUCT.md](../PRODUCT.md).

## What is where

| Path                                  | What                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/web/src/index.css`              | Design tokens (CSS variables for light and dark, radius). The only place colors are set.   |
| `apps/web/src/components/ui/`         | shadcn/ui components, copied source (Radix, Tailwind 4, cva). Edit freely, keep the API.   |
| `apps/web/src/components/patterns/`   | Page building blocks: `AppShell`, `PageHeader`, `DataTable`, `EmptyState`, `ErrorState`, `QueryView`, `ConfirmDialog`, `SettingsSection`, `CommandMenu`, `Combobox`, `DatePicker`, `ThemeToggle`. |
| `apps/web/src/dev/`                   | The UI gallery and reference screens, development builds only.                            |
| `apps/web/e2e/a11y.spec.ts`           | axe accessibility checks of every page and the gallery.                                   |
| `apps/web/e2e/visual.spec.ts`         | Screenshot comparisons (gallery, reference screens, public pages).                        |
| `apps/web/lighthouserc.cjs`           | Lighthouse CI budgets.                                                                     |

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

## The checks

| Check                                | Where                                      | Blocks the PR? |
| ------------------------------------ | ------------------------------------------ | -------------- |
| Biome lint, all `a11y` rules as errors | `pnpm check` (CI `check` job)            | yes            |
| axe-core, WCAG 2.2 A/AA, light + dark, every page and the gallery; serious/critical fail | `pnpm e2e` (CI `check` job) | yes |
| impeccable detector: source + rendered gallery, screens and public pages, desktop + mobile | CI `UI / impeccable` | yes |
| Visual regression: 22 screenshots × 4 (desktop/mobile × light/dark) | CI `UI / visual` | yes, unless the PR has the `visual-change-approved` label |
| Lighthouse CI: accessibility ≥ 0.95, best practices ≥ 0.95 (performance reported) on `/sign-in`, `/ai-transparency` | CI `UI / lighthouse` | yes |

The `UI` workflow (`.github/workflows/ui.yml`) runs on PRs that touch `apps/web`, the AI
config shown on the transparency page, or the lockfile.

Locally:

```sh
pnpm e2e                         # includes the axe checks (needs the stack, see AGENTS.md Setup)
pnpm --filter web visual         # screenshots; the first run writes a local baseline
pnpm --filter web build && pnpm --filter web lhci   # with the API running
```

The impeccable detector locally: install the skill (below) and run its engine,
`~/.claude/skills/impeccable/scripts/impeccable detect apps/web/src`, or with the dev server up,
`... detect http://localhost:5173/dev/ui`. A finding you decide to keep gets an inline
`impeccable-disable` comment with the reason (see `impeccable detect --help`).

### Visual regression: how it works and how to accept a change

Screenshots are never committed (no media in git). Instead:

1. On every push to `main` that touches the UI (and weekly, so it never expires), the `visual`
   job takes all screenshots and stores them as the `visual-baseline` workflow artifact
   (90-day retention).
2. On a PR, the job downloads the newest `visual-baseline` from `main`, takes the same
   screenshots on the same runner image and Playwright version, and compares them (tolerance:
   0.2% of pixels). The job summary lists every screenshot that changed; the `visual-report`
   artifact has the expected, actual and diff images and the Playwright HTML report.
3. A change you intended: look at the diffs, then add the **`visual-change-approved`** label to
   the PR. The job re-runs and passes. After the merge, `main` writes the new baseline.
4. No baseline yet (new repository, or the artifact expired): the PR job only takes the
   screenshots and says so in the summary; it cannot fail. Run the `UI` workflow on `main`
   (Actions, "Run workflow") to create one.

Locally the first `pnpm --filter web visual` writes `apps/web/.visual/baseline/` (gitignored)
and later runs compare against it; `pnpm --filter web visual:update` rewrites it. Local
screenshots differ from CI's (fonts, OS), so never copy them into CI.

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
