# 0023. UI kit, patterns, dev gallery and automated UI checks

Status: accepted (owner request, 2026-11-07)

Numbering: 0022 is data-subject rights, so this is 0023.

## Context

Products built on the starter are written mostly by coding agents, often without a designer.
The web app had 12 shadcn/ui components and hand-rolled states per page, so every new screen
re-invented its layout, loading/empty/error handling and copy, and nothing checked the result.
The owner asked for a built-in component library and practices that make app UI conventional
and clean for every user, plus automatic checks of visual quality in the spirit of the
`impeccable` design skill. Constraints: copy-in components, mainstream picks, permissive code
dependencies (ADR 0005), and no screenshots or other media in git.

## Decision

Components and patterns ([docs/ui.md](../ui.md)):

- The shadcn/ui set a typical SaaS app needs, added with the shadcn CLI (copied source on Radix
  through the `radix-ui` package): form (react-hook-form + zod), select, checkbox, radio group,
  switch, textarea, tabs, tooltip, popover, sheet, command (cmdk), breadcrumb, pagination,
  separator, scroll area, progress, calendar (react-day-picker), sidebar, alert dialog, empty,
  kbd, spinner. Existing components were re-added from the same registry so all share one
  version.
- Two registry defaults are not taken: the new `cn` package (0.x, days old) instead of our
  `cn()` in `lib/utils` (clsx + tailwind-merge), and the Base UI `combobox`; the combobox is
  the classic Popover + Command recipe, so the kit stays on one primitive library (Radix).
- Patterns in `components/patterns` (app shell with sidebar/header/breadcrumbs and command
  palette, page header, data table on TanStack Table, empty/loading/error states with
  `QueryView`, confirm dialog, settings section, combobox, date picker, theme toggle) and
  reference screens. Existing pages use them where the change was cheap: shell, projects,
  project detail; deleting a project now asks for confirmation.
- Theme: system by default, light/dark/system toggle (`lib/theme.ts`, `public/theme.js`).
- A dev-only gallery at `/dev/ui` instead of Storybook: Storybook 10.6.6 and Ladle 5.1.1 both
  fail `pnpm check:licenses` (`caniuse-lite` is CC-BY-4.0; Ladle also pulls `only`, license
  unknown), and the gate takes no exceptions. The gallery routes and chunks are compiled out of
  production builds (checked in CI).
- Design context: `DESIGN.md` (tokens, type, spacing, radius, color roles, states, density,
  copy, do/don't; the format the `impeccable` skill and Google's DESIGN.md spec read) and
  `PRODUCT.md` (impeccable's product record) at the repository root; UI rules in AGENTS.md.
  The impeccable skill itself is not vendored; docs/ui.md says how to install it.

Checks:

- Biome: every `a11y` rule is an error.
- axe-core through `@axe-core/playwright` (MPL-2.0, unmodified): every page of the app and
  every gallery screen, light and dark; serious and critical WCAG 2.2 A/AA violations fail
  the e2e suite (`pnpm check`, CI `check` job).
- impeccable detector (`UI / impeccable`): the engine binary from the upstream release,
  pinned and SHA-256-verified, scans the source and the rendered gallery, reference screens
  and public pages at desktop and mobile widths. It runs offline with no account or key, so it
  blocks.
- Visual regression (`UI / visual`): Playwright screenshots of every gallery section, reference
  screen and public page at desktop/mobile × light/dark. Baselines are a workflow artifact
  produced on `main` (and weekly), never committed; PRs download the latest and compare on the
  same runner image and Playwright version. Diffs go to the job summary and an artifact.
  Blocking, with the `visual-change-approved` label as the explicit way to accept an intended
  change; with no baseline yet it is report-only.
- Lighthouse CI (`UI / lighthouse`), same style as the marketing site (`pnpm dlx @lhci/cli`,
  not a dependency): accessibility and best practices ≥ 0.95 on `/sign-in` and
  `/ai-transparency` (public pages; the signed-in ones are covered by axe).

## Consequences

- New screens start from a reference screen and the catalog; the checks catch contrast, labels,
  AI-template tells and unintended visual drift before review.
- The visual job depends on GitHub artifacts (90-day retention, refreshed weekly) and on the
  runner image; a runner image change can show diffs on many screenshots at once, which a
  maintainer accepts once with the label.
- Lighthouse performance is only reported: the single SPA bundle scores about 0.8 on
  `/sign-in` until routes are code-split.
- Product teams change `--primary`, `--radius` and the font in `index.css` and update DESIGN.md;
  everything else follows.
