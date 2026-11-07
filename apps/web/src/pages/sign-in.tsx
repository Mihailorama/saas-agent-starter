import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { KeyRound, Layers, MailCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { track } from '@/lib/analytics';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth';

/** Centered card used by the sign-in, password reset and invitation pages. */
export function AuthLayout(props: { title: string; description: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-center gap-2 text-lg font-semibold">
          <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Layers className="size-4" />
          </span>
          Workspace
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">
              <h1>{props.title}</h1>
            </CardTitle>
            <CardDescription>{props.description}</CardDescription>
          </CardHeader>
          <CardContent>{props.children}</CardContent>
        </Card>
      </div>
    </main>
  );
}

/** Only same-origin paths: `?redirect=` must not become an open redirect. */
export const safeRedirect = (value: unknown) =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : undefined;

type Mode = 'sign-in' | 'sign-up' | 'forgot';
const copy: Record<Mode, { title: string; description: string; submit: string }> = {
  'sign-in': {
    title: 'Welcome back',
    description: 'Sign in to continue to your workspace.',
    submit: 'Sign in',
  },
  'sign-up': {
    title: 'Create your account',
    description: 'Start with a free workspace.',
    submit: 'Create account',
  },
  forgot: {
    title: 'Reset your password',
    description: 'We will email you a link to choose a new password.',
    submit: 'Send reset link',
  },
};

export function SignInPage() {
  const navigate = useNavigate();
  const { redirect } = useSearch({ from: '/sign-in' });
  const [mode, setMode] = useState<Mode>('sign-in');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { data: config } = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api<{ sso: boolean }>('/api/auth-config'),
  });

  async function onSso() {
    setPending(true);
    // Redirects to the IdP; Better Auth handles /api/auth/callback/oidc and returns to '/'.
    const { error } = await authClient.signIn.social({
      provider: 'oidc',
      callbackURL: redirect ?? '/',
    });
    if (error) {
      setPending(false);
      toast.error(error.message ?? 'Single sign-on failed');
    }
  }

  async function onPasskey() {
    setPending(true);
    const { error } = await authClient.signIn.passkey();
    setPending(false);
    if (error) return toast.error(error.message ?? 'Passkey sign-in failed');
    track('passkey_signin_completed');
    navigate({ href: redirect ?? '/' });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email'));
    const password = String(form.get('password'));
    setPending(true);
    if (mode === 'forgot') {
      // Same answer whether or not the account exists.
      const { error } = await authClient.requestPasswordReset({
        email,
        redirectTo: '/reset-password',
      });
      setPending(false);
      if (error) return toast.error(error.message ?? 'Something went wrong');
      track('password_reset_requested');
      return setSentTo(email);
    }
    if (mode === 'sign-up') {
      const { data, error } = await authClient.signUp.email({
        email,
        password,
        name: String(form.get('name')),
        callbackURL: redirect ?? '/', // where the emailed confirmation link lands
      });
      setPending(false);
      if (error) return toast.error(error.message ?? 'Something went wrong');
      track('signup_completed');
      if (!data.token) return setSentTo(email); // email confirmation required first
      return navigate({ href: redirect ?? '/' });
    }
    const { data, error } = await authClient.signIn.email({
      email,
      password,
      callbackURL: redirect ?? '/',
    });
    setPending(false);
    if (error?.status === 403) {
      return toast.error('Confirm your email first: we have sent you a new link.');
    }
    if (error) return toast.error(error.message ?? 'Something went wrong');
    // Account with 2FA: the password was right, the second step is next (no session yet).
    if ('twoFactorRedirect' in data && data.twoFactorRedirect) {
      return navigate({ to: '/two-factor', search: { redirect } });
    }
    track('signin_completed');
    navigate({ href: redirect ?? '/' });
  }

  if (sentTo) {
    return (
      <AuthLayout
        title="Check your email"
        description={
          mode === 'forgot'
            ? `If an account exists for ${sentTo}, we sent it a link to reset the password.`
            : `We sent a confirmation link to ${sentTo}. Open it to finish signing up.`
        }
      >
        <div className="flex flex-col items-center gap-4 text-center text-sm text-muted-foreground">
          <MailCheck className="size-8" />
          <p>The link expires in 1 hour. No email? Check spam, or try again.</p>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              setSentTo(null);
              setMode('sign-in');
            }}
          >
            Back to sign in
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const { title, description, submit } = copy[mode];
  return (
    <AuthLayout title={title} description={description}>
      <form onSubmit={onSubmit} className="space-y-4" aria-label={submit}>
        {mode === 'sign-up' && (
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" autoComplete="name" required />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        {mode !== 'forgot' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              {mode === 'sign-in' && (
                <button
                  type="button"
                  className="text-sm text-muted-foreground underline-offset-4 hover:underline"
                  onClick={() => setMode('forgot')}
                >
                  Forgot password?
                </button>
              )}
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              minLength={12}
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
              required
            />
          </div>
        )}
        <Button type="submit" className="w-full" disabled={pending}>
          {submit}
        </Button>
      </form>
      {mode === 'sign-in' && (
        <Button
          type="button"
          variant="outline"
          className="mt-3 w-full"
          disabled={pending}
          onClick={onPasskey}
        >
          <KeyRound className="size-4" aria-hidden /> Sign in with a passkey
        </Button>
      )}
      {config?.sso && mode === 'sign-in' && (
        <Button
          type="button"
          variant="outline"
          className="mt-3 w-full"
          disabled={pending}
          onClick={onSso}
        >
          Sign in with SSO
        </Button>
      )}
      <p className="mt-4 text-center text-sm text-muted-foreground">
        {mode === 'sign-in' ? 'New here?' : 'Already have an account?'}{' '}
        <button
          type="button"
          className="font-medium text-foreground underline-offset-4 hover:underline"
          onClick={() => {
            if (mode === 'sign-in') track('signup_started');
            setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
          }}
        >
          {mode === 'sign-in' ? 'Create an account' : 'Sign in'}
        </button>
      </p>
    </AuthLayout>
  );
}
