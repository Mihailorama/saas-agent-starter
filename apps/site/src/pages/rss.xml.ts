import rss from '@astrojs/rss';
import { posts } from '../posts.ts';
import { abs, site } from '../site.ts';

export async function GET() {
  return rss({
    title: `${site.name} blog`,
    description: site.description,
    site: abs('/'),
    items: (await posts()).map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.pubDate,
      link: `/blog/${p.id}/`,
    })),
  });
}
