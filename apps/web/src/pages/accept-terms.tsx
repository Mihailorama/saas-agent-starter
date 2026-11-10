import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { track } from '@/lib/analytics';
import { client, ok } from '@/lib/api';
import { authClient } from '@/lib/auth';
import { legalQuery, legalUrl } from '@/lib/legal';
import { AuthLayout } from '@/pages/sign-in';

const Doc = ({ id, children }: { id: 'terms' | 'privacy'; children: string }) => (
  <a
    href={legalUrl(id)}
    target="_blank"
    rel="noopener"
    className="whitespace-nowrap underline underline-offset-4"
  >
    {children}
  </a>
);

/**
 * Sign-up's last step and re-acceptance (docs/legal.md): every way an account is created (email
 * code, SSO, an invitation) lands here until the user accepts the current terms and privacy
 * versions. The API refuses tenant routes until then; this page only asks.
 */
export function AcceptTermsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { redirect } = useSearch({ from: '/accept-terms' });
  const { data: session } = authClient.useSession();
  const query = legalQuery(session?.user.id);
  const status = useQuery({ ...query, enabled: Boolean(session) });
  const [agree, setAgree] = useState(false);
  const [age, setAge] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [error, setError] = useState<string>();
  const accept = useMutation({
    mutationFn: (s: { terms: string; privacy: string; firstTime: boolean }) =>
      ok(
        client.POST('/api/legal/accept', {
          body: {
            terms: s.terms,
            privacy: s.privacy,
            ageConfirmed: age,
            ...(s.firstTime && { marketingOptIn: marketing }),
          },
        }),
      ),
    onSuccess: (data, s) => {
      queryClient.setQueryData(query.queryKey, data);
      track('legal_accepted', { reaccept: !s.firstTime, marketing: data.marketingOptIn });
      navigate({ href: redirect ?? '/' });
    },
    onError: (e) => {
      setError(e.message);
      return queryClient.invalidateQueries({ queryKey: query.queryKey }); // a newer version
    },
  });

  if (!status.data) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }
  const s = status.data;
  if (!s.required) return <Navigate to={redirect ?? '/'} />;
  const ready = agree && (s.minAge === null || age);

  return (
    <AuthLayout
      title={s.firstTime ? 'Before you continue' : 'We updated our terms'}
      description={
        s.firstTime
          ? 'Accept the terms of service and the privacy policy to use your account.'
          : 'Review the new versions and accept them to continue.'
      }
    >
      <form
        className="space-y-4"
        aria-label="Accept the terms"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) accept.mutate(s);
        }}
      >
        <div className="flex items-start gap-3">
          <Checkbox
            id="accept-terms"
            checked={agree}
            onCheckedChange={(v) => setAgree(v === true)}
            aria-required
          />
          <Label htmlFor="accept-terms" className="block leading-5 font-normal">
            I agree to the <Doc id="terms">Terms of service</Doc> and the{' '}
            <Doc id="privacy">Privacy policy</Doc>.
          </Label>
        </div>
        {s.minAge !== null && (
          <div className="flex items-start gap-3">
            <Checkbox
              id="accept-age"
              checked={age}
              onCheckedChange={(v) => setAge(v === true)}
              aria-required
            />
            <Label htmlFor="accept-age" className="block leading-5 font-normal">
              I am at least {s.minAge} years old.
            </Label>
          </div>
        )}
        {s.firstTime && (
          <div className="flex items-start gap-3">
            <Checkbox
              id="accept-marketing"
              checked={marketing}
              onCheckedChange={(v) => setMarketing(v === true)}
            />
            <Label htmlFor="accept-marketing" className="block leading-5 font-normal">
              Email me product news. Optional: unsubscribe any time. Account emails such as sign-in
              codes arrive either way.
            </Label>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={!ready || accept.isPending}>
          Accept and continue
        </Button>
      </form>
      <Button
        type="button"
        variant="ghost"
        className="mt-3 w-full"
        onClick={async () => {
          await authClient.signOut();
          navigate({ to: '/sign-in' });
        }}
      >
        Sign out
      </Button>
      <p className="mt-3 text-center text-sm text-muted-foreground">
        Do not want to accept?{' '}
        <Link to="/settings/privacy" className="underline underline-offset-4">
          Download or delete your data
        </Link>
      </p>
    </AuthLayout>
  );
}
