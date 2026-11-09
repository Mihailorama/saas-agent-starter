import { defineConfig, devices } from '@playwright/test';

for (const file of ['../../.env', '../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}

// Layout guards (e2e/layout.spec.ts) and screenshots (e2e/visual.spec.ts) of the dev UI gallery
// and the public pages at desktop/mobile x light/dark (docs/ui.md). Only the web dev server is
// needed. scripts/visual.mjs drives the screenshots: it points VISUAL_WEB_DIR at a worktree of
// the merge-base with main for the expected side, and VISUAL_SNAPSHOT_DIR at its cached shots.
// Screenshots are never committed (no media in git) and never compared in CI.
const port = process.env.VISUAL_PORT ?? '5177';
const out = process.env.VISUAL_OUT ?? '.visual/run';
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } };
const mobile = {
  ...devices['Pixel 7'],
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
};

export default defineConfig({
  testDir: 'e2e',
  testMatch: ['layout.spec.ts', 'visual.spec.ts'],
  outputDir: `${out}/results`,
  snapshotPathTemplate: `${process.env.VISUAL_SNAPSHOT_DIR ?? '.visual/snapshots'}/{projectName}/{arg}{ext}`,
  updateSnapshots: 'none',
  fullyParallel: true,
  reporter: [['list'], ['json', { outputFile: `${out}/results.json` }]],
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 },
  },
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    { name: 'desktop-light', use: { ...desktop, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { ...desktop, colorScheme: 'dark' } },
    { name: 'mobile-light', use: { ...mobile, colorScheme: 'light' } },
    { name: 'mobile-dark', use: { ...mobile, colorScheme: 'dark' } },
  ],
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    cwd: process.env.VISUAL_WEB_DIR,
    url: `http://localhost:${port}`,
    // Never reuse: the expected side must be served from main's worktree, not from `pnpm dev`.
    reuseExistingServer: false,
  },
});
