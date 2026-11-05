import { defineConfig, devices } from '@playwright/test';

for (const file of ['../../.env', '../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}

export default defineConfig({
  testDir: 'e2e',
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter api start',
      url: `http://localhost:${process.env.PORT ?? 3000}/readyz`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm dev --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
