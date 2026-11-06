import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Layers } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { track } from '@/lib/analytics';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth';

export function SignInPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [pending, setPending] = useState(false);
  const { data: config } = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api<{ sso: boolean }>('/api/auth-config'),
  });

  async function onSso() {
    setPending(true);
    // Redirects to the IdP; Better Auth handles /api/auth/callback/oidc and returns to '/'.
    const { error } = await authClient.signIn.social({ provider: 'oidc', callbackURL: '/' });
    if (error) {
      setPending(false);
      toast.error(error.message ?? 'Single sign-on failed');
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email'));
    const password = String(form.get('password'));
    setPending(true);
    const { error } =
      mode === 'sign-in'
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: String(form.get('name')) });
    setPending(false);
    if (error) return toast.error(error.message ?? 'Something went wrong');
    if (mode === 'sign-in') track('signin_completed');
    else track('signup_completed');
    navigate({ to: '/' });
  }

  const signUp = mode === 'sign-up';
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
              {signUp ? 'Create your account' : 'Welcome back'}
            </CardTitle>
            <CardDescription>
              {signUp ? 'Start with a free workspace.' : 'Sign in to continue to your workspace.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={onSubmit}
              className="space-y-4"
              aria-label={signUp ? 'Create account' : 'Sign in'}
            >
              {signUp && (
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" autoComplete="name" required />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  minLength={12}
                  autoComplete={signUp ? 'new-password' : 'current-password'}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={pending}>
                {signUp ? 'Create account' : 'Sign in'}
              </Button>
            </form>
            {config?.sso && !signUp && (
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
              {signUp ? 'Already have an account?' : 'New here?'}{' '}
              <button
                type="button"
                className="font-medium text-foreground underline-offset-4 hover:underline"
                onClick={() => {
                  if (!signUp) track('signup_started');
                  setMode(signUp ? 'sign-in' : 'sign-up');
                }}
              >
                {signUp ? 'Sign in' : 'Create an account'}
              </button>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
