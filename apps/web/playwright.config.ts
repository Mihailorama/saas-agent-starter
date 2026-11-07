import { defineConfig, devices } from '@playwright/test';

for (const file of ['../../.env', '../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}

// Override when 5173 is taken (e.g. agents running in parallel).
const webPort = process.env.PLAYWRIGHT_PORT ?? '5173';
const consentPort = process.env.PLAYWRIGHT_CONSENT_PORT ?? '5174';
const bookingPort = process.env.PLAYWRIGHT_BOOKING_PORT ?? '5175';
// Booking configured everywhere (docs/crm.md); only the build on bookingPort turns its flag on.
const booking = { VITE_BOOKING_ORIGIN: 'https://cal.example.com', VITE_BOOKING_LINK: 'acme/demo' };

export default defineConfig({
  testDir: 'e2e',
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
      env: booking,
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
    // The same app with the `booking` flag on, for e2e/booking.spec.ts.
    {
      command: `pnpm dev --port ${bookingPort} --strictPort`,
      env: { ...booking, VITE_FLAGS_ON: 'booking' },
      url: `http://localhost:${bookingPort}`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
