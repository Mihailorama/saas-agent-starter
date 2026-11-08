// Visual regression (playwright.visual.config.ts): each gallery section, each reference screen
// and the public pages, per project (desktop/mobile x light/dark). How to accept a change: docs/ui.md.
import { expect, test } from '@playwright/test';

const screens = ['list', 'detail', 'form', 'settings', 'empty', 'loading', 'error'];

test('gallery sections', async ({ page }) => {
  await page.goto('/dev/ui');
  // The first visit compiles the lazily loaded gallery on the dev server.
  await expect(page.getByRole('heading', { name: 'UI gallery' })).toBeVisible({ timeout: 30_000 });
  const sections = page.locator('[data-gallery-section]');
  const ids = await sections.evaluateAll((els) => els.map((e) => e.id));
  expect(ids.length).toBeGreaterThan(10);
  for (const id of ids) {
    await expect.soft(page.locator(`#${id}`)).toHaveScreenshot(`gallery-${id}.png`);
  }
});

for (const screen of screens) {
  test(`screen ${screen}`, async ({ page }) => {
    await page.goto(`/dev/ui/screens/${screen}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot(`screen-${screen}.png`, { fullPage: true });
  });
}

for (const path of ['/sign-in', '/ai-transparency']) {
  test(`page ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page).toHaveScreenshot(`page${path.replaceAll('/', '-')}.png`, { fullPage: true });
  });
}
