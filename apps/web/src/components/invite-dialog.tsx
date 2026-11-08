import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth';

export /** A small form dialog: one submit, pending state, toast on error (profile and invite). */
function FormDialog(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  submit: string;
  onSubmit: (data: FormData) => Promise<{ error?: { message?: string } | null }>;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const { error } = await props.onSubmit(new FormData(e.currentTarget));
    setPending(false);
    if (error) return toast.error(error.message ?? 'Something went wrong');
    await queryClient.invalidateQueries({ queryKey: ['onboarding'] });
    toast.success('Saved');
    props.onOpenChange(false);
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="space-y-4" aria-label={props.title}>
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
            <DialogDescription>{props.description}</DialogDescription>
          </DialogHeader>
          {props.children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {props.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Invite by email (Better Auth `organization.inviteMember`): the onboarding checklist and the
 * members page share it. `withRole` lets an admin pick member or admin.
 */
export function InviteDialog({
  open,
  onOpenChange,
  withRole = false,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  withRole?: boolean;
  onInvited?: (role: 'member' | 'admin') => void;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Invite a teammate"
      description="They get an email with a link to join this organization."
      submit="Send invitation"
      onSubmit={async (f) => {
        const role = f.get('role') === 'admin' ? 'admin' : 'member';
        const res = await authClient.organization.inviteMember({
          email: String(f.get('email')),
          role,
        });
        if (!res.error) onInvited?.(role);
        return res;
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" name="email" type="email" required autoFocus />
      </div>
      {withRole && (
        <div className="space-y-2">
          <Label htmlFor="invite-role">Role</Label>
          <select
            id="invite-role"
            name="role"
            defaultValue="member"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      )}
    </FormDialog>
  );
}
