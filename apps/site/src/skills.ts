// Agent skills that come with the starter, for the "What is inside" page (pages/stack.astro).
// Ours are Claude Code commands in .claude/commands (the repo's license); third-party ones are
// opt-in and keep their own license. scripts/site-stack.test.mjs checks that every command file
// is listed here and every listed one exists.
export type Skill = {
  name: string;
  group: 'Build' | 'Product' | 'Design' | 'Trust';
  text: string;
  href: string;
};

const repo = 'https://github.com/Mihailorama/saas-agent-starter/blob/main';

/** Ours: `.claude/commands/<name>.md`, MIT-0 like the rest of the repository. */
export const ownSkills: Skill[] = [
  {
    name: 'add-resource',
    group: 'Build',
    text: 'adds a resource end to end: table with tenant isolation, API, tests, page',
    href: `${repo}/.claude/commands/add-resource.md`,
  },
  {
    name: 'validate-idea',
    group: 'Product',
    text: 'stress-tests a business idea and turns it into a plan for real demand signals',
    href: `${repo}/.claude/commands/validate-idea.md`,
  },
  {
    name: 'ui-council',
    group: 'Design',
    text: 'several models score screenshots until every one rates the UI at the target; opt-in',
    href: `${repo}/.claude/commands/ui-council.md`,
  },
  {
    name: 'save-secret',
    group: 'Trust',
    text: 'puts a credential into the team vault instead of chat, .env or git',
    href: `${repo}/.claude/commands/save-secret.md`,
  },
];

/** Others', installed by you, never vendored into the repository. */
export const thirdPartySkills: (Skill & { author: string; license: string })[] = [
  {
    name: 'founder-skill',
    author: 'Jake Schincariol',
    license: 'MIT',
    group: 'Product',
    text: '11 skills: board, competitors, consumer panel, pricing, CFO, offer, marketing, launch, brand, ops, plan. Registered at a pinned commit, not enabled until you install it',
    href: 'https://github.com/Jakeschincariol/founder-skill',
  },
  {
    name: 'impeccable',
    author: 'Paul Bakaus',
    license: 'Apache-2.0',
    group: 'Design',
    text: 'design critique and audit for agents; its detector also runs in CI',
    href: 'https://github.com/pbakaus/impeccable',
  },
];
