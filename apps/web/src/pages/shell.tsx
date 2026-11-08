import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
} from '@tanstack/react-router';
import {
  Bug,
  Building2,
  CalendarClock,
  Check,
  ChevronsUpDown,
  Cookie,
  Cpu,
  CreditCard,
  Eye,
  FolderKanban,
  KeyRound,
  LifeBuoy,
  Lightbulb,
  Lock,
  LogOut,
  MessageCircle,
  Plus,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Webhook,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AppShell, type NavGroup } from '@/components/patterns/app-shell';
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
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { identify, privacyChoicesLabel, showPrivacyChoices, track } from '@/lib/analytics';
import { authClient } from '@/lib/auth';
import { bookingUrl, onBookingClick } from '@/lib/booking';
import { useFlag } from '@/lib/flags';
import { openSupport, resetSupport, supportEnabled } from '@/lib/support';
import { policyQuery, TWO_FACTOR_REQUIRED } from '@/pages/security';

/** API error text for members of a suspended organization (apps/api/src/operator-guard.ts). */
const ORG_SUSPENDED = 'organization suspended';

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
    track('org_created');
    await queryClient.invalidateQueries();
    toast.success(`Created ${name}`);
    onDone?.();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="New organization">
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
          <SidebarMenuButton size="lg">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Building2 className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">
              <span className="sr-only">Switch organization: </span>
              {active?.name ?? 'Select organization'}
            </span>
            <ChevronsUpDown className="text-muted-foreground" />
          </SidebarMenuButton>
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
  const user = session?.user;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg">
          <Avatar className="size-8">
            <AvatarFallback className="text-xs">{initials(user?.name ?? '?')}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-medium">{user?.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{user?.email}</span>
          </span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" align="start" side="top">
        <DropdownMenuItem onSelect={() => navigate({ to: '/settings/security' })}>
          <ShieldCheck className="size-4" /> Security
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate({ to: '/settings/privacy' })}>
          <Lock className="size-4" /> Privacy
        </DropdownMenuItem>
        {user?.role === 'operator' && !session?.session.impersonatedBy && (
          <DropdownMenuItem onSelect={() => navigate({ to: '/admin' })}>
            <ShieldAlert className="size-4" /> Operator console
          </DropdownMenuItem>
        )}
        {privacyChoicesLabel && (
          <DropdownMenuItem onSelect={showPrivacyChoices}>
            <Cookie className="size-4" /> {privacyChoicesLabel}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await authClient.signOut();
            identify(undefined);
            resetSupport();
            navigate({ to: '/sign-in' });
          }}
        >
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The one entry point for questions, problem reports and ideas (Chatwoot, docs/support.md). */
function HelpMenu() {
  const { data: active } = authClient.useActiveOrganization();
  const open = (kind: Parameters<typeof openSupport>[0]) => () =>
    openSupport(kind, active?.id).catch(() => toast.error('Help is unavailable right now'));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton>
          <LifeBuoy /> <span>Help</span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" align="start" side="top">
        <DropdownMenuItem onSelect={open('question')}>
          <MessageCircle className="size-4" /> Ask a question
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={open('bug')}>
          <Bug className="size-4" /> Report a problem
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={open('feature_request')}>
          <Lightbulb className="size-4" /> Suggest an improvement
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Persistent while an operator views the app as this user (docs/admin.md). */
function ImpersonationBanner({ name, email, until }: { name: string; email: string; until: Date }) {
  const [pending, setPending] = useState(false);
  async function stop() {
    setPending(true);
    const res = await fetch('/api/impersonation/stop', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = (await res.json().catch(() => ({}))) as { userId?: string };
    // Full reload: every cached query belongs to the viewed user.
    window.location.assign(body.userId ? `/admin/users/${body.userId}` : '/admin');
  }
  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-black"
    >
      <Eye className="size-4" />
      <span>
        Viewing as {name} ({email}). Read-only: changes are blocked. Ends at{' '}
        {until.toLocaleTimeString(undefined, { timeStyle: 'short' })}.
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 bg-white"
        onClick={stop}
        disabled={pending}
      >
        Stop viewing
      </Button>
    </div>
  );
}

/** Books a call with the team (Cal.diy / Cal.com, docs/crm.md); prefilled with the user. */
function TalkToUs() {
  const { data: session } = authClient.useSession();
  const user = session?.user;
  return (
    <SidebarMenuButton asChild>
      <a
        href={bookingUrl}
        target="_blank"
        rel="noopener"
        onClick={(e) => onBookingClick(e, 'app', { name: user?.name, email: user?.email })}
      >
        <CalendarClock /> <span>Talk to us</span>
      </a>
    </SidebarMenuButton>
  );
}

/** What members of a suspended organization see instead of its pages. */
function SuspendedNotice() {
  return (
    <Card className="mx-auto mt-8 max-w-md">
      <CardHeader>
        <CardTitle className="text-xl">This organization is suspended</CardTitle>
        <CardDescription>
          Its data and API keys are not available right now. Nothing has been deleted. Contact
          support to find out why and how to restore access, or switch to another organization.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

export function Shell() {
  const { data: orgs, isPending } = authClient.useListOrganizations();
  const { data: member } = authClient.useActiveMember();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  // An operator viewing as the user: their browsing must not join the user's analytics person.
  const viewedBy = session?.session.impersonatedBy;
  useEffect(() => {
    if (userId && !viewedBy) identify(userId);
  }, [userId, viewedBy]);
  const onSecurity = useLocation({ select: (l) => l.pathname === '/settings/security' });
  // Breadcrumbs are declared per route (`staticData.crumbs` in main.tsx).
  const crumbs = useMatches().at(-1)?.staticData.crumbs ?? [];
  // Org requires 2FA and this user has none: the API refuses tenant data, so enrol first.
  const policy = useQuery({ ...policyQuery, enabled: Boolean(orgs?.length) });
  const mustEnrol = policy.error?.message === TWO_FACTOR_REQUIRED;
  const suspended = policy.error?.message === ORG_SUSPENDED;
  // UI hint only; the API enforces the role.
  const isAdmin = member?.role.split(',').some((r) => r === 'admin' || r === 'owner') ?? false;
  const byoProviders = useFlag('byo-llm-providers');
  // "Talk to us": configured (booking host + link) and rolled out (flag), docs/crm.md.
  const booking = useFlag('booking') && Boolean(bookingUrl) && !viewedBy;

  const banner = viewedBy && session && (
    <ImpersonationBanner
      name={session.user.name}
      email={session.user.email}
      until={new Date(session.session.expiresAt)}
    />
  );

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  if (mustEnrol && !onSecurity) return <Navigate to="/settings/security" />;

  if (!orgs?.length) {
    return (
      <>
        {banner}
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
      </>
    );
  }

  const nav: NavGroup[] = [
    {
      items: [
        {
          label: 'Projects',
          icon: FolderKanban,
          to: '/',
          active: (p) => p === '/' || p.startsWith('/projects'),
        },
        ...(isAdmin ? [{ label: 'AI calls', icon: ScrollText, to: '/ai-calls' as const }] : []),
        { label: 'Billing', icon: CreditCard, to: '/settings/billing' as const },
      ],
    },
    ...(isAdmin
      ? [
          {
            label: 'Settings',
            items: [
              { label: 'API keys', icon: KeyRound, to: '/settings/api-keys' as const },
              { label: 'Webhooks', icon: Webhook, to: '/settings/webhooks' as const },
              ...(byoProviders
                ? [{ label: 'AI providers', icon: Cpu, to: '/settings/ai-providers' as const }]
                : []),
            ],
          },
        ]
      : []),
  ];

  return (
    <AppShell
      nav={nav}
      crumbs={crumbs}
      banner={banner}
      sidebarHeader={
        <SidebarMenu>
          <SidebarMenuItem>
            <OrgSwitcher />
          </SidebarMenuItem>
        </SidebarMenu>
      }
      sidebarFooter={
        <SidebarMenu>
          {booking && (
            <SidebarMenuItem>
              <TalkToUs />
            </SidebarMenuItem>
          )}
          {supportEnabled && !viewedBy && (
            <SidebarMenuItem>
              <HelpMenu />
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="sm" className="text-muted-foreground">
              <Link to="/ai-transparency">
                <Sparkles /> <span>How we use AI</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <UserMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      }
    >
      {suspended ? <SuspendedNotice /> : <Outlet />}
    </AppShell>
  );
}
