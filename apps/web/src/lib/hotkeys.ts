import { useEffect, useRef } from 'react';

export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
/** How to print the modifier: ⌘ on Apple devices, Ctrl elsewhere. */
export const modKey = isMac ? '⌘' : 'Ctrl';

/**
 * Global keyboard shortcut. `mod` means Cmd on macOS and Ctrl elsewhere. Plain-key shortcuts
 * are ignored while the user types in a field; modifier shortcuts work everywhere.
 * Every shortcut must also be reachable without the keyboard (a button or a menu item).
 */
export function useHotkey(key: string, handler: () => void, { mod = false } = {}) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key || (isMac ? e.metaKey : e.ctrlKey) !== mod) return;
      const t = e.target as HTMLElement | null;
      if (!mod && t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, mod]);
}
