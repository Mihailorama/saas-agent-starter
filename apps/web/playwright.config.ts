import { defineConfig, devices } from '@playwright/test';

for (const file of ['../../.env', '../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}

// Override when 5173 is taken (e.g. agents running in parallel).
const webPort = process.env.PLAYWRIGHT_PORT ?? '5173';
const consentPort = process.env.PLAYWRIGHT_CONSENT_PORT ?? '5174';

export default defineConfig({
  testDir: 'e2e',
  // Screenshots run with their own config (playwright.visual.config.ts, CI workflow ui.yml).
  testIgnore: 'visual.spec.ts',
  retries: process.env.CI ? 1 : 0,
  workers: 1, // the smoke flows and the consent build share one API and Mailpit
  use: { baseURL: `http://localhost:${webPort}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter api start',
      url: `http://localhost:${process.env.PORT ?? 3000}/readyz`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `pnpm dev --port ${webPort} --strictPort`,
      url: `http://localhost:${webPort}`,
      reuseExistingServer: !process.env.CI,
    },
    // The same app with GA4 configured, for e2e/consent.spec.ts (it aborts requests to Google).
    {
      command: `pnpm dev --port ${consentPort} --strictPort`,
      env: { VITE_GA4_ID: 'G-E2ETEST' },
      url: `http://localhost:${consentPort}`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
