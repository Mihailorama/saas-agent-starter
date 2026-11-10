import { isEnabled } from './flags.ts';

// Site-wide settings, read at build time. Edit the texts here; URLs come from env (.env.example).
for (const file of ['../../../.env', '../../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}
const env = process.env;

export const locales = ['en'] as const;

/** Canonical URL of the site, e.g. https://example.com or https://owner.github.io/repo (a path = base). */
const siteUrl = new URL(env.SITE_URL || 'http://localhost:4321');
/** Path the site is served under: "/" on its own host, "/repo/" on GitHub Pages. */
export const base = siteUrl.pathname.replace(/\/?$/, '/');

const repo = 'https://github.com/Mihailorama/saas-agent-starter';
/** "Booking a demo" page (same env as the app, docs/crm.md), behind the `booking` flag. */
const booking =
  isEnabled('booking') && env.VITE_BOOKING_ORIGIN && env.VITE_BOOKING_LINK
    ? `${env.VITE_BOOKING_ORIGIN.replace(/\/+$/, '')}/${env.VITE_BOOKING_LINK}`
    : undefined;

export const site = {
  /** Brand on the page. The repository and packages keep their names until the rename. */
  name: 'Orgfold',
  /** The repository's current name, for schema.org alternateName and llms.txt. */
  repoName: 'saas-agent-starter',
  tagline: 'an agentic organization in a box',
  description:
    'Orgfold is an open-source agentic organization in a box: sign-in, billing, CRM, support, analytics, an AI gateway and deploys, built for coding agents.',
  /** Canonical origin of the site (no path; the path is `base`). */
  url: siteUrl.origin,
  /** The source repository: the landing page's main call to action. */
  repo,
  /**
   * "Talk to us" target of the managed offer: ONE value, a mailto: or a booking page.
   * PLACEHOLDER until orgfold.com has a mailbox (SAASSTARTER-90): set SITE_CONTACT_URL (or turn
   * on the booking flag); without either the button opens a GitHub issue "Managed Orgfold".
   */
  contact:
    env.SITE_CONTACT_URL ||
    booking ||
    `${repo}/issues/new?title=${encodeURIComponent('Managed Orgfold')}`,
  /**
   * Contact channels shown next to "Talk to us" (email, Telegram, WhatsApp). Only channels with a
   * value appear: SITE_CONTACT_EMAIL, SITE_TELEGRAM_URL (e.g. https://t.me/<bot>), SITE_WHATSAPP_URL
   * (e.g. https://wa.me/<number>). Add a messenger only once someone answers it.
   */
  channels: [
    {
      id: 'email',
      label: 'Email',
      href: env.SITE_CONTACT_EMAIL ? `mailto:${env.SITE_CONTACT_EMAIL}` : '',
    },
    { id: 'telegram', label: 'Telegram', href: env.SITE_TELEGRAM_URL || '' },
    { id: 'whatsapp', label: 'WhatsApp', href: env.SITE_WHATSAPP_URL || '' },
  ].filter((c) => c.href),
  /** Where "Sign in" points (the web app); no link without SITE_APP_URL. */
  appUrl: env.SITE_APP_URL || undefined,
  /** Absolute URL of a 1200x630 share image hosted outside the repo (no media in git). */
  ogImage: env.SITE_OG_IMAGE || undefined,
  /** "Book a demo" target (flag `booking`); the landing uses it through `contact`. */
  booking,
  /** X/Twitter handle for twitter:site, e.g. @example. */
  twitter: env.SITE_TWITTER || undefined,
  organization: {
    /** Publisher shown in the footer and schema.org; set SITE_ORG_NAME for your product. */
    name: env.SITE_ORG_NAME || 'Orgfold',
    /** Profiles that identify the publisher (LinkedIn, GitHub, X...): schema.org sameAs. */
    sameAs: ['https://github.com/Mihailorama/saas-agent-starter'] as string[],
  },
};

/** Site path with the base prepended ("/blog/" -> "/repo/blog/" on GitHub Pages). */
export const path = (p: string) => base + p.replace(/^\//, '');
/** Absolute URL on the site for a base-less path ("/blog/" -> https://example.com/blog/). */
export const abs = (p: string) => new URL(path(p), site.url).href;
