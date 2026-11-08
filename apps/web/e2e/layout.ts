// Deterministic layout guards (docs/ui.md "Visual checks"): DOM checks, no pixels and no
// baseline, so they block everywhere (pnpm check and CI). Used by e2e/layout.spec.ts on every
// gallery section, reference screen and public page at desktop/mobile x light/dark, and by
// expectAccessible() (e2e/axe.ts) on every page the e2e suite scans.
import { expect, type Page } from '@playwright/test';

// Text that must be fully visible. `truncate`/`line-clamp` (text-overflow: ellipsis or a line
// clamp) are deliberate and skipped.
const TEXT = 'h1, h2, h3, h4, h5, h6, button, a, label, th, td, [data-slot="badge"], [role="tab"]';
const INTERACTIVE =
  'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="radio"], [role="combobox"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';

/** Runs in the page: every layout problem as one line of text, empty when the page is clean. */
function findLayoutProblems([textSel, interactiveSel]: [string, string]): string[] {
  const problems: string[] = [];
  const name = (el: Element) => {
    const id = el.id ? `#${el.id}` : '';
    const label =
      el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    return `<${el.tagName.toLowerCase()}${id}> "${label.slice(0, 40)}"`;
  };
  const shown = (el: Element) => {
    if (el.closest('[aria-hidden="true"], [inert], .sr-only')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0)
        return false;
    }
    return true;
  };

  // clientWidth, not innerWidth: a phone zooms out to fit wide content, so innerWidth grows too.
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1)
    problems.push(
      `horizontal overflow: page is ${doc.scrollWidth}px wide, viewport ${doc.clientWidth}px`,
    );

  // Text that leaves its element: spilling over neighbours (overflow visible) or cut off (hidden).
  // Measured on the text itself, so icons, focus rings and padding do not count.
  for (const el of document.querySelectorAll<HTMLElement>(textSel)) {
    if (!shown(el)) continue;
    const s = getComputedStyle(el);
    if (s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none') continue;
    const box = el.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent?.trim() || !shown(t.parentElement!)) continue;
      const p = t.parentElement!;
      const ps = getComputedStyle(p);
      if (ps.textOverflow === 'ellipsis' || ps.webkitLineClamp !== 'none') continue;
      range.selectNodeContents(t);
      const r = range.getBoundingClientRect();
      if (
        r.left < box.left - 1 ||
        r.right > box.right + 1 ||
        r.top < box.top - 1 ||
        r.bottom > box.bottom + 1
      ) {
        problems.push(
          `clipped text: ${name(el)} text is ${Math.round(r.width)}x${Math.round(r.height)}px, box ${Math.round(box.width)}x${Math.round(box.height)}px`,
        );
        break;
      }
    }
  }

  const controls = [...document.querySelectorAll<HTMLElement>(interactiveSel)].filter(
    (el) => shown(el) && getComputedStyle(el).pointerEvents !== 'none',
  );
  const rects = controls.map((el) => el.getBoundingClientRect());
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]!;
      const b = controls[j]!;
      if (a.contains(b) || b.contains(a)) continue;
      const ra = rects[i]!;
      const rb = rects[j]!;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      // 2px: borders that touch or share a pixel row are fine.
      if (w > 2 && h > 2) problems.push(`overlapping controls: ${name(a)} and ${name(b)}`);
    }
  }

  for (const img of document.querySelectorAll('img')) {
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src'))
      problems.push(`broken image: ${img.getAttribute('src')}`);
  }
  return problems;
}

export async function layoutProblems(page: Page): Promise<string[]> {
  await page.waitForLoadState('load');
  return page.evaluate(findLayoutProblems, [TEXT, INTERACTIVE] as [string, string]);
}

export async function expectGoodLayout(page: Page, name: string) {
  expect(await layoutProblems(page), `layout: ${name}`).toEqual([]);
}

/** Collects console errors and uncaught exceptions from now on; check with `.toEqual([])`. */
export function watchConsole(page: Page, { apiDown = false } = {}): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    // apiDown: the page runs on the bare dev server, so its /api calls fail by design.
    if (apiDown && new URL(m.location().url, 'http://x').pathname.startsWith('/api/')) return;
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
  return errors;
}
