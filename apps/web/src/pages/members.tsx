import { useMutation } from '@tanstack/react-query';
import { MailPlus, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { InviteDialog } from '@/components/invite-dialog';
import { PageContainer, PageHeader } from '@/components/patterns/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  const [inviting, setInviting] = useState(false);
  // UI hint only; Better Auth refuses invites and revokes from plain members.
  const { data: me } = authClient.useActiveMember();
  const canManage = me?.role.split(',').some((r) => r === 'admin' || r === 'owner') ?? false;
  const revoke = useMutation({
    mutationFn: (invitationId: string) =>
      must(authClient.organization.cancelInvitation({ invitationId })),
    onSuccess: () => refetch(),
    onError: (err) => toast.error(err.message),
  });
  const pending = org?.invitations.filter((i) => i.status === 'pending') ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Members"
        description="People in this organization and open invitations."
        actions={
          canManage && (
            <Button onClick={() => setInviting(true)}>
              <MailPlus className="size-4" /> Invite
            </Button>
          )
        }
      />
      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        withRole
        onInvited={(role) => {
          track('member_invited', { role });
          refetch();
        }}
      />

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
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Revoke invitation for ${i.email}`}
                        onClick={() => revoke.mutate(i.id)}
                      >
                        <X className="size-4" /> Revoke
                      </Button>
                    )}
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
