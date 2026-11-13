import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { track } from '@/lib/analytics';
import { authClient } from '@/lib/auth';
import { AuthLayout, goTo } from '@/pages/sign-in';

/** Second sign-in step for accounts with 2FA: a TOTP code or a one-time backup code. */
export function TwoFactorPage() {
  const navigate = useNavigate();
  const { redirect } = useSearch({ from: '/two-factor' });
  const [backup, setBackup] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const code = String(form.get('code')).replace(/\s/g, '');
    const trustDevice = form.get('trust') === 'on';
    setPending(true);
    const { error } = backup
      ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice });
    setPending(false);
    if (error) {
      // The challenge lives 10 minutes; after that only a fresh sign-in helps.
      if (error.code === 'INVALID_TWO_FACTOR_COOKIE') {
        toast.error('This sign-in expired. Please sign in again.');
        return navigate({ to: '/sign-in', search: { redirect } });
      }
      return setError(error.message ?? 'That code did not work');
    }
    track('signin_completed');
    goTo(navigate, redirect ?? '/');
  }

  const field = backup ? 'Backup code' : 'Authentication code';
  return (
    <AuthLayout
      title="Two-factor authentication"
      description={
        backup
          ? 'Enter one of the backup codes you saved. Each code works once.'
          : 'Enter the 6-digit code from your authenticator app.'
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" aria-label="Verify sign-in">
        <div className="space-y-2">
          <Label htmlFor="code">{field}</Label>
          <Input
            key={field}
            id="code"
            name="code"
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode={backup ? 'text' : 'numeric'}
            pattern={backup ? undefined : '[0-9 ]{6,7}'}
            maxLength={backup ? 32 : 7}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'code-error' : undefined}
            onChange={() => setError(undefined)}
          />
          {error && (
            <p id="code-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-start gap-2">
          <input id="trust" name="trust" type="checkbox" className="mt-0.5 size-4 accent-primary" />
          <Label htmlFor="trust" className="font-normal leading-snug">
            Trust this device for 30 days
          </Label>
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          Verify
        </Button>
      </form>
      <div className="mt-4 flex items-center justify-between text-sm">
        <button
          type="button"
          className="font-medium underline-offset-4 hover:underline"
          onClick={() => {
            setBackup(!backup);
            setError(undefined);
          }}
        >
          {backup ? 'Use authenticator app' : 'Use a backup code'}
        </button>
        <Link to="/sign-in" className="text-muted-foreground underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}
