import { type LucideIcon, Search } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { modKey, useHotkey } from '@/lib/hotkeys';

const CommandPalette = lazy(() =>
  import('@/components/patterns/command-palette').then((m) => ({ default: m.CommandPalette })),
);

export type CommandAction = {
  label: string;
  /** "Go to", "Actions", "Preferences": one group per kind of command. */
  group: string;
  icon?: LucideIcon;
  /** Extra search words (e.g. "dark" for "Theme: dark"). */
  keywords?: string[];
  /** Printed hint for a shortcut the action also has, e.g. `${modKey} B`. */
  shortcut?: string;
  run: () => void;
};

/**
 * The command palette: ⌘K / Ctrl+K anywhere, or the search button in the header. Every
 * navigation target and frequent action belongs in it, so keyboard users never need the mouse.
 */
export function CommandMenu({ commands }: { commands: CommandAction[] }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const toggle = (next: boolean) => {
    setLoaded(true);
    setOpen(next);
  };
  useHotkey('k', () => toggle(!open), { mod: true });

  return (
    <>
      <Button
        variant="outline"
        className="h-8 w-9 justify-start gap-2 px-2 text-muted-foreground sm:w-56 sm:px-3"
        onClick={() => toggle(true)}
      >
        <Search aria-hidden />
        {/* Visible from sm up; screen readers always get it (the name must match the text). */}
        <span className="sr-only flex-1 text-left font-normal sm:not-sr-only">Search…</span>
        <Kbd className="hidden sm:inline-flex">{modKey} K</Kbd>
      </Button>
      {/* cmdk and the dialog load on first open, not with the app; then stay mounted. */}
      {loaded && (
        <Suspense fallback={null}>
          <CommandPalette commands={commands} open={open} setOpen={setOpen} />
        </Suspense>
      )}
    </>
  );
}
