import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Blog posts: Markdown or MDX in src/content/blog/. Title and description limits are the SEO
// checklist (docs/marketing.md): the build fails instead of shipping a truncated snippet.
const schema = z.object({
  title: z.string().max(60),
  description: z.string().min(50).max(160),
  pubDate: z.coerce.date(),
  updatedDate: z.coerce.date().optional(),
  author: z.string(),
  draft: z.boolean().default(false),
  /** Rendered as a FAQ section with schema.org FAQPage markup. */
  faq: z.array(z.object({ q: z.string(), a: z.string() })).optional(),
});
const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema,
});
/** A post as pages use it; typed here so typechecks need no `astro sync`. */
export type Post = { id: string; data: z.output<typeof schema> };

export const collections = { blog };
