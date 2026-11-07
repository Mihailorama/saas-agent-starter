import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { track } from '@/lib/analytics';
import { api, type Billing, formatDate } from '@/lib/api';
import { cn } from '@/lib/utils';

const money = (amount: number | string, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));

function Meter({
  label,
  used,
  limit,
  text,
}: {
  label: string;
  used: number;
  limit: number;
  text: string;
}) {
  const ratio = limit > 0 ? Math.min(used / limit, 1) : 1;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{text}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            'h-full rounded-full bg-primary transition-[width]',
            ratio >= 1 ? 'bg-destructive' : ratio >= 0.8 && 'bg-amber-500',
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

/** Org settings: plan, usage vs. limits, LLM spend, upgrade/cancel. Prices come from the API. */
export function BillingPage() {
  const queryClient = useQueryClient();
  const billing = useQuery({ queryKey: ['billing'], queryFn: () => api<Billing>('/api/billing') });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['billing'] });

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('checkout');
    if (result === 'success') toast.success('Payment received. Your plan updates in a moment.');
  }, []);

  const go = (url: string) => window.location.assign(url);
  const checkout = useMutation({
    mutationFn: (planId: string) =>
      api<{ url: string }>('/api/billing/checkout', { method: 'POST', json: { planId } }),
    onMutate: (planId) => track('billing_checkout_started', { plan: planId }),
    onSuccess: ({ url }) => go(url),
    onError: (err) => toast.error(err.message),
  });
  const portal = useMutation({
    mutationFn: () => api<{ url: string }>('/api/billing/portal', { method: 'POST' }),
    onSuccess: ({ url }) => go(url),
    onError: (err) => toast.error(err.message),
  });
  const cancel = useMutation({
    mutationFn: () => api('/api/billing/cancel', { method: 'POST' }),
    onSuccess: () => {
      track('billing_canceled');
      setConfirmCancel(false);
      toast.success('Your plan will not renew.');
      refresh();
    },
    onError: (err) => toast.error(err.message),
  });
  const raise = useMutation({
    mutationFn: (json: { currency: string; amount: number }) =>
      api('/api/billing/llm-limit', { method: 'PATCH', json }),
    onSuccess: () => {
      toast.success('LLM spend limit updated');
      refresh();
    },
    onError: (err) => toast.error(err.message),
  });

  if (billing.isError) {
    return (
      <Alert variant="destructive" className="mx-auto max-w-4xl">
        <AlertTitle>Could not load billing</AlertTitle>
        <AlertDescription>{billing.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (billing.isPending) return <Skeleton className="mx-auto h-64 max-w-4xl" />;
  const b = billing.data;
  const paid = b.status === 'active' || b.status === 'past_due';

  function onRaise(currency: string) {
    return (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      raise.mutate({ currency, amount: Number(new FormData(e.currentTarget).get('amount')) });
    };
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Plan and usage of this organization. Invoices and receipts are kept by the payment
          provider.
        </p>
      </div>

      {b.status === 'past_due' && (
        <Alert variant="destructive">
          <AlertTitle>Payment failed</AlertTitle>
          <AlertDescription>
            The last renewal did not go through. Update the payment method to keep the plan.
          </AlertDescription>
        </Alert>
      )}
      {b.llmSpend.some((s) => s.level === 'blocked') && (
        <Alert variant="destructive">
          <AlertTitle>AI features are paused</AlertTitle>
          <AlertDescription>
            The LLM spend limit for this billing period is reached. It resets on{' '}
            {formatDate(b.periodEnd)}
            {b.canManage ? '; raise the limit or upgrade to continue now.' : '.'}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              {b.planName}
              {b.status && b.status !== 'active' && <Badge variant="outline">{b.status}</Badge>}
            </CardTitle>
            <CardDescription>
              {paid
                ? b.cancelAtPeriodEnd
                  ? `Ends on ${formatDate(b.periodEnd)}`
                  : `Renews on ${formatDate(b.periodEnd)}`
                : `Usage period ${formatDate(b.periodStart)} – ${formatDate(b.periodEnd)}`}
            </CardDescription>
          </div>
          {b.canManage && paid && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => portal.mutate()} disabled={portal.isPending}>
                Invoices and payment method <ExternalLink className="size-4" />
              </Button>
              {!b.cancelAtPeriodEnd && (
                <Button variant="ghost" onClick={() => setConfirmCancel(true)}>
                  Cancel plan
                </Button>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-5">
          <Meter
            label="Seats"
            used={b.usage.seats.used}
            limit={b.usage.seats.limit}
            text={`${b.usage.seats.used} of ${b.usage.seats.limit}`}
          />
          <Meter
            label="Projects"
            used={b.usage.projects.used}
            limit={b.usage.projects.limit}
            text={`${b.usage.projects.used} of ${b.usage.projects.limit}`}
          />
          {b.llmSpend.map((s) => (
            <div key={s.currency} className="space-y-2">
              <Meter
                label="LLM spend this period"
                used={s.spent}
                limit={s.limit}
                text={`${money(s.spent, s.currency)} of ${money(s.limit, s.currency)}`}
              />
              {s.level === 'warning' && (
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  Over 80% of the limit: AI features stop when it is reached.
                </p>
              )}
              {b.canManage && b.features.llmLimitRaise && (
                <form onSubmit={onRaise(s.currency)} className="flex items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={`limit-${s.currency}`}>
                      Monthly limit ({s.currency}, up to {money(s.max, s.currency)})
                    </Label>
                    <Input
                      id={`limit-${s.currency}`}
                      name="amount"
                      type="number"
                      min={0}
                      max={s.max}
                      step="0.01"
                      defaultValue={s.limit}
                      className="w-40"
                    />
                  </div>
                  <Button type="submit" variant="outline" disabled={raise.isPending}>
                    Save limit
                  </Button>
                </form>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {b.plans.map((p) => (
          <Card key={p.id} className={cn(p.id === b.planId && 'border-primary')}>
            <CardHeader>
              <CardTitle>{p.name}</CardTitle>
              <CardDescription>
                {p.price ? `${money(p.price.amount, b.currency)} per ${p.price.interval}` : 'Free'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <ul className="space-y-1 text-muted-foreground">
                <li>{p.seats} seats</li>
                <li>{p.projects} projects</li>
                {p.llmSpendMonthly !== null && b.llmSpend[0] && (
                  <li>{money(p.llmSpendMonthly, b.llmSpend[0].currency)} of LLM usage per month</li>
                )}
              </ul>
              {p.id === b.planId ? (
                <Badge variant="secondary">Current plan</Badge>
              ) : (
                p.price &&
                b.canManage &&
                !paid && (
                  <Button onClick={() => checkout.mutate(p.id)} disabled={checkout.isPending}>
                    Upgrade to {p.name}
                  </Button>
                )
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel {b.planName}?</DialogTitle>
            <DialogDescription>
              The plan stays active until {formatDate(b.periodEnd)} and does not renew. After that
              the organization moves to the free plan and its limits.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCancel(false)}>
              Keep plan
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              Cancel plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
