import { expect as baseExpect, type Page, test } from '@playwright/test';

// Runs against the build with GA4 configured (playwright.config.ts). Requests that leave
// localhost are recorded and aborted. The regime meta tag is injected the way nginx does it.
test.use({ baseURL: `http://localhost:${process.env.PLAYWRIGHT_CONSENT_PORT ?? '5174'}` });
// The first page of this dev server also compiles the lazily imported consent library.
const expect = baseExpect.configure({ timeout: 15_000 });

async function open(page: Page, opts: { mode?: 'opt-out'; gpc?: boolean } = {}) {
  const google: string[] = [];
  await page.route(/^https?:\/\/(?!localhost[:/])/, (route) => {
    google.push(new URL(route.request().url()).hostname);
    return route.abort();
  });
  if (opts.mode) {
    await page.route('**/sign-in', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(
        '<head>',
        `<head><meta name="consent-mode" content="${opts.mode}">`,
      );
      await route.fulfill({ response: res, body });
    });
  }
  // The library stays silent for bots (navigator.webdriver), which includes Playwright.
  await page.addInitScript((gpc) => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    if (gpc)
      Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });
  }, opts.gpc ?? false);
  await page.goto('/sign-in');
  await page.waitForLoadState('networkidle');
  return google;
}

const banner = (page: Page) => page.getByRole('region', { name: 'Usage analytics' });

test('opt-in: nothing loads before "Allow", withdrawing stops it again', async ({ page }) => {
  const google = await open(page);
  await expect(banner(page)).toBeVisible();
  expect(google).toEqual([]);

  await banner(page).getByRole('button', { name: 'Allow' }).click();
  await expect.poll(() => google).toContain('www.googletagmanager.com');

  google.length = 0;
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(banner(page)).toBeHidden();
  expect(google).toContain('www.googletagmanager.com');

  // Withdraw: cookies are cleared and the page reloads without the sink.
  await page.getByRole('button', { name: 'Cookie settings' }).click();
  const prefs = page.getByRole('dialog', { name: 'Privacy choices' });
  await prefs.getByRole('button', { name: 'Only necessary' }).click();
  await page.waitForLoadState('networkidle');
  google.length = 0;
  await page.reload();
  await page.waitForLoadState('networkidle');
  expect(google).toEqual([]);
});

test('opt-out: loads right away until the user says no', async ({ page }) => {
  const google = await open(page, { mode: 'opt-out' });
  await expect.poll(() => google).toContain('www.googletagmanager.com');
  await expect(
    page.getByRole('button', { name: 'Do Not Sell or Share My Personal Information' }),
  ).toBeVisible();

  // Saying no on the banner stops the running sink: its cookies go, the page reloads without it.
  google.length = 0;
  await Promise.all([
    page.waitForEvent('load'),
    banner(page).getByRole('button', { name: 'Only necessary' }).click(),
  ]);
  await page.waitForLoadState('networkidle');
  expect(google).toEqual([]);
});

test('opt-out with Global Privacy Control: nothing loads, no banner', async ({ page }) => {
  const google = await open(page, { mode: 'opt-out', gpc: true });
  await expect(banner(page)).toBeHidden();
  expect(google).toEqual([]);
});
