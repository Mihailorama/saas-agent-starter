import { defineConfig, devices } from '@playwright/test';

for (const file of ['../../.env', '../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}

// Override when 5173 is taken (e.g. agents running in parallel).
const webPort = process.env.PLAYWRIGHT_PORT ?? '5173';

export default defineConfig({
  testDir: 'e2e',
  retries: process.env.CI ? 1 : 0,
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
  ],
});
