import { defineConfig, devices } from '@playwright/test';

for (const file of ['../../.env', '../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}

// Visual regression of the dev UI gallery and the public pages (docs/ui.md). Baselines are NOT
// in git (no media in the repo): CI produces them on main and keeps them as a workflow artifact;
// PR runs download the latest one into .visual/baseline and compare. Locally the first run
// writes a baseline, later runs compare against it. Only the web dev server is needed.
const port = process.env.PLAYWRIGHT_PORT ?? '5173';
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } };
const mobile = { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 };

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'visual.spec.ts',
  outputDir: '.visual/results',
  snapshotPathTemplate: '.visual/baseline/{projectName}/{arg}{ext}',
  updateSnapshots: process.env.CI ? 'none' : 'missing',
  fullyParallel: true,
  reporter: [
    ['list'],
    ['html', { outputFolder: '.visual/report', open: 'never' }],
    ['json', { outputFile: '.visual/results.json' }],
  ],
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
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
