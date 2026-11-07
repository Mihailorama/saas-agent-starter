# Product

<!-- impeccable:product-schema 1 -->

This file describes the starter's built-in app. A product built on the starter replaces the
Users, Product Purpose, Positioning and Evidence sections with its own facts (keep the rest
unless it changes them). Read by the `impeccable` design skill and by coding agents.

## Platform

web

## Users

People at work, signed in to an organization (tenant) they belong to, on a laptop most of the
day and sometimes on a phone. Two roles matter for the UI: members (do the work: projects,
files, AI summaries) and admins/owners (also manage API keys, webhooks, security policy and
the AI call log). Some users rely on a keyboard or a screen reader.

## Product Purpose

A multi-tenant SaaS starter: the signed-in app (`apps/web`) where an organization's members
create and manage projects, upload files, review AI-generated summaries, and where admins
manage integrations and security. Success for the UI: a new product built on the starter
ships screens that look and behave like the tools its users already know, without a designer,
and every screen handles loading, empty and error.

## Positioning

The starter is the scaffold, not the brand. Its UI is deliberately conventional (sidebar app
shell, tables, forms, dialogs on shadcn/ui) so products differ by what they do, not by how
unusual their buttons are.

## Operating Context

Daily, task-focused use: scan a list, open an item, edit it, come back. Many tabs, keyboard
shortcuts (`Ctrl/⌘ K` command palette, `Ctrl/⌘ B` sidebar), light and dark mode following the
OS. Organizations may be in any country; copy is English by default and must stay
translatable (no text in images, no concatenated sentences).

## Capabilities and Constraints

- Stack: React, Vite, TanStack Router/Query/Table, Tailwind CSS 4, shadcn/ui (Radix), lucide
  icons, sonner toasts, react-hook-form + zod. No Next.js.
- Components are copied source in `apps/web/src/components/ui`; patterns in
  `apps/web/src/components/patterns`; the dev gallery at `/dev/ui` (development builds only).
- Every code dependency must pass the license gate (permissive or MPL-2.0, docs/adr/0005).
- Content Security Policy: no inline scripts; no third-party fonts or CDNs by default.
- AI-generated content is labeled and reviewable by a human (`AiBadge`, confirm/correct).
- Analytics only through `track()` with catalogued events; never put free text or ids in them.

## Brand Commitments

None beyond the conventions in DESIGN.md. The default name is "Workspace" with a layers icon
and a blue primary; products replace all three.

## Evidence on Hand

No customers, testimonials, metrics or screenshots ship with the starter. Do not invent them in
UI copy, empty states or examples; sample data uses invented names (Apollo, Ada Lovelace) and
`example.com` addresses.

## Product Principles

1. Familiar beats novel: use the pattern users already know from mainstream SaaS tools.
2. Every state is designed: loading, empty, error and success are part of the screen.
3. One obvious next step per view.
4. Accessible by default: keyboard, screen reader and contrast are tested in CI, not hoped for.
5. Calm interface, loud content: the data and the user's work carry the page, not decoration.

## Accessibility & Inclusion

WCAG 2.2 AA. axe-core runs on every page and the gallery in light and dark mode (serious and
critical violations fail CI); Biome's a11y lint rules are errors; Lighthouse accessibility
≥ 0.95 on public pages. Touch targets at least 24px and visible focus rings.
