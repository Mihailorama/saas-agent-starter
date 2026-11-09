// Shared by the e2e specs: axe-core (MPL-2.0, unmodified) accessibility scan of the current page,
// plus the layout guards (layout.ts) on the same page.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { expectGoodLayout } from './layout';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Fails on serious or critical WCAG A/AA violations (minor and moderate ones are printed) and on
 * any layout problem: overflow, clipped text, overlapping controls, broken images.
 */
export async function expectAccessible(page: Page, name: string) {
  // No transitions or animations: axe would sample half-faded dialogs or half-switched themes.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const describe = (v: (typeof violations)[number]) =>
    `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes
      .slice(0, 5)
      .map((n) => n.target.join(' '))
      .join('\n    ')}`;
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const other = violations.filter((v) => !blocking.includes(v));
  if (other.length)
    console.log(`axe ${name}, not blocking:\n  ${other.map(describe).join('\n  ')}`);
  expect(blocking.map(describe), `axe: ${name}`).toEqual([]);
  await expectGoodLayout(page, name);
}

/** Runs the check in light and in dark mode (contrast differs); the app follows the OS by default. */
export async function expectAccessibleInBothThemes(page: Page, name: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveClass(colorScheme === 'dark' ? /dark/ : /^(?!.*dark)/);
    await expectAccessible(page, `${name} (${colorScheme})`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}
