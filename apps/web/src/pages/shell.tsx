import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import {
  Building2,
  Check,
  ChevronsUpDown,
  FolderKanban,
  Layers,
  LogOut,
  Moon,
  Plus,
  ScrollText,
  Sparkles,
  Sun,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { authClient } from '@/lib/auth';
import { setTheme, useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const initials = (s: string) =>
  s
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function CreateOrgForm({ onDone }: { onDone?: () => void }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name')).trim();
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${crypto.randomUUID().slice(0, 6)}`;
    setPending(true);
    const { error } = await authClient.organization.create({ name, slug });
    setPending(false);
    if (error) return toast.error(error.message ?? 'Could not create organization');
    await queryClient.invalidateQueries();
    toast.success(`Created ${name}`);
    onDone?.();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="org-name">Organization name</Label>
        <Input id="org-name" name="name" placeholder="Acme Inc." required autoFocus />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        Create organization
      </Button>
    </form>
  );
}

function OrgSwitcher() {
  const queryClient = useQueryClient();
  const { data: orgs } = authClient.useListOrganizations();
  const { data: active } = authClient.useActiveOrganization();
  const [creating, setCreating] = useState(false);

  async function switchTo(organizationId: string) {
    await authClient.organization.setActive({ organizationId });
    await queryClient.invalidateQueries();
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-3 px-2 py-2"
            aria-label="Switch organization"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Building2 className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">
              {active?.name ?? 'Select organization'}
            </span>
            <ChevronsUpDown className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-60" align="start">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Organizations
          </DropdownMenuLabel>
          {orgs?.map((org) => (
            <DropdownMenuItem key={org.id} onSelect={() => switchTo(org.id)}>
              <span className="flex-1 truncate">{org.name}</span>
              {org.id === active?.id && <Check className="size-4" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <Plus className="size-4" /> New organization
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New organization</DialogTitle>
            <DialogDescription>Data is isolated per organization.</DialogDescription>
          </DialogHeader>
          <CreateOrgForm onDone={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function UserMenu() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const theme = useTheme();
  const user = session?.user;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-auto w-full justify-start gap-3 px-2 py-2">
          <Avatar className="size-8">
            <AvatarFallback className="text-xs">{initials(user?.name ?? '?')}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-medium">{user?.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{user?.email}</span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" align="start" side="top">
        <DropdownMenuItem onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await authClient.signOut();
            navigate({ to: '/sign-in' });
          }}
        >
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const navLink =
  'flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
const navActive = 'bg-accent font-medium text-foreground!';

export function Shell() {
  const { data: orgs, isPending } = authClient.useListOrganizations();
  const { data: member } = authClient.useActiveMember();
  const onLlmOps = useLocation({ select: (l) => l.pathname.startsWith('/llm-ops') });
  // UI hint only; the API enforces the role.
  const isAdmin = member?.role.split(',').some((r) => r === 'admin' || r === 'owner') ?? false;

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  if (!orgs?.length) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-xl">Create your organization</CardTitle>
            <CardDescription>
              Projects, members and files live inside an organization.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateOrgForm />
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-muted/30 md:flex">
        <div className="flex h-14 items-center gap-2 px-4 font-semibold">
          <Layers className="size-5 text-primary" /> Workspace
        </div>
        <div className="px-2">
          <OrgSwitcher />
        </div>
        <nav className="mt-4 flex-1 space-y-1 px-2">
          <Link to="/" className={cn(navLink, !onLlmOps && navActive)}>
            <FolderKanban className="size-4" /> Projects
          </Link>
          {isAdmin && (
            <Link to="/llm-ops" className={cn(navLink, onLlmOps && navActive)}>
              <ScrollText className="size-4" /> LLM Ops
            </Link>
          )}
        </nav>
        <Link
          to="/ai-transparency"
          className="mx-2 mb-2 flex items-center gap-3 rounded-md px-2 py-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Sparkles className="size-3.5" /> How we use AI
        </Link>
        <div className="border-t p-2">
          <UserMenu />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b px-4 md:hidden">
          <div className="min-w-0 flex-1">
            <OrgSwitcher />
          </div>
          <div className="w-44">
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
