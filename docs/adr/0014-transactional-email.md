# 0014. Transactional email: rendered in the API, delivered by a Temporal activity

Status: accepted (owner decision, 2026-11-07)

## Context

Email/password sign-up was enabled, but nothing sent mail: no address verification, no
password reset, no organization invitations. Mail must work with any provider (the EU and RU
contours use different ones), survive SMTP outages, keep tokens out of logs and keep the code
license policy (ADR 0005).

## Decision

- **Templates in the API with React Email's renderer** (`@react-email/render`, MIT): EN/RU
  strings in a small map per template, HTML plus a plain-text part, locale from
  `Accept-Language`. Only the renderer: `@react-email/components` and the per-component
  packages are deprecated on npm, and the `react-email` package pulls its preview CLI into
  production dependencies. Templates are `createElement` calls because the API runs `.ts`
  through Node's type stripping (no JSX).
- **Delivery in the Python worker with the standard library's `smtplib`**, as a Temporal
  activity (`send_email`) inside `SendEmailWorkflow` on its own task queue `email`. The Better
  Auth callbacks only render and start the workflow, after the HTTP response
  (`advanced.backgroundTasks`), so reset requests do not reveal whether an account exists.
  Temporal retries SMTP failures for up to 1 hour (the links' lifetime); refused recipients
  fail at once. Workflow ids are a hash of the token (or invitation id + expiry) with
  `REJECT_DUPLICATE`, so a repeated callback does not mail twice.
- **One `SMTP_URL` + `MAIL_FROM`**: `smtps://` (implicit TLS), `smtp://` (STARTTLS required),
  `?tls=none` only for the local catcher. Any provider, no SDKs.
- **Mailpit (MIT) in the default dev compose** catches all mail; the integration tests and the
  Playwright smoke read it through its API and follow the links.
- **No email log table.** Delivery visibility comes from what the stack already has: the
  Temporal UI (one workflow per mail with attempts), JSON log lines and Sentry/GlitchTip
  events per failed attempt. Addresses, links and SMTP replies are never logged; the API's
  request log and spans drop query strings and the reset token in the path.

## Alternatives

- **nodemailer (MIT-0) in a TypeScript Temporal worker**, the first plan: `@temporalio/worker`
  depends on webpack, which brings `caniuse-lite` (CC-BY-4.0) and `unionfs` (no license field),
  both rejected by the license gate, and its native core has no musl build for the API's
  Alpine image. Possible later if the owner accepts those packages.
- nodemailer called inline in the API: no durable retries; a provider outage loses the mail.
- A provider HTTP API/SDK: locks the template to one provider and contour.

## Consequences

- The rendered mail, link included, is in the workflow's Temporal history until the namespace
  retention removes it. Temporal persists to the same Postgres server, where Better Auth keeps
  the same tokens, so it is no new exposure in this setup; with Temporal Cloud or a separate
  cluster add an encrypting payload codec (docs/TODO.md).
- `pnpm check` needs Mailpit and a running worker for the auth tests.
- Bounce and complaint handling stays at the provider (suppression lists); see docs/email.md.
