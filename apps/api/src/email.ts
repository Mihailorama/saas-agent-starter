// Transactional email templates (docs/email.md). Rendered here with React Email's renderer and
// handed to the worker's SendEmailWorkflow, which delivers over SMTP with retries.
// Plain createElement calls: Node runs our .ts files by type stripping, which has no JSX.
import { plainTextSelectors, render } from '@react-email/render';
import { createElement as h, type ReactNode } from 'react';

export type Locale = 'en' | 'ru';
export type EmailKind = 'verify-email' | 'reset-password' | 'invitation';
type Vars = { name: string; org: string; inviter: string };
type Copy = {
  subject: (v: Vars) => string;
  heading: (v: Vars) => string;
  body: (v: Vars) => string;
  button: string;
  footer: string;
};

// TODO: move these strings to i18next when the web gets an i18n framework.
const COPY: Record<Locale, Record<EmailKind, Copy> & { fallback: string }> = {
  en: {
    'verify-email': {
      subject: () => 'Confirm your email address',
      heading: () => 'Confirm your email address',
      body: (v) => `Hi ${v.name}, confirm your email address to finish creating your account.`,
      button: 'Confirm email',
      footer: 'The link expires in 1 hour. If you did not sign up, you can ignore this email.',
    },
    'reset-password': {
      subject: () => 'Reset your password',
      heading: () => 'Reset your password',
      body: (v) => `Hi ${v.name}, we received a request to reset the password for your account.`,
      button: 'Choose a new password',
      footer:
        'The link expires in 1 hour. If you did not ask for this, ignore this email: your password stays the same.',
    },
    invitation: {
      subject: (v) => `${v.inviter} invited you to ${v.org}`,
      heading: (v) => `Join ${v.org}`,
      body: (v) => `${v.inviter} invited you to join the ${v.org} workspace.`,
      button: 'Accept invitation',
      footer:
        'The invitation expires in 48 hours. If you did not expect it, you can ignore this email.',
    },
    fallback: 'Or open this link:',
  },
  ru: {
    'verify-email': {
      subject: () => 'Подтвердите адрес электронной почты',
      heading: () => 'Подтвердите адрес электронной почты',
      body: (v) => `${v.name}, подтвердите адрес почты, чтобы завершить регистрацию.`,
      button: 'Подтвердить адрес',
      footer: 'Ссылка действует 1 час. Если вы не регистрировались, просто проигнорируйте письмо.',
    },
    'reset-password': {
      subject: () => 'Сброс пароля',
      heading: () => 'Сброс пароля',
      body: (v) => `${v.name}, мы получили запрос на сброс пароля к вашей учётной записи.`,
      button: 'Задать новый пароль',
      footer:
        'Ссылка действует 1 час. Если вы не запрашивали сброс, проигнорируйте письмо: пароль не изменится.',
    },
    invitation: {
      subject: (v) => `${v.inviter} приглашает вас в ${v.org}`,
      heading: (v) => `Присоединяйтесь к ${v.org}`,
      body: (v) => `${v.inviter} приглашает вас в рабочее пространство ${v.org}.`,
      button: 'Принять приглашение',
      footer: 'Приглашение действует 48 часов. Если вы его не ждали, просто проигнорируйте письмо.',
    },
    fallback: 'Или откройте ссылку:',
  },
};

/** Best supported match for an Accept-Language header; English when nothing matches. */
export function pickLocale(acceptLanguage: string | null | undefined): Locale {
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().toLowerCase().split(';');
      const q = Number(params.find((p) => p.trim().startsWith('q='))?.split('=')[1] ?? 1);
      return { lang: tag.split('-')[0], q: Number.isNaN(q) ? 0 : q };
    })
    .filter((x) => x.q > 0)
    .sort((a, b) => b.q - a.q);
  return (ranked.find((x) => x.lang === 'en' || x.lang === 'ru')?.lang as Locale) ?? 'en';
}

const text = { color: '#18181b', fontSize: '15px', lineHeight: '24px', margin: '0 0 16px' };
const muted = { ...text, color: '#71717a', fontSize: '13px', lineHeight: '20px' };

function layout(locale: Locale, preview: string, children: ReactNode[]) {
  return h(
    'html',
    { lang: locale },
    h(
      'head',
      null,
      h('meta', { httpEquiv: 'Content-Type', content: 'text/html; charset=UTF-8' }),
      h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
    ),
    h(
      'body',
      { style: { backgroundColor: '#f4f4f5', fontFamily: 'Helvetica, Arial, sans-serif' } },
      // Inbox preview line, hidden in the message itself.
      h(
        'div',
        { 'data-skip-in-text': true, style: { display: 'none', maxHeight: 0, overflow: 'hidden' } },
        preview,
      ),
      h(
        'table',
        {
          role: 'presentation',
          width: '100%',
          cellPadding: 0,
          cellSpacing: 0,
          style: { maxWidth: '520px', margin: '32px auto', backgroundColor: '#ffffff' },
        },
        h('tbody', null, h('tr', null, h('td', { style: { padding: '32px' } }, ...children))),
      ),
    ),
  );
}

export type RenderedEmail = { subject: string; html: string; text: string };

/** Subject, HTML and plain-text parts of one email. User-supplied names are escaped by React. */
export async function renderEmail(
  kind: EmailKind,
  locale: Locale,
  url: string,
  vars: Partial<Vars> = {},
): Promise<RenderedEmail> {
  const copy = COPY[locale];
  const t = copy[kind];
  // No CR/LF in names: they end up in the Subject header.
  const clean = (s = '') => s.replace(/[\r\n]+/g, ' ').trim();
  const v = { name: clean(vars.name), org: clean(vars.org), inviter: clean(vars.inviter) };
  const element = layout(locale, t.body(v), [
    h('h1', { key: 'h', style: { ...text, fontSize: '20px', fontWeight: 600 } }, t.heading(v)),
    h('p', { key: 'b', style: text }, t.body(v)),
    h(
      'p',
      { key: 'a', style: { margin: '24px 0' } },
      h(
        'a',
        {
          href: url,
          style: {
            backgroundColor: '#18181b',
            borderRadius: '6px',
            color: '#ffffff',
            display: 'inline-block',
            fontSize: '14px',
            fontWeight: 600,
            padding: '12px 20px',
            textDecoration: 'none',
          },
        },
        t.button,
      ),
    ),
    h('p', { key: 'f', style: muted }, `${copy.fallback} `, h('a', { href: url }, url)),
    h('p', { key: 'n', style: muted }, t.footer),
  ]);
  return {
    subject: t.subject(v),
    html: await render(element),
    text: await render(element, {
      plainText: true,
      htmlToTextOptions: {
        selectors: [...plainTextSelectors, { selector: 'h1', options: { uppercase: false } }],
      },
    }),
  };
}
