// Layout guards (e2e/layout.ts), axe and console errors on the gallery, the reference screens and the public pages, per
// project of playwright.visual.config.ts (desktop/mobile x light/dark). Blocking everywhere: no
// baseline, no human. The pixel comparison against main is scripts/visual.mjs (local only).
import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe';
import { layoutProblems, watchConsole } from './layout';
import { pages } from './visual-pages';

test.describe.configure({ timeout: 120_000 });

for (const { path, ready } of pages) {
  test(`layout ${path}`, async ({ page }) => {
    const errors = watchConsole(page, { apiDown: true });
    await page.goto(path);
    await ready(page);
    await expectAccessible(page, path);
    expect(errors, `console: ${path}`).toEqual([]);
  });
}

// The guards themselves: a deliberately broken page must trip every one of them.
test('the guards catch a broken page', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-light'), 'one viewport is enough');
  const errors = watchConsole(page);
  await page.setContent(`
    <!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
    <body><main>
      <div style="width: 900px">wider than the phone</div>
      <button style="width: 40px; height: 20px; overflow: hidden; white-space: nowrap">
        Save all the changes</button>
      <a href="#a" style="position: absolute; top: 100px; left: 10px; width: 80px">One</a>
      <a href="#b" style="position: absolute; top: 105px; left: 20px; width: 80px">Two</a>
      <img alt="logo" src="data:image/png;base64,broken">
      <span class="truncate" style="display: block; width: 20px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap">deliberately truncated</span>
    </main>
    <script>console.error('boom')</script></body></html>`);
  const problems = await layoutProblems(page);
  expect(problems.map((p) => p.split(':')[0])).toEqual([
    'horizontal overflow',
    'clipped text',
    'overlapping controls',
    'broken image',
  ]);
  expect(errors).toEqual(['console.error: boom']);

  await page.setContent('<main><h1>Fine</h1><button>Save</button> <a href="#x">Link</a></main>');
  expect(await layoutProblems(page)).toEqual([]);
});
