// Site-wide settings, read at build time. Edit the texts here; URLs come from env (.env.example).
for (const file of ['../../../.env', '../../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}
const env = process.env;

export const locales = ['en'] as const;

export const site = {
  name: 'Workspace',
  tagline: 'Projects, AI summaries and audit trails for small teams.',
  description:
    'Workspace keeps your team’s projects in one place, drafts AI summaries you can confirm or correct, and logs every change.',
  /** Canonical origin of the site, e.g. https://example.com (no trailing slash needed). */
  url: env.SITE_URL || 'http://localhost:4321',
  /** Where "Sign in" / "Start free" point: the web app. */
  appUrl: env.SITE_APP_URL || 'http://localhost:5173',
  /** Absolute URL of a 1200x630 share image hosted outside the repo (no media in git). */
  ogImage: env.SITE_OG_IMAGE || undefined,
  /** X/Twitter handle for twitter:site, e.g. @example. */
  twitter: env.SITE_TWITTER || undefined,
  organization: {
    name: 'Example Inc.',
    /** Profiles that identify the company (LinkedIn, GitHub, X...): schema.org sameAs. */
    sameAs: [] as string[],
  },
  /** schema.org SoftwareApplication. Google wants offers (or ratings) for the rich result. */
  product: {
    category: 'BusinessApplication',
    operatingSystem: 'Web',
    offers: { price: '0', priceCurrency: 'USD' },
  },
};

/** Absolute URL on the site for a path ("/blog/" -> https://example.com/blog/). */
export const abs = (path: string) => new URL(path, site.url).href;
