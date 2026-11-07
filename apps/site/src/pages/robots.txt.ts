import { abs } from '../site.ts';

// SITE_NOINDEX=true (staging, previews) blocks every crawler; production allows all, AI
// crawlers included: being quotable is the point of the GEO check (docs/marketing.md).
export function GET() {
  const rule = process.env.SITE_NOINDEX === 'true' ? 'Disallow: /' : 'Allow: /';
  return new Response(`User-agent: *\n${rule}\n\nSitemap: ${abs('/sitemap-index.xml')}\n`);
}
