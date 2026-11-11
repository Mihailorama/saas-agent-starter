import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { KeyRound, Layers, MailCheck } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LegalLinks } from '@/components/patterns/legal-links';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Label } from '@/components/ui/label';
import { privacyChoicesLabel, showPrivacyChoices, track } from '@/lib/analytics';
import { client, ok } from '@/lib/api';
import { authClient } from '@/lib/auth';
import { legalUrl } from '@/lib/legal';

/** Centered card used by the sign-in, two-factor and invitation pages. */
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
        {privacyChoicesLabel && (
          <button
            type="button"
            className="block w-full text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
            onClick={showPrivacyChoices}
          >
            {privacyChoicesLabel}
          </button>
        )}
        <LegalLinks />
      </div>
    </main>
  );
}

/** Only same-origin paths: `?redirect=` must not become an open redirect. */
export const safeRedirect = (value: unknown) =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : undefined;

/** Seconds before another code may be mailed (the API enforces the same per address). */
const RESEND_AFTER = 30;

/** Referral the visitor arrived with (`?ref=<code>`, or Dub's `?dub_id=`; docs/growth.md). It
 * stays in the URL, nothing is stored in the browser, and goes with the code sign-in only (the
 * server keeps it only when that sign-in creates the account). */
const referral = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('ref') ?? params.get('dub_id') ?? undefined;
};

/** Better Auth's email-otp error codes, in words a person can act on. */
const codeError = (e: { code?: string; status?: number; message?: string }) =>
  e.code === 'INVALID_OTP'
    ? 'That code is not right. Check the email and try again.'
    : e.code === 'OTP_EXPIRED'
      ? 'This code has expired. Send a new one.'
      : e.code === 'TOO_MANY_ATTEMPTS'
        ? 'Too many wrong tries. Send a new code.'
        : e.status === 429
          ? 'Too many requests. Wait a moment and try again.'
          : (e.message ?? 'Something went wrong');

/** Sign-in and sign-up in one: the email, then the 6-digit code mailed to it. */
export function SignInPage() {
  const navigate = useNavigate();
  const { redirect } = useSearch({ from: '/sign-in' });
  const [email, setEmail] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [wait, setWait] = useState(0);
  const [pending, setPending] = useState(false);
  const [ref] = useState(referral);
  const { data: config } = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => ok(client.GET('/api/auth-config')),
  });

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

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

  /** Mails a code. Same answer whether or not an account exists: the code creates it. */
  async function sendCode(to: string) {
    setPending(true);
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email: to, type: 'sign-in' });
    setPending(false);
    if (error) return toast.error(codeError(error));
    track('signin_code_requested');
    setEmail(to);
    setCode('');
    setError(undefined);
    setWait(RESEND_AFTER);
  }

  async function verify(otp: string) {
    if (!email) return;
    setPending(true);
    const { data, error } = await authClient.signIn.emailOtp({ email, otp, referralCode: ref });
    setPending(false);
    if (error) {
      setCode('');
      return setError(codeError(error));
    }
    // Account with 2FA: the code was right, the authenticator step is next (no session yet).
    if ('twoFactorRedirect' in data && data.twoFactorRedirect) {
      return navigate({ to: '/two-factor', search: { redirect } });
    }
    // ponytail: "new" = created by this sign-in (within a minute); the API does not say it.
    const created = 'user' in data ? new Date(data.user.createdAt).getTime() : 0;
    if (Date.now() - created < 60_000) track('signup_completed');
    else track('signin_completed');
    navigate({ href: redirect ?? '/' });
  }

  if (email) {
    return (
      <AuthLayout title="Check your email" description={`We sent a 6-digit code to ${email}.`}>
        <form
          className="space-y-4"
          aria-label="Enter code"
          onSubmit={(e) => {
            e.preventDefault();
            verify(code);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="code">Code</Label>
            <InputOTP
              id="code"
              maxLength={6}
              pattern={REGEXP_ONLY_DIGITS}
              autoComplete="one-time-code"
              autoFocus
              value={code}
              disabled={pending}
              onChange={(v) => {
                setCode(v);
                setError(undefined);
              }}
              onComplete={verify}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'code-error' : 'code-help'}
            >
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} aria-invalid={Boolean(error)} />
                ))}
              </InputOTPGroup>
            </InputOTP>
            {error ? (
              <p id="code-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : (
              <p id="code-help" className="text-sm text-muted-foreground">
                The code expires in 5 minutes. No email? Check spam.
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={pending || code.length < 6}>
            Continue
          </Button>
        </form>
        <div className="mt-3 flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={pending || wait > 0}
            onClick={() => sendCode(email)}
          >
            {wait > 0 ? `Resend code in ${wait} s` : 'Resend code'}
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={() => setEmail(null)}>
            Use a different email
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Sign in"
      description="Enter your email: we will send you a code. New here? The code creates your account."
    >
      <form
        className="space-y-4"
        aria-label="Sign in"
        onSubmit={(e) => {
          e.preventDefault();
          sendCode(String(new FormData(e.currentTarget).get('email')).trim());
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          <MailCheck className="size-4" aria-hidden /> Email me a code
        </Button>
      </form>
      <Button
        type="button"
        variant="outline"
        className="mt-3 w-full"
        disabled={pending}
        onClick={onPasskey}
      >
        <KeyRound className="size-4" aria-hidden /> Sign in with a passkey
      </Button>
      {config?.sso && (
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
      <p className="mt-4 text-xs text-muted-foreground">
        New accounts accept the{' '}
        <a
          href={legalUrl('terms')}
          target="_blank"
          rel="noopener"
          className="whitespace-nowrap underline"
        >
          Terms of service
        </a>{' '}
        and the{' '}
        <a
          href={legalUrl('privacy')}
          target="_blank"
          rel="noopener"
          className="whitespace-nowrap underline"
        >
          Privacy policy
        </a>{' '}
        right after the code.
      </p>
    </AuthLayout>
  );
}
