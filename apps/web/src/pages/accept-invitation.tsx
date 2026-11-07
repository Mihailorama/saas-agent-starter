import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { track } from '@/lib/analytics';
import { authClient } from '@/lib/auth';
import { AuthLayout } from '@/pages/sign-in';

/** Target of the invitation email (link built in apps/api/src/auth.ts). Needs a session. */
export function AcceptInvitationPage() {
  const { invitationId } = useParams({ from: '/accept-invitation/$invitationId' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const { data: invitation, isPending } = useQuery({
    queryKey: ['invitation', invitationId],
    queryFn: async () => {
      const { data } = await authClient.organization.getInvitation({ query: { id: invitationId } });
      return data ?? null;
    },
  });

  async function accept() {
    setPending(true);
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId });
    if (error) {
      setPending(false);
      return toast.error(error.message ?? 'Could not accept the invitation');
    }
    await authClient.organization.setActive({ organizationId: data.member.organizationId });
    track('invitation_accepted');
    await queryClient.invalidateQueries();
    navigate({ to: '/' });
  }

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }
  if (!invitation) {
    return (
      <AuthLayout
        title="Invitation not found"
        description="It may have expired, been withdrawn, or be addressed to another email. Ask for a new one."
      >
        <Button asChild className="w-full">
          <Link to="/">Go to your workspace</Link>
        </Button>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title={`Join ${invitation.organizationName}`}
      description={`${invitation.inviterEmail} invited you as ${invitation.role}.`}
    >
      <Button className="w-full" disabled={pending} onClick={accept}>
        Accept invitation
      </Button>
    </AuthLayout>
  );
}
