import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Eye } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, formatDate } from '@/lib/api';
import { dateTime, PAGE, ReasonDialog, Section, selectClass, viewAs, Yes } from '@/pages/admin';

type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  twoFactor: boolean;
  operator: boolean;
  orgs: number;
  lastSignInAt: string | null;
  createdAt: string;
};
type UserDetail = UserRow & {
  passkeys: { id: string; name: string | null; createdAt: string | null }[];
  signInMethods: string[];
  memberships: { orgId: string; name: string; role: string; suspended: boolean }[];
  sessions: {
    id: string;
    createdAt: string;
    expiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
    impersonatedBy: string | null;
  }[];
  operatorActions: {
    action: string;
    actorEmail: string | null;
    reason: string | null;
    expiresAt: string | null;
    createdAt: string;
  }[];
};

export function AdminUsersPage() {
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const users = useQuery({
    queryKey: ['admin', 'users', q, offset],
    queryFn: () =>
      api<{ items: UserRow[]; total: number }>(
        `/api/admin/users?${new URLSearchParams({ ...(q && { q }), limit: String(PAGE), offset: String(offset) })}`,
      ),
    placeholderData: keepPreviousData,
  });
  const total = users.data?.total ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
      <div className="max-w-sm space-y-1">
        <Label htmlFor="u-q">Search</Label>
        <Input
          id="u-q"
          placeholder="Email, name or id"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOffset(0);
          }}
        />
      </div>
      {users.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load users</AlertTitle>
          <AlertDescription>{users.error.message}</AlertDescription>
        </Alert>
      ) : users.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>2FA</TableHead>
                  <TableHead className="text-right">Orgs</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data.items.length ? (
                  users.data.items.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>
                        <Link
                          to="/admin/users/$userId"
                          params={{ userId: u.id }}
                          className="font-medium hover:underline"
                        >
                          {u.name}
                        </Link>
                        {u.operator && (
                          <Badge variant="secondary" className="ml-2">
                            operator
                          </Badge>
                        )}
                        <span className="block text-xs text-muted-foreground">{u.email}</span>
                      </TableCell>
                      <TableCell>
                        <Yes on={u.emailVerified} yes="verified" no="unverified" />
                      </TableCell>
                      <TableCell>
                        <Yes on={u.twoFactor} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{u.orgs}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {dateTime(u.lastSignInAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(u.createdAt)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="h-16 text-center text-muted-foreground">
                      No user matches.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : '0 users'}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE >= total}
                onClick={() => setOffset(offset + PAGE)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function AdminUserPage() {
  const { userId } = useParams({ from: '/admin/users/$userId' });
  const queryClient = useQueryClient();
  const user = useQuery({
    queryKey: ['admin', 'user', userId],
    queryFn: () => api<UserDetail>(`/api/admin/users/${userId}`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin'] });

  if (user.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load the user</AlertTitle>
        <AlertDescription>{user.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (user.isPending) return <Skeleton className="h-64 w-full" />;
  const u = user.data;
  const act = (path: string, done: string) => async (reason: string) => {
    await api(`/api/admin/users/${u.id}/${path}`, { method: 'POST', json: { reason } });
    toast.success(done);
    await refresh();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{u.name}</h1>
          <p className="text-sm text-muted-foreground">
            {u.email} · <span className="font-mono text-xs">{u.id}</span> · joined{' '}
            {formatDate(u.createdAt)}
          </p>
          <div className="mt-2 flex gap-1">
            <Yes on={u.emailVerified} yes="email verified" no="email unverified" />
            <Yes on={u.twoFactor} yes="2FA on" no="2FA off" />
            <Badge variant="outline">{u.passkeys.length} passkeys</Badge>
            {u.operator && <Badge variant="secondary">operator</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <ReasonDialog
            trigger={<Button variant="outline">Revoke sessions</Button>}
            title="Revoke all sessions"
            description="Signs the user out everywhere. They can sign in again."
            confirm="Revoke"
            destructive
            onConfirm={act('revoke-sessions', 'Sessions revoked')}
          />
          {!u.operator && (
            <ReasonDialog
              trigger={
                <Button>
                  <Eye className="size-4" /> View as user
                </Button>
              }
              title={`View as ${u.name}`}
              description="Opens the app as this user sees it: read-only, time-boxed, recorded in the audit log of every organization they belong to."
              confirm="View as user"
              onConfirm={(reason, form) =>
                viewAs(u.id, reason, String(form.get('org') || '') || undefined)
              }
            >
              {u.memberships.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="view-org">Organization</Label>
                  <select
                    id="view-org"
                    name="org"
                    className={selectClass}
                    defaultValue={u.memberships[0]?.orgId}
                  >
                    {u.memberships.map((m) => (
                      <option key={m.orgId} value={m.orgId}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </ReasonDialog>
          )}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title="Organizations">
          {u.memberships.length ? (
            <ul className="space-y-2 text-sm">
              {u.memberships.map((m) => (
                <li key={m.orgId} className="flex items-center justify-between gap-2">
                  <Link
                    to="/admin/orgs/$orgId"
                    params={{ orgId: m.orgId }}
                    className="hover:underline"
                  >
                    {m.name}
                  </Link>
                  <span className="flex gap-1">
                    <Badge variant="outline">{m.role}</Badge>
                    {m.suspended && <Badge variant="destructive">suspended</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No organization.</p>
          )}
        </Section>
        <Section title="Sign-in">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Methods</dt>
            <dd>{u.signInMethods.join(', ') || '–'}</dd>
            <dt className="text-muted-foreground">Last sign-in</dt>
            <dd>{dateTime(u.lastSignInAt)}</dd>
            <dt className="text-muted-foreground">Passkeys</dt>
            <dd>{u.passkeys.map((p) => p.name ?? 'unnamed').join(', ') || '–'}</dd>
          </dl>
        </Section>
      </div>

      <Section title="Active sessions">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Device</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {u.sessions.length ? (
              u.sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="whitespace-nowrap">
                    {dateTime(s.createdAt)}
                    {s.impersonatedBy && (
                      <Badge variant="secondary" className="ml-2">
                        operator view
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{dateTime(s.expiresAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{s.ipAddress ?? '–'}</TableCell>
                  <TableCell className="max-w-72 truncate text-xs" title={s.userAgent ?? undefined}>
                    {s.userAgent ?? '–'}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="h-16 text-center text-muted-foreground">
                  No active session.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Section>

      <Section
        title="Operator actions"
        description="What operators did to this account (audit log)."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Operator</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {u.operatorActions.length ? (
              u.operatorActions.map((a) => (
                <TableRow key={`${a.createdAt}-${a.action}`}>
                  <TableCell className="whitespace-nowrap">{dateTime(a.createdAt)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {a.action}
                    {a.expiresAt && ` (until ${dateTime(a.expiresAt)})`}
                  </TableCell>
                  <TableCell className="text-xs">{a.actorEmail ?? '–'}</TableCell>
                  <TableCell className="text-xs">{a.reason}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="h-16 text-center text-muted-foreground">
                  None.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Section>
    </div>
  );
}
