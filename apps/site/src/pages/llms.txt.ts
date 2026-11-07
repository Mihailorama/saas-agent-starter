import { posts } from '../posts.ts';
import { abs, site } from '../site.ts';

// llms.txt (https://llmstxt.org): a Markdown map of the site for LLMs, built from the content.
export async function GET() {
  const blog = (await posts()).map(
    (p) => `- [${p.data.title}](${abs(`/blog/${p.id}/`)}): ${p.data.description}`,
  );
  const body = [
    `# ${site.name}`,
    '',
    `> ${site.tagline} ${site.description}`,
    '',
    '## Pages',
    '',
    `- [Home](${abs('/')}): what ${site.name} is, features, FAQ`,
    `- [Blog](${abs('/blog/')}): all articles`,
    `- [Sign up](${new URL('/', site.appUrl).href}): the app`,
    '',
    '## Blog',
    '',
    ...blog,
    '',
    '## Optional',
    '',
    `- [RSS feed](${abs('/rss.xml')})`,
    `- [Sitemap](${abs('/sitemap-index.xml')})`,
    '',
  ];
  return new Response(body.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
