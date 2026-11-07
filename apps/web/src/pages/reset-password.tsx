import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { track } from '@/lib/analytics';
import { authClient } from '@/lib/auth';
import { AuthLayout } from '@/pages/sign-in';

/** Landing page of the emailed reset link (/api/auth/reset-password/:token redirects here). */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const { token, error } = useSearch({ from: '/reset-password' });
  const [pending, setPending] = useState(false);

  if (!token || error) {
    return (
      <AuthLayout
        title="This link has expired"
        description="Reset links work once and for 1 hour. Request a new one from the sign-in page."
      >
        <Button asChild className="w-full">
          <Link to="/sign-in">Back to sign in</Link>
        </Button>
      </AuthLayout>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const newPassword = String(new FormData(e.currentTarget).get('password'));
    setPending(true);
    const { error } = await authClient.resetPassword({ newPassword, token });
    setPending(false);
    if (error) return toast.error(error.message ?? 'Could not reset the password');
    track('password_reset_completed');
    toast.success('Password changed. Sign in with the new one.');
    navigate({ to: '/sign-in' });
  }

  return (
    <AuthLayout title="Choose a new password" description="You will be signed out everywhere.">
      <form onSubmit={onSubmit} className="space-y-4" aria-label="Choose a new password">
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            minLength={12}
            autoComplete="new-password"
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          Change password
        </Button>
      </form>
    </AuthLayout>
  );
}
