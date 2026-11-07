import { type LucideIcon, Search } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { Kbd } from '@/components/ui/kbd';
import { modKey, useHotkey } from '@/lib/hotkeys';

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
  useHotkey('k', () => setOpen((o) => !o), { mod: true });
  const groups = [...new Set(commands.map((c) => c.group))];

  return (
    <>
      <Button
        variant="outline"
        className="h-8 w-9 justify-start gap-2 px-2 text-muted-foreground sm:w-56 sm:px-3"
        onClick={() => setOpen(true)}
      >
        <Search aria-hidden />
        {/* Visible from sm up; screen readers always get it (the name must match the text). */}
        <span className="sr-only flex-1 text-left font-normal sm:not-sr-only">Search…</span>
        <Kbd className="hidden sm:inline-flex">{modKey} K</Kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Go to a page or run an action."
      >
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No matching commands.</CommandEmpty>
          {groups.map((group) => (
            <CommandGroup key={group} heading={group}>
              {commands
                .filter((c) => c.group === group)
                .map(({ label, icon: Icon, keywords, shortcut, run }) => (
                  <CommandItem
                    key={label}
                    keywords={keywords}
                    onSelect={() => {
                      setOpen(false);
                      run();
                    }}
                  >
                    {Icon && <Icon aria-hidden />}
                    {label}
                    {shortcut && <CommandShortcut>{shortcut}</CommandShortcut>}
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  );
}
