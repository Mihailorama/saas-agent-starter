---
name: Workspace
description: A conventional, quiet multi-tenant SaaS app UI that products restyle, not reinvent.
colors:
  primary: "#2463eb"
  primary-foreground: "#ffffff"
  background: "#ffffff"
  foreground: "#0f1729"
  card: "#ffffff"
  muted: "#f3f4f6"
  muted-foreground: "#5d636f"
  accent: "#f3f4f6"
  border: "#e5e7eb"
  destructive: "#dc2828"
  sidebar: "#f9fafb"
  dark-primary: "#3c83f6"
  dark-primary-foreground: "#101218"
  dark-background: "#101218"
  dark-foreground: "#f3f5f7"
  dark-card: "#171a21"
  dark-muted: "#252931"
  dark-muted-foreground: "#9ca3b0"
  dark-border: "#2a2e37"
  dark-destructive: "#f15f5f"
  dark-sidebar: "#13161d"
typography:
  page-title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: "-0.025em"
  section-title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.55
  card-title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  caption:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "8px 16px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "36px"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "36px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "4px 12px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "24px"
  badge:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.full}"
  sidebar:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.foreground}"
    width: "256px"
---

# Design System: Workspace

The source of truth is code: tokens in `apps/web/src/index.css`, components in
`apps/web/src/components/ui` (shadcn/ui, copied source) and patterns in
`apps/web/src/components/patterns`. This file describes them for people and agents; the dev
gallery (`/dev/ui`, `pnpm dev`) shows every one of them in light and dark. If this file and the
code disagree, fix the file. How to build a screen: [docs/ui.md](docs/ui.md).

## Overview

**The Familiar Workbench.** An app people use for hours to get work done, so it should feel
like the tools they already know (Linear, GitHub, Stripe dashboard, Vercel): a left sidebar, a
thin header with breadcrumbs, one clear page title, tables and forms in plain cards. Calm,
dense enough for real data, neutral greys with one blue accent, no decoration. Brand lives in
the logo, the primary color and the copy, never in effects. A product built on the starter
changes `--primary` (and maybe `--radius` and the font) and stays conventional.

Anti-references: marketing-site flourish inside the app (gradients, glass, glow, oversized
hero type), dashboards made of identical metric cards, icon tiles above every heading.

## Colors

Semantic roles only. Every color in the UI comes from a CSS variable through a Tailwind token
(`bg-background`, `text-muted-foreground`, `border-border`, `bg-primary`...). Light and dark
are two values of the same roles; the theme follows the OS by default and the user can pin it.

### Primary

Blue (`--primary`, `#2463eb` light / `#3c83f6` dark). One primary action per view (the button
that moves the task forward), the current nav item's focus ring, links. Never for large fills.

### Neutral

- `background` / `foreground`: the page and its text (17:1 contrast).
- `card`, `popover`: raised surfaces, same as background in light, one step lighter in dark.
- `muted` / `muted-foreground`: subtle fills (skeletons, kbd, table header hover) and secondary
  text (descriptions, captions, timestamps). Secondary text is at least 4.5:1 on both
  `background` and `muted`.
- `accent`: hover and selected rows/items.
- `border` / `input`: hairlines and field outlines.
- `sidebar*`: the sidebar's own set, one step off the page background.

### Status

- `destructive`: errors, invalid fields, irreversible actions. Red text meets 4.5:1 in both
  themes.
- Success and warning have no tokens on purpose: use neutral toasts with an icon, and words
  ("Saved", "Expires in 3 days") instead of more colors. Add a token to `index.css` and this
  file if a product truly needs one; never an ad-hoc `text-green-600`.

### Named rules

- **No raw colors.** No hex, rgb, Tailwind palette classes (`bg-blue-500`, `text-gray-400`) or
  inline styles in app code. Exceptions live only in `index.css`.
- **Contrast is tested,** not eyeballed: axe runs on every page and the gallery in both themes.

## Typography

System UI font stack (`ui-sans-serif, system-ui, sans-serif`): native on every OS, no font
download, no layout shift. A product may set its own sans in `@theme` (one family, variable,
self-hosted); keep the scale.

### Hierarchy

- Page title: `text-2xl font-semibold tracking-tight` (24px), exactly one `h1` per page, via
  `PageHeader`.
- Section title: `text-lg font-semibold` (18px), `h2`.
- Card title: `CardTitle` (16px semibold).
- Body: `text-sm` (14px) is the default in app UI; `text-base` only for long reading.
- Secondary and captions: `text-sm`/`text-xs` with `text-muted-foreground`.
- Numbers in tables: `tabular-nums`, right-aligned when they are compared.

Sentence case everywhere (titles, buttons, menu items, labels). No all-caps labels, no
letter-spaced eyebrows above titles.

## Layout

- App shell: sidebar 256px (collapsible to icons, `Ctrl/⌘ B`; a sheet under 768px), sticky
  56px header with sidebar toggle, breadcrumbs, search/command palette and theme toggle.
- Page body: `PageContainer` max 1024px (`max-w-5xl`) for lists, 768px (`max-w-3xl`) for detail
  pages and forms; padding 16px mobile, 32px from `md`.
- Vertical rhythm: 24px (`space-y-6`) between page blocks, 16px inside cards and between form
  fields, 8px between a label and its control.
- Spacing comes from the Tailwind 4px scale only (`gap-2`, `p-4`, `space-y-6`); no arbitrary
  values like `mt-[13px]`.
- Density: comfortable-compact. 36px controls, about 52px table rows, 14px text. Do not enlarge for
  "air"; do not shrink below 32px targets on touch.
- Responsive down to 360px wide: everything stacks, tables scroll horizontally inside their
  border, page actions wrap under the title.

## Elevation & Depth

Mostly flat, separated by borders. Cards: 1px border plus `shadow-sm`. Menus, popovers,
selects: `shadow-md`. Dialogs and sheets: `shadow-lg` over a 50% black overlay. Nothing else
gets a shadow; no glows, no colored shadows, no blur effects.

## Shapes

`--radius` is 8px; the scale derives from it: `rounded-sm` 4px (menu items), `rounded-md` 6px
(buttons, inputs, popovers), `rounded-lg` 8px (dialogs, table frame, empty states),
`rounded-xl` 12px (cards), `rounded-full` (badges, avatars, switches). Change `--radius` to
reshape the whole app; never set a one-off radius.

## Components

Use the catalog. Every item below is in `apps/web/src/components` and in the gallery.

### Buttons

`Button` variants: `default` (primary, one per view), `outline` (secondary actions), `ghost`
(toolbars, row actions, icon buttons), `secondary`, `link`, `destructive` (only the confirming
button of a destructive action). Sizes `sm`/`default`/`lg`/`icon`. Icons sit left of the label;
icon-only buttons always have an `aria-label`. While a request runs: disable it and, for slow
actions, show `Spinner` plus a progressive label ("Saving…").

### Inputs / Fields

`Input`, `Textarea`, `Select` (fewer than ~10 options), `Combobox` (searchable),
`Checkbox`, `RadioGroup` (2–5 mutually exclusive options, all visible), `Switch` (settings
that apply immediately), `DatePicker`. Forms use `Form` (react-hook-form + zod): label above,
help text below, the error message under the field after submit; `aria-invalid` turns the
outline red. Validate on submit, then on change.

### Cards / Containers

`Card` with `CardHeader` (title, description, `CardAction` on the right), `CardContent`,
`CardFooter` (actions right-aligned). Never a card inside a card; use spacing or a divider.

### Navigation

`AppShell` sidebar groups (plain labels, no icons on group labels), `PageBreadcrumbs` (from
route `staticData.crumbs`), `Tabs` for views of one object, `DataTable` pagination, the command
palette (`Ctrl/⌘ K`) which lists every nav target automatically.

### Data

`DataTable` (TanStack Table): sortable headers (`sortable('Name')`), a filter box, client-side
pagination, `RowActions` "…" menu at the row end with destructive items last and in red.

### Overlays and feedback

`Dialog` for short tasks, `Sheet` for side panels and mobile nav, `ConfirmDialog`
(AlertDialog) before every destructive or irreversible action, `Popover`, `Tooltip` for icon
buttons and shortcuts only, `DropdownMenu`. Toasts (`sonner`, neutral style) confirm what just
happened ("Created Apollo"); errors that block the page use `ErrorState`, not a toast.

### Screen states (every data screen)

- Loading: skeletons shaped like the content (`ListSkeleton`, `Skeleton`), never a lone spinner
  on a blank page.
- Empty: `EmptyState` says what belongs here and offers the one action that adds it.
- Error: `ErrorState` names what failed, shows the reason and a Retry button.
- `QueryView` / `DataTable` wire all three to a TanStack query; use them.

## Do's and Don'ts

### Do:

- Build from `components/ui` and `components/patterns`; add new shadcn components with the CLI
  (`pnpm dlx shadcn@latest add <name>` in `apps/web`), then add them to the gallery.
- Keep one primary button per view and put it top-right (page) or bottom-right (dialog).
- Cover loading, empty and error on every screen; test them in the gallery.
- Check light, dark and a 390px-wide viewport before you call a screen done.
- Write copy for the user's task: sentence case, verbs on buttons ("Create project", not "OK"
  or "Submit"), concrete numbers, no exclamation marks, no jargon, no blame ("Could not save
  the project", not "You entered invalid data").
- Name the thing in destructive confirmations: "Delete Apollo?" + what is lost + "This cannot
  be undone." + a button that repeats the verb ("Delete project").

### Don't:

- Don't use raw colors, arbitrary sizes (`text-[13px]`, `w-[317px]`) or inline styles.
- Don't add gradients, gradient text, glassmorphism, glows, thick colored side borders on
  cards, or icon tiles above headings (the `impeccable` detector flags them).
- Don't nest cards, stack identical metric cards as a "dashboard", or center everything.
- Don't hide actions behind hover only; touch has no hover.
- Don't use a toast for errors the user must act on, or a modal for things a page can show.
- Don't invent a component the catalog already has (dialogs, menus, selects, tables).
