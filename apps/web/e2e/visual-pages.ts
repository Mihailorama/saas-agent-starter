// The pages the visual checks cover (layout.spec.ts, visual.spec.ts): the dev gallery, every
// reference screen and the public pages. Screenshot ids derive from these paths (docs/ui.md).
import { expect, type Page } from '@playwright/test';

const screens = ['list', 'detail', 'form', 'settings', 'empty', 'loading', 'error'];
// The first visit to each page compiles its lazily loaded route on the dev server, which on a busy
// machine takes longer than the default 5 s; a page that is merely slow is not broken.
const firstLoad = { timeout: 30_000 };

export const pages: { path: string; id: string; ready: (page: Page) => Promise<void> }[] = [
  {
    path: '/dev/ui',
    id: 'gallery',
    // The first visit compiles the lazily loaded gallery on the dev server.
    ready: (page) =>
      expect(page.getByRole('heading', { name: 'UI gallery' })).toBeVisible(firstLoad),
  },
  ...screens.map((s) => ({
    path: `/dev/ui/screens/${s}`,
    id: `screen-${s}`,
    ready: (page: Page) => expect(page.getByRole('heading', { level: 1 })).toBeVisible(firstLoad),
  })),
  ...['/sign-in', '/ai-transparency'].map((path) => ({
    path,
    id: `page${path.replaceAll('/', '-')}`,
    ready: (page: Page) => expect(page.getByRole('heading').first()).toBeVisible(firstLoad),
  })),
];
