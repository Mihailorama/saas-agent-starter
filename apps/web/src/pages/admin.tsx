// Operator console (docs/admin.md): internal, for the operator and support staff only. The API
// enforces access (/api/admin, requireOperator); this layout only shows what it answers.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Building2, ShieldAlert, Users } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth';
import { cn } from '@/lib/utils';

export const PAGE = 50;
export const dateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–';
export const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs';

/** Asks for the reason every operator action needs (stored in the audit log), then runs it. */
export function ReasonDialog({
  trigger,
  title,
  description,
  confirm,
  destructive,
  children,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirm: string;
  destructive?: boolean;
  children?: ReactNode;
  onConfirm: (reason: string, form: FormData) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    try {
      await onConfirm(String(form.get('reason')).trim(), form);
      setOpen(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" aria-label={title}>
          {children}
          <div className="space-y-2">
            <Label htmlFor="reason">Reason (kept in the audit log)</Label>
            <textarea
              id="reason"
              name="reason"
              required
              minLength={3}
              maxLength={500}
              rows={3}
              placeholder="Ticket number and what you are doing"
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs"
            />
          </div>
          <DialogFooter>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'default'}
              disabled={pending}
            >
              {confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "View as user": the API swaps the session cookie, so reload into the app as that user. */
export async function viewAs(userId: string, reason: string, orgId?: string) {
  await api(`/api/admin/users/${userId}/impersonate`, {
    method: 'POST',
    json: { reason, ...(orgId && { orgId }) },
  });
  window.location.assign('/');
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export const Yes = ({ on, yes = 'on', no = 'off' }: { on: boolean; yes?: string; no?: string }) => (
  <Badge variant={on ? 'secondary' : 'outline'}>{on ? yes : no}</Badge>
);

const navLink =
  'flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
const navActive = 'bg-accent font-medium text-foreground!';

export function AdminShell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const onOrgs = useLocation({
    select: (l) => l.pathname === '/admin' || l.pathname.startsWith('/admin/orgs'),
  });
  const me = useQuery({
    queryKey: ['admin', 'me'],
    queryFn: () => api<{ id: string; email: string }>('/api/admin/me'),
    retry: false,
  });

  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }
  if (me.isError) {
    const expired = me.error.message.includes('sign in again');
    const noTotp = me.error.message.includes('two-factor');
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-xl">
              {expired ? 'Sign in again' : noTotp ? 'Two-factor required' : 'Not available'}
            </CardTitle>
            <CardDescription>
              {expired
                ? 'Operator sessions are short-lived. Sign in again to continue.'
                : noTotp
                  ? 'Operators need two-factor authentication. Turn it on under Security.'
                  : 'This page is not available for your account.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            {expired ? (
              <Button
                onClick={async () => {
                  await authClient.signOut();
                  queryClient.clear();
                  navigate({ to: '/sign-in', search: { redirect: '/admin' } });
                }}
              >
                Sign in again
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link to={noTotp ? '/settings/security' : '/'}>
                  {noTotp ? 'Security settings' : 'Back to the app'}
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-muted/30 md:flex">
        <div className="flex h-14 items-center gap-2 px-4 font-semibold">
          <ShieldAlert className="size-5 text-primary" /> Operator console
        </div>
        <nav className="mt-2 flex-1 space-y-1 px-2">
          <Link to="/admin" className={cn(navLink, onOrgs && navActive)}>
            <Building2 className="size-4" /> Organizations
          </Link>
          <Link to="/admin/users" className={navLink} activeProps={{ className: navActive }}>
            <Users className="size-4" /> Users
          </Link>
        </nav>
        <div className="border-t p-3 text-xs text-muted-foreground">
          <p className="truncate">{me.data.email}</p>
          <Link to="/" className="mt-2 flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="size-3" /> Back to the app
          </Link>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-4 border-b px-4 text-sm md:hidden">
          <Link to="/admin">Organizations</Link>
          <Link to="/admin/users">Users</Link>
        </header>
        <main className="flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
