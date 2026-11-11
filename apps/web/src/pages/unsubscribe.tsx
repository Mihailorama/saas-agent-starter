import { useMutation } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { track } from '@/lib/analytics';
import { client, ok } from '@/lib/api';
import { AuthLayout } from '@/pages/sign-in';

/**
 * Target of the unsubscribe link in marketing mail (docs/legal.md). No sign-in: the token in
 * the link is enough. Mail clients use the List-Unsubscribe header and never open this page.
 */
export function UnsubscribePage() {
  const { token } = useSearch({ from: '/unsubscribe' });
  const unsubscribe = useMutation({
    mutationFn: () =>
      ok(client.POST('/api/unsubscribe/', { params: { query: { token } }, body: {} })),
    onSuccess: () => track('marketing_unsubscribed'),
  });

  if (unsubscribe.isSuccess) {
    return (
      <AuthLayout
        title="You are unsubscribed"
        description="You will get no more product news. Account emails such as sign-in codes and invitations still arrive. Opt in again any time in Settings, Privacy."
      >
        <Button asChild variant="outline" className="w-full">
          <Link to="/">Open your workspace</Link>
        </Button>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Unsubscribe from product news"
      description="You will stop getting product news. Account emails such as sign-in codes and invitations still arrive."
    >
      {unsubscribe.isError && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {unsubscribe.error.message} Sign in and switch off product news in{' '}
          <Link to="/settings/privacy" className="underline underline-offset-4">
            Settings, Privacy
          </Link>
          .
        </p>
      )}
      <Button
        className="w-full"
        disabled={!token || unsubscribe.isPending}
        onClick={() => unsubscribe.mutate()}
      >
        Unsubscribe
      </Button>
    </AuthLayout>
  );
}
