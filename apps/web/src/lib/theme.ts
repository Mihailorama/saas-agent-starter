import { useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';
const listeners = new Set<() => void>();
const current = (): Theme =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light';

export function setTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  localStorage.setItem('theme', theme);
  for (const l of listeners) l();
}

export function useTheme(): Theme {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, current);
}
