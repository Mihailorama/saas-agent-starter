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

export const site = {
  name: 'saas-agent-starter',
  tagline: 'The SaaS starter coding agents build on rails.',
  description:
    'Open-source, production-ready multi-tenant SaaS starter for Claude Code and Codex: AGENTS.md rules, recipes, one pnpm check, a license gate and evals.',
  /** Canonical origin of the site (no path; the path is `base`). */
  url: siteUrl.origin,
  /** The source repository: the landing page's main call to action. */
  repo: 'https://github.com/Mihailorama/saas-agent-starter',
  /** Where "Sign in" points (the web app); no link without SITE_APP_URL. */
  appUrl: env.SITE_APP_URL || undefined,
  /** Absolute URL of a 1200x630 share image hosted outside the repo (no media in git). */
  ogImage: env.SITE_OG_IMAGE || undefined,
  /** "Book a demo" target: the booking page (same env as the app, docs/crm.md); flag `booking`. */
  booking:
    isEnabled('booking') && env.VITE_BOOKING_ORIGIN && env.VITE_BOOKING_LINK
      ? `${env.VITE_BOOKING_ORIGIN.replace(/\/+$/, '')}/${env.VITE_BOOKING_LINK}`
      : undefined,
  /** X/Twitter handle for twitter:site, e.g. @example. */
  twitter: env.SITE_TWITTER || undefined,
  organization: {
    name: 'The saas-agent-starter authors',
    /** Profiles that identify the publisher (LinkedIn, GitHub, X...): schema.org sameAs. */
    sameAs: ['https://github.com/Mihailorama/saas-agent-starter'] as string[],
  },
};

/** Site path with the base prepended ("/blog/" -> "/repo/blog/" on GitHub Pages). */
export const path = (p: string) => base + p.replace(/^\//, '');
/** Absolute URL on the site for a base-less path ("/blog/" -> https://example.com/blog/). */
export const abs = (p: string) => new URL(path(p), site.url).href;
