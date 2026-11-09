// Transactional email templates (docs/email.md). Rendered here with React Email's renderer and
// handed to the worker's SendEmailWorkflow, which delivers over SMTP with retries.
// Plain createElement calls: Node runs our .ts files by type stripping, which has no JSX.
import { plainTextSelectors, render } from '@react-email/render';
import { createElement as h, type ReactNode } from 'react';

export type Locale = 'en' | 'ru';
export type EmailKind = 'sign-in-code' | 'verify-email' | 'invitation' | 'data-export-ready';
type Vars = { name: string; org: string; inviter: string };
/** Code mails show the one-time code where link mails have the button. */
const CODE_KINDS: EmailKind[] = ['sign-in-code', 'verify-email'];
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
    'sign-in-code': {
      subject: () => 'Your sign-in code',
      heading: () => 'Your sign-in code',
      body: () => 'Enter this code on the sign-in page to continue.',
      button: '',
      footer:
        'The code expires in 5 minutes. If you did not try to sign in, you can ignore this email: nobody can sign in without the code.',
    },
    'verify-email': {
      subject: () => 'Confirm your email address',
      heading: () => 'Confirm your email address',
      body: () => 'Enter this code to confirm your email address.',
      button: '',
      footer:
        'The code expires in 5 minutes. If you did not ask for it, you can ignore this email.',
    },
    invitation: {
      subject: (v) => `${v.inviter} invited you to ${v.org}`,
      heading: (v) => `Join ${v.org}`,
      body: (v) => `${v.inviter} invited you to join the ${v.org} workspace.`,
      button: 'Accept invitation',
      footer:
        'The invitation expires in 48 hours. If you did not expect it, you can ignore this email.',
    },
    'data-export-ready': {
      subject: () => 'Your data export is ready',
      heading: () => 'Your data export is ready',
      body: (v) =>
        `Hi ${v.name}, the export of ${v.org ? `the ${v.org} workspace` : 'your data'} you asked for is ready. Download it from the privacy settings after signing in.`,
      button: 'Open privacy settings',
      footer:
        'The file is kept for a few days, then deleted. If you did not ask for it, contact support.',
    },
    fallback: 'Or open this link:',
  },
  ru: {
    'sign-in-code': {
      subject: () => 'Код для входа',
      heading: () => 'Код для входа',
      body: () => 'Введите этот код на странице входа, чтобы продолжить.',
      button: '',
      footer:
        'Код действует 5 минут. Если вы не пытались войти, просто проигнорируйте письмо: без кода войти нельзя.',
    },
    'verify-email': {
      subject: () => 'Подтвердите адрес электронной почты',
      heading: () => 'Подтвердите адрес электронной почты',
      body: () => 'Введите этот код, чтобы подтвердить адрес почты.',
      button: '',
      footer: 'Код действует 5 минут. Если вы его не запрашивали, просто проигнорируйте письмо.',
    },
    invitation: {
      subject: (v) => `${v.inviter} приглашает вас в ${v.org}`,
      heading: (v) => `Присоединяйтесь к ${v.org}`,
      body: (v) => `${v.inviter} приглашает вас в рабочее пространство ${v.org}.`,
      button: 'Принять приглашение',
      footer: 'Приглашение действует 48 часов. Если вы его не ждали, просто проигнорируйте письмо.',
    },
    'data-export-ready': {
      subject: () => 'Выгрузка данных готова',
      heading: () => 'Выгрузка данных готова',
      body: (v) =>
        `${v.name}, запрошенная выгрузка ${v.org ? `данных пространства ${v.org}` : 'ваших данных'} готова. Скачайте её в настройках конфиденциальности после входа.`,
      button: 'Открыть настройки',
      footer:
        'Файл хранится несколько дней, затем удаляется. Если вы её не запрашивали, напишите в поддержку.',
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

/**
 * Subject, HTML and plain-text parts of one email. `action` is the button's link, or the code for
 * code mails. User-supplied names are escaped by React.
 */
export async function renderEmail(
  kind: EmailKind,
  locale: Locale,
  action: string,
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
    ...(CODE_KINDS.includes(kind)
      ? [
          h(
            'p',
            {
              key: 'c',
              style: { ...text, fontSize: '28px', fontWeight: 600, letterSpacing: '6px' },
            },
            action,
          ),
        ]
      : [
          h(
            'p',
            { key: 'a', style: { margin: '24px 0' } },
            h(
              'a',
              {
                href: action,
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
          h('p', { key: 'f', style: muted }, `${copy.fallback} `, h('a', { href: action }, action)),
        ]),
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
