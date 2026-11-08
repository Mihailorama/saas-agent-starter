import { useSyncExternalStore } from 'react';

/** What the user picked; `system` follows the OS and is the default. public/theme.js applies it before first paint. */
export type ThemeChoice = 'light' | 'dark' | 'system';
type Theme = 'light' | 'dark';

const listeners = new Set<() => void>();
const media = matchMedia('(prefers-color-scheme: dark)');
const notify = () => {
  for (const l of listeners) l();
};

const choice = (): ThemeChoice => {
  const saved = localStorage.getItem('theme');
  return saved === 'light' || saved === 'dark' ? saved : 'system';
};
const resolved = (): Theme =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light';

function apply() {
  const c = choice();
  document.documentElement.classList.toggle(
    'dark',
    c === 'dark' || (c === 'system' && media.matches),
  );
  notify();
}

media.addEventListener('change', () => {
  if (choice() === 'system') apply();
});

export function setTheme(theme: ThemeChoice) {
  if (theme === 'system') localStorage.removeItem('theme');
  else localStorage.setItem('theme', theme);
  apply();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The theme on screen right now. */
export const useTheme = (): Theme => useSyncExternalStore(subscribe, resolved);
/** The stored choice, for the toggle. */
export const useThemeChoice = (): ThemeChoice => useSyncExternalStore(subscribe, choice);
