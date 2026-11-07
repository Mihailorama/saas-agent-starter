import { getCollection } from 'astro:content';
import type { Post } from './content.config.ts';

/** Published posts, newest first (drafts are only shown by `astro dev`). */
export async function posts(): Promise<Post[]> {
  const all = (await getCollection('blog')) as Post[];
  return all
    .filter((p) => import.meta.env.DEV || !p.data.draft)
    .sort((a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime());
}
