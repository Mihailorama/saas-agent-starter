# Transactional email

Better Auth sends three mails: the sign-in code (sign-in and sign-up, ADR 0033), an
email-verification code where Better Auth verifies an address by itself, and organization
invitations. The privacy flows add "your data export is ready". Design:
[ADR 0014](adr/0014-transactional-email.md).

```
Better Auth callback (apps/api/src/auth.ts)
  -> renderEmail(): React Email renderer, EN/RU by Accept-Language, HTML + plain text
  -> startSendEmail(): Temporal workflow `SendEmailWorkflow`, task queue `email`
  -> worker (services/worker-py/worker/mail.py): one SMTP delivery per attempt, retried
```

The callbacks run after the HTTP response (`advanced.backgroundTasks`), so a code request for
an unknown address answers exactly like one for a real account. An SMTP outage does not lose
mail: Temporal retries the activity (5 s, doubling, at most 5 min apart) for up to 1 hour; a
code lives 5 minutes, so a late one is useless and the user asks for a new one. A recipient the server refuses
(unknown mailbox, policy) fails at once, without retries.

## Configuration

| Variable           | Where  | Default (`.env.example`)           | Meaning                                                |
| ------------------ | ------ | ---------------------------------- | ------------------------------------------------------ |
| `SMTP_URL`         | worker | `smtp://localhost:1025?tls=none`   | SMTP server, see below                                 |
| `MAIL_FROM`        | worker | `Workspace <no-reply@example.com>` | From header; its domain must be set up at the provider |
| `EMAIL_TASK_QUEUE` | both   | `email`                            | Temporal task queue of `SendEmailWorkflow`             |
| `BETTER_AUTH_URL`  | API    | `http://localhost:5173`            | Origin the links point to (web origin, `/api` proxied) |

`SMTP_URL` forms (credentials URL-encoded, e.g. `@` as `%40`):

- `smtps://user:pass@smtp.example.com:465`: TLS from the first byte (port 465 by default).
- `smtp://user:pass@smtp.example.com:587`: STARTTLS, required: the worker refuses to send if
  the server does not offer it (port 587 by default).
- `smtp://localhost:1025?tls=none`: plain text, for the local Mailpit only.

The EU and RU contours differ only in these variables. Switching providers is an env change
and a DNS change, no code.

## Local development: Mailpit

`docker compose up -d mailpit` (part of the default stack and of the infra line in AGENTS.md)
catches every mail. Web UI and REST API: http://localhost:8025 (`MAILPIT_UI_PORT`), SMTP on
`localhost:1025` (`MAILPIT_SMTP_PORT`). Nothing leaves the machine. The integration tests read
the mails from its API (`MAILPIT_URL`) and type the codes, so `pnpm check` needs Mailpit and
a running worker (`pnpm worker`).

## Choosing a provider

Any SMTP relay works. Mainstream options with an SMTP endpoint, checked on their own docs on
2026-11-07:

EU (data processed in the EU):

- **Brevo** (France): `smtp-relay.brevo.com`, ports 587 / 465 / 2525, login = SMTP login,
  password = an SMTP key (not an API key)
  ([setup](https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP),
  [ports](https://help.brevo.com/hc/en-us/articles/115000188150-Troubleshooting-Issues-with-Brevo-SMTP)).
- **Scaleway Transactional Email** (France): `smtp.tem.scaleway.com`, 587 (STARTTLS) or 465
  (TLS); encryption is mandatory
  ([docs](https://www.scaleway.com/en/docs/transactional-email/reference-content/smtp-configuration)).
- **Mailgun, EU region**: `smtp.eu.mailgun.org` (the domain must be created in the EU region)
  ([docs](https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview)).
- **Amazon SES, EU region**: e.g. `email-smtp.eu-central-1.amazonaws.com` (Frankfurt),
  STARTTLS on 587 or TLS on 465
  ([endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html),
  [connecting](https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html)).

RU (data stays in Russia, 152-FZ):

- **Yandex Cloud Postbox**: `postbox.cloud.yandex.net`, 587 (STARTTLS) or 465 (SMTPS),
  username = API key id, password = its secret
  ([docs](https://yandex.cloud/en/docs/postbox/operations/send-email)).
- **Unisender Go**: `smtp.go1.unisender.ru` or `smtp.go2.unisender.ru` (by the account's
  installation), ports 25 / 465 / 587, encrypted connections only
  ([docs](https://godocs.unisender.ru/smtp-api)).

Example: `SMTP_URL=smtp://<key-id>:<secret>@postbox.cloud.yandex.net:587`.

## Sender domain: SPF, DKIM, DMARC

Gmail requires SPF or DKIM from every sender and SPF + DKIM + DMARC from bulk senders
([Gmail sender guidelines](https://support.google.com/a/answer/81126)); other large mailbox
providers behave alike. Use a subdomain for app mail (e.g. `mail.example.com`, From
`no-reply@mail.example.com`) so its reputation is separate from people's mail.

1. **SPF**: one TXT record on the sending domain listing the provider, e.g.
   `v=spf1 include:<provider's SPF host> ~all`. Exactly one SPF record per name; merge
   `include:`s if there are several senders. Many providers use their own bounce domain for
   SPF (custom MAIL FROM / return-path): follow their instructions for it.
2. **DKIM**: the provider generates the key; publish the TXT or CNAME records it shows,
   then verify the domain in its console. This is what makes the mail "signed by" your domain.
3. **DMARC**: TXT at `_dmarc.<domain>`. Start with
   `v=DMARC1; p=none; rua=mailto:dmarc@example.com`, read the aggregate reports for a few
   weeks, then move to `p=quarantine` and `p=reject` once only your providers pass.

Check a real mail's headers (`Authentication-Results: spf=pass dkim=pass dmarc=pass`) before
going live.

## Bounces, complaints, delivery visibility

- There is no email log table on purpose (ADR 0014). Each delivery is a Temporal workflow
  (`email-<kind>-<hash>`, visible in the Temporal UI with its attempts and failure), the worker
  logs one JSON line per attempt (kind, workflow id, attempt, SMTP error class and code; never
  the address, link or server reply), and failed attempts go to Sentry/GlitchTip.
- SMTP accepting a message only means the provider took it. Hard bounces and spam complaints
  arrive later at the provider; all of the above keep a suppression list and stop sending to
  those addresses on their own. Watch their dashboard, or wire their bounce/complaint webhook
  to your alerting when volumes grow (docs/TODO.md).
- A retry after a lost SMTP reply can deliver the same mail twice; harmless for these links.

## Templates and languages

`apps/api/src/email.ts`: one layout, four account mails and one marketing example, strings per locale in a small map (`en`,
`ru`). The locale is the best match of the request's `Accept-Language` (the browser sends it),
English otherwise. Add a language by adding its block to `COPY`. These strings move to
i18next when the web gets an i18n framework. Templates are `createElement` calls, not JSX: the
API runs `.ts` files through Node's type stripping, which has no JSX transform. Rendering uses
`@react-email/render` only; the components packages of React Email are deprecated and the
`react-email` package brings its preview CLI along.

## Marketing mail

Everything above is account (transactional) mail and goes to every user. Non-transactional mail
(product news, offers) is separate: its templates are listed in `MARKETING_KINDS`, it goes only to
users who opted in (`user.marketing_opt_in`), and every message carries an unsubscribe link plus
the `List-Unsubscribe` / `List-Unsubscribe-Post` headers (RFC 8058, one-click), which Gmail and
Yahoo require from bulk senders. Send it only through `sendMarketingEmail` in
`apps/api/src/legal.ts`; `pnpm check:legal` fails if a marketing template lacks any of it. Details:
docs/legal.md.

The one-click POST only counts when the message's DKIM signature covers both headers (RFC 8058
section 4). We do not sign: the SMTP provider does. Check that its signing includes
`List-Unsubscribe` and `List-Unsubscribe-Post` (the `h=` list of `DKIM-Signature` on a received
message); most providers that advertise RFC 8058 support do, some need a setting.
