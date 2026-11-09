// Screenshots for the local comparison against main (scripts/visual.mjs, docs/ui.md): each
// gallery section, each reference screen and the public pages, per project (desktop/mobile x
// light/dark). Never committed; never compared in CI.
import { expect, test } from '@playwright/test';
import { pages } from './visual-pages';

for (const { path, id, ready } of pages) {
  test(`screenshot ${id}`, async ({ page }) => {
    await page.goto(path);
    await ready(page);
    if (id !== 'gallery') {
      await expect.soft(page).toHaveScreenshot(`${id}.png`, { fullPage: true });
      return;
    }
    const sections = page.locator('[data-gallery-section]');
    const ids = await sections.evaluateAll((els) => els.map((e) => e.id));
    expect(ids.length).toBeGreaterThan(10);
    for (const s of ids)
      await expect.soft(page.locator(`#${s}`)).toHaveScreenshot(`gallery-${s}.png`);
  });
}
