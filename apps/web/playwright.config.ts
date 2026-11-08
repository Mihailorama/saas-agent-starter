import { defineConfig, devices } from '@playwright/test';

for (const file of ['../../.env', '../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}

// The operator console spec (e2e/admin.spec.ts) signs up this operator; the API it starts below
// inherits the list. Set here once, so the test workers see the same address.
process.env.E2E_OPERATOR_EMAIL ??= `operator-${Date.now()}@example.com`;
process.env.OPERATOR_EMAILS ??= process.env.E2E_OPERATOR_EMAIL;

// Override when 5173 is taken (e.g. agents running in parallel).
const webPort = process.env.PLAYWRIGHT_PORT ?? '5173';
const consentPort = process.env.PLAYWRIGHT_CONSENT_PORT ?? '5174';
const bookingPort = process.env.PLAYWRIGHT_BOOKING_PORT ?? '5175';
const onboardingPort = process.env.PLAYWRIGHT_ONBOARDING_PORT ?? '5176';
// Booking configured everywhere (docs/crm.md); only the build on bookingPort turns its flag on.
const booking = { VITE_BOOKING_ORIGIN: 'https://cal.example.com', VITE_BOOKING_LINK: 'acme/demo' };

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
      // The API side of the `onboarding` flag (only the build on onboardingPort shows its UI), and
      // that build's origin, which e2e/onboarding.spec.ts writes from.
      env: {
        FLAGS_ON: [process.env.FLAGS_ON, 'onboarding'].filter(Boolean).join(','),
        CORS_ORIGINS: [process.env.CORS_ORIGINS, `http://localhost:${onboardingPort}`]
          .filter(Boolean)
          .join(','),
      },
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
    // The same app with the `onboarding` flag on, for e2e/onboarding.spec.ts.
    {
      command: `pnpm dev --port ${onboardingPort} --strictPort`,
      env: { VITE_FLAGS_ON: 'onboarding' },
      url: `http://localhost:${onboardingPort}`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
