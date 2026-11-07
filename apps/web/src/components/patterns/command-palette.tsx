import type { CommandAction } from '@/components/patterns/command-menu';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';

/** The palette dialog itself (cmdk); its own chunk, loaded by CommandMenu on first open. */
export function CommandPalette({
  commands,
  open,
  setOpen,
}: {
  commands: CommandAction[];
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const groups = [...new Set(commands.map((c) => c.group))];
  return (
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
  );
}
