import { posts } from '../posts.ts';
import { abs, site } from '../site.ts';

// llms.txt (https://llmstxt.org): a Markdown map of the site for LLMs, built from the content.
// Key facts must match the landing page and the repository; no marketing adjectives.
export async function GET() {
  const doc = (p: string, text: string, name = p) =>
    `- [${name}](${site.repo}/blob/main/${p}): ${text}`;
  const blog = (await posts()).map(
    (p) => `- [${p.data.title}](${abs(`/blog/${p.id}/`)}): ${p.data.description}`,
  );
  const body = [
    `# ${site.name}`,
    '',
    `> ${site.description}`,
    '',
    '## Key facts',
    '',
    '- Open-source template for multi-tenant B2B SaaS, written for coding agents (Claude Code, Codex).',
    '- Stack: TypeScript (Fastify API, React and Vite web), Python worker on Temporal, Rust via PyO3, Postgres with row-level security.',
    '- AGENTS.md holds the rules and step-by-step recipes; `pnpm check` is the single definition of done.',
    '- License: MIT No Attribution (MIT-0); code dependencies are permissive or MPL-2.0, checked in CI.',
    '- Self-hosted: Docker Compose locally, `pnpm run infra` sets up a VPS.',
    '',
    '## Pages',
    '',
    `- [Home](${abs('/')}): what ${site.name} is, how it works, FAQ`,
    `- [Blog](${abs('/blog/')}): all articles`,
    ...(site.appUrl ? [`- [Sign up](${new URL('/', site.appUrl).href}): the app`] : []),
    '',
    '## Docs',
    '',
    `- [Source code](${site.repo}): the repository, README with the full feature list and quickstart`,
    doc(
      'AGENTS.md',
      'rules for coding agents: architecture map, where code goes, recipes, security and AI rules',
    ),
    doc('docs/setup.md', 'one-command server setup: install, connect or skip each component'),
    doc('docs/STACK.md', 'measured memory use of the default and optional services'),
    `- [Architecture decisions](${site.repo}/tree/main/docs/adr): one record per component choice`,
    doc('LICENSE', 'MIT No Attribution'),
    '',
    ...(blog.length ? ['## Blog', '', ...blog, ''] : []),
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
