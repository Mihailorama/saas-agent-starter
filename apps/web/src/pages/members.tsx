import { useMutation } from '@tanstack/react-query';
import { MailPlus, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { PageContainer, PageHeader } from '@/components/patterns/page-header';
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
import { track } from '@/lib/analytics';
import { formatDate } from '@/lib/api';
import { authClient } from '@/lib/auth';

const selectClass = 'flex h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs';
/** Better Auth answers `{ data, error }`; turn an error into a rejected promise for useMutation. */
const must = async <T,>(p: Promise<{ data: T; error: { message?: string } | null }>) => {
  const { data, error } = await p;
  if (error) throw new Error(error.message ?? 'request failed');
  return data;
};

/**
 * Organization members and pending invitations (Better Auth's organization client). Admins invite
 * by email and revoke pending invitations; seats come from the plan (docs/billing.md). An accepted
 * invitation can earn the organization a reward (docs/growth.md).
 */
export function MembersPage() {
  const { data: org, isPending, refetch } = authClient.useActiveOrganization();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const invite = useMutation({
    mutationFn: () => must(authClient.organization.inviteMember({ email, role })),
    onSuccess: () => {
      track('member_invited', { role });
      toast.success(`Invitation sent to ${email}`);
      setEmail('');
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });
  const revoke = useMutation({
    mutationFn: (invitationId: string) =>
      must(authClient.organization.cancelInvitation({ invitationId })),
    onSuccess: () => refetch(),
    onError: (err) => toast.error(err.message),
  });
  const pending = org?.invitations.filter((i) => i.status === 'pending') ?? [];

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    invite.mutate();
  }

  return (
    <PageContainer>
      <PageHeader title="Members" description="People in this organization and open invitations." />
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2" aria-label="Invite">
        <div className="min-w-64 flex-1 space-y-2">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invite-role">Role</Label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
            className={selectClass}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <Button type="submit" disabled={invite.isPending}>
          <MailPlus className="size-4" /> Invite
        </Button>
      </form>

      {isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Since</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {org?.members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.user.name}</TableCell>
                  <TableCell>{m.user.email}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{m.role}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(new Date(m.createdAt).toISOString())}
                  </TableCell>
                  <TableCell />
                </TableRow>
              ))}
              {pending.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="text-muted-foreground">Invited</TableCell>
                  <TableCell>{i.email}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{i.role}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    Expires {formatDate(new Date(i.expiresAt).toISOString())}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Revoke invitation for ${i.email}`}
                      onClick={() => revoke.mutate(i.id)}
                    >
                      <X className="size-4" /> Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageContainer>
  );
}
