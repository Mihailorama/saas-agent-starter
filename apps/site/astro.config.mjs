// Marketing site + blog (docs/marketing.md). Static build: `pnpm --filter site build` -> dist/.
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, passthroughImageService } from 'astro/config';
import { base, locales, site } from './src/site.ts';

export default defineConfig({
  site: site.url,
  // A path in SITE_URL (GitHub Pages: https://owner.github.io/repo) becomes the base.
  base,
  trailingSlash: 'always',
  // hreflang-ready: add a locale here and its pages under src/pages/<locale>/ (docs/marketing.md).
  i18n: {
    defaultLocale: locales[0],
    locales: [...locales],
    routing: { prefixDefaultLocale: false },
  },
  // No sharp (its libvips is LGPL-3.0): images are served as authored (ADR 0021).
  image: { service: passthroughImageService() },
  integrations: [
    mdx(),
    sitemap({
      filter: (page) => !page.endsWith('/404/'),
      i18n: { defaultLocale: locales[0], locales: Object.fromEntries(locales.map((l) => [l, l])) },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    // The shared track()/consent code (apps/web/src/lib/analytics.ts) reads the web's VITE_* env.
    envPrefix: ['PUBLIC_', 'VITE_'],
    // Scripts as files, never inline: the CSP allows script-src 'self' only.
    build: { assetsInlineLimit: 0 },
  },
});
