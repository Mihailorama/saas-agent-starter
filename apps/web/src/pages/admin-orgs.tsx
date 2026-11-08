import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ExternalLink, Eye } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, formatDate } from '@/lib/api';
import { dateTime, PAGE, ReasonDialog, Section, selectClass, viewAs, Yes } from '@/pages/admin';

type Llm = { currency: string; spent: number; limit: number };
type OrgRow = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  suspended: boolean;
  planId: string;
  planName: string;
  subscriptionStatus: string | null;
  members: number;
  llmSpend: Llm[];
  lastActivityAt: string | null;
};
type Usage = { used: number; limit: number; planLimit: number; max: number };
type OrgDetail = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  suspendedAt: string | null;
  suspendReason: string | null;
  requireTwoFactor: boolean;
  members: {
    userId: string;
    name: string;
    email: string;
    role: string;
    twoFactor: boolean;
    joinedAt: string;
  }[];
  subscription: {
    status: string;
    provider: string;
    currency: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    contractRef: string | null;
    dashboardUrl: string | null;
  } | null;
  contractPlans: { id: string; name: string; currencies: string[] }[];
  planId: string;
  planName: string;
  period: { start: string; end: string };
  usage: { seats: Usage; projects: Usage };
  llmSpend: (Llm & { max: number; raisable: boolean })[];
  apiKeys: {
    id: string;
    name: string | null;
    start: string | null;
    enabled: boolean;
    expiresAt: string | null;
    lastUsedAt: string | null;
  }[];
  webhooks: {
    id: string;
    url: string;
    enabled: boolean;
    disabledReason: string | null;
    consecutiveFailures: number;
    eventTypes: string[];
  }[];
  pendingRewards: {
    id: string;
    status: 'pending_manual' | 'reserved';
    ruleId: string;
    reward: Record<string, unknown>;
    key: string;
    providerRef: string | null;
    createdAt: string;
  }[];
  audit: {
    id: string;
    action: string;
    actorId: string | null;
    actorEmail: string | null;
    target: string | null;
    reason: string | null;
    createdAt: string;
  }[];
};

const spend = (l: Llm) => `${l.spent.toFixed(2)} / ${l.limit} ${l.currency}`;
const Empty = ({ cols, text }: { cols: number; text: string }) => (
  <TableRow>
    <TableCell colSpan={cols} className="h-16 text-center text-muted-foreground">
      {text}
    </TableCell>
  </TableRow>
);

export function AdminOrgsPage() {
  const [filters, setFilters] = useState({ q: '', plan: '', status: '', createdFrom: '' });
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v) as [string, string][],
  );
  const orgs = useQuery({
    queryKey: ['admin', 'orgs', query.toString(), offset],
    queryFn: () =>
      api<{ items: OrgRow[]; total: number }>(
        `/api/admin/orgs?${query}&limit=${PAGE}&offset=${offset}`,
      ),
    placeholderData: keepPreviousData,
  });
  const set = (key: keyof typeof filters) => (e: { target: { value: string } }) => {
    setFilters((f) => ({ ...f, [key]: e.target.value }));
    setOffset(0);
  };
  const total = orgs.data?.total ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="f-q">Search</Label>
          <Input id="f-q" placeholder="Name, slug or id" value={filters.q} onChange={set('q')} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-plan">Plan</Label>
          <Input
            id="f-plan"
            placeholder="free, pro..."
            value={filters.plan}
            onChange={set('plan')}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-status">Status</Label>
          <select
            id="f-status"
            value={filters.status}
            onChange={set('status')}
            className={selectClass}
          >
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="past_due">Payment past due</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-created">Created from</Label>
          <Input
            id="f-created"
            type="date"
            value={filters.createdFrom}
            onChange={set('createdFrom')}
          />
        </div>
      </div>
      {orgs.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load organizations</AlertTitle>
          <AlertDescription>{orgs.error.message}</AlertDescription>
        </Alert>
      ) : orgs.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead>LLM spend this period</TableHead>
                  <TableHead>Last activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgs.data.items.length ? (
                  orgs.data.items.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>
                        <Link
                          to="/admin/orgs/$orgId"
                          params={{ orgId: o.id }}
                          className="font-medium hover:underline"
                        >
                          {o.name}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{o.slug}</span>
                      </TableCell>
                      <TableCell className="space-x-1">
                        <Badge variant="outline">{o.planName}</Badge>
                        {o.suspended && <Badge variant="destructive">suspended</Badge>}
                        {o.subscriptionStatus === 'past_due' && (
                          <Badge variant="destructive">past due</Badge>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(o.createdAt)}</TableCell>
                      <TableCell className="text-right tabular-nums">{o.members}</TableCell>
                      <TableCell className="tabular-nums">
                        {o.llmSpend.map((l) => (
                          <span
                            key={l.currency}
                            className={l.spent >= l.limit ? 'block text-destructive' : 'block'}
                          >
                            {spend(l)}
                          </span>
                        ))}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {dateTime(o.lastActivityAt)}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <Empty cols={6} text="No organization matches these filters." />
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {total
                ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`
                : '0 organizations'}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE >= total}
                onClick={() => setOffset(offset + PAGE)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LimitsDialog({ org, onDone }: { org: OrgDetail; onDone: () => Promise<unknown> }) {
  const raisable = org.llmSpend.filter((l) => l.raisable);
  return (
    <ReasonDialog
      trigger={
        <Button variant="outline" size="sm">
          Adjust limits
        </Button>
      }
      title="Adjust limits"
      description={`Within the ${org.planName} plan's rules. Leave a field empty for the plan's own limit.`}
      confirm="Save limits"
      onConfirm={async (reason, form) => {
        const num = (k: string) => {
          const v = String(form.get(k) ?? '').trim();
          return v === '' ? null : Number(v);
        };
        const llm = raisable.find(
          (l) =>
            String(form.get(`llm-${l.currency}`) ?? '').trim() !== '' &&
            Number(form.get(`llm-${l.currency}`)) !== l.limit,
        );
        await api(`/api/admin/orgs/${org.id}/limits`, {
          method: 'PATCH',
          json: {
            reason,
            seats: num('seats'),
            projects: num('projects'),
            ...(llm && {
              llmSpend: { currency: llm.currency, amount: Number(form.get(`llm-${llm.currency}`)) },
            }),
          },
        });
        toast.success('Limits saved');
        await onDone();
      }}
    >
      {(['seats', 'projects'] as const).map((k) => (
        <div key={k} className="space-y-2">
          <Label htmlFor={`limit-${k}`}>
            {k === 'seats' ? 'Seats' : 'Projects'} (plan {org.usage[k].planLimit}, at most{' '}
            {org.usage[k].max})
          </Label>
          <Input
            id={`limit-${k}`}
            name={k}
            type="number"
            min={k === 'seats' ? 1 : 0}
            max={org.usage[k].max}
            defaultValue={org.usage[k].limit === org.usage[k].planLimit ? '' : org.usage[k].limit}
          />
        </div>
      ))}
      {raisable.map((l) => (
        <div key={l.currency} className="space-y-2">
          <Label htmlFor={`llm-${l.currency}`}>
            LLM limit per period, {l.currency} (at most {l.max})
          </Label>
          <Input
            id={`llm-${l.currency}`}
            name={`llm-${l.currency}`}
            type="number"
            min={0}
            max={l.max}
            step="0.01"
            defaultValue={l.limit}
          />
        </div>
      ))}
    </ReasonDialog>
  );
}

/** A negotiated contract (docs/billing.md "Contract"): plan, currency, reference and period. */
function ContractDialog({ org, onDone }: { org: OrgDetail; onDone: () => Promise<unknown> }) {
  const options = org.contractPlans.flatMap((p) =>
    p.currencies.map((c) => ({ value: `${p.id}|${c}`, label: `${p.name} (${c})` })),
  );
  if (!options.length) return null;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  return (
    <ReasonDialog
      trigger={
        <Button variant="outline" size="sm">
          Set contract
        </Button>
      }
      title="Set contract"
      description="Plan and period of a signed contract you invoice yourself. At the period end it becomes past due unless you extend it. Contracts invoiced by Stripe are created in the Stripe dashboard."
      confirm="Save contract"
      onConfirm={async (reason, form) => {
        const [planId, currency] = String(form.get('plan')).split('|');
        const date = (k: string) => new Date(`${form.get(k)}T00:00:00Z`).toISOString();
        await api(`/api/admin/orgs/${org.id}/contract`, {
          method: 'PUT',
          json: {
            reason,
            planId,
            currency,
            contractRef: String(form.get('contractRef')),
            periodStart: date('periodStart'),
            periodEnd: date('periodEnd'),
          },
        });
        toast.success('Contract saved');
        await onDone();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="contract-plan">Plan</Label>
        <select id="contract-plan" name="plan" className={selectClass}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="contract-ref">Contract reference</Label>
        <Input
          id="contract-ref"
          name="contractRef"
          required
          maxLength={200}
          defaultValue={org.subscription?.contractRef ?? ''}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label htmlFor="contract-start">Period start</Label>
          <Input
            id="contract-start"
            name="periodStart"
            type="date"
            required
            defaultValue={day(now)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="contract-end">Period end</Label>
          <Input
            id="contract-end"
            name="periodEnd"
            type="date"
            required
            defaultValue={day(new Date(now.getTime() + 365 * 86_400_000))}
          />
        </div>
      </div>
    </ReasonDialog>
  );
}

export function AdminOrgPage() {
  const { orgId } = useParams({ from: '/admin/orgs/$orgId' });
  const queryClient = useQueryClient();
  const org = useQuery({
    queryKey: ['admin', 'org', orgId],
    queryFn: () => api<OrgDetail>(`/api/admin/orgs/${orgId}`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin'] });

  if (org.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load the organization</AlertTitle>
        <AlertDescription>{org.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (org.isPending) return <Skeleton className="h-64 w-full" />;
  const o = org.data;
  const suspendAction = (suspend: boolean) => async (reason: string) => {
    await api(`/api/admin/orgs/${o.id}/${suspend ? 'suspend' : 'unsuspend'}`, {
      method: 'POST',
      json: { reason },
    });
    toast.success(suspend ? 'Organization suspended' : 'Organization restored');
    await refresh();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{o.name}</h1>
          <p className="text-sm text-muted-foreground">
            {o.slug} · <span className="font-mono text-xs">{o.id}</span> · created{' '}
            {formatDate(o.createdAt)}
          </p>
          <div className="mt-2 flex gap-1">
            <Badge variant="outline">{o.planName}</Badge>
            {o.suspendedAt && <Badge variant="destructive">suspended</Badge>}
            {o.requireTwoFactor && <Badge variant="secondary">2FA required</Badge>}
          </div>
        </div>
        {o.suspendedAt ? (
          <ReasonDialog
            trigger={<Button variant="outline">Unsuspend</Button>}
            title="Unsuspend organization"
            description="Members and API keys get access again."
            confirm="Unsuspend"
            onConfirm={suspendAction(false)}
          />
        ) : (
          <ReasonDialog
            trigger={<Button variant="destructive">Suspend</Button>}
            title="Suspend organization"
            description="Members can no longer open it and its API keys are refused, until you unsuspend it. Nothing is deleted. The reason is internal; members see a generic notice."
            confirm="Suspend"
            destructive
            onConfirm={suspendAction(true)}
          />
        )}
      </div>

      {o.suspendedAt && (
        <Alert variant="destructive">
          <AlertTitle>Suspended since {dateTime(o.suspendedAt)}</AlertTitle>
          <AlertDescription>{o.suspendReason}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Section title="Subscription" action={<ContractDialog org={o} onDone={refresh} />}>
          {o.subscription ? (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                {o.subscription.status}
                {o.subscription.cancelAtPeriodEnd && ', cancels at period end'}
              </dd>
              <dt className="text-muted-foreground">Provider</dt>
              <dd>
                {o.subscription.provider} ({o.subscription.currency})
              </dd>
              <dt className="text-muted-foreground">Paid until</dt>
              <dd>{dateTime(o.subscription.currentPeriodEnd)}</dd>
              {o.subscription.contractRef && (
                <>
                  <dt className="text-muted-foreground">Contract</dt>
                  <dd>{o.subscription.contractRef}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No subscription: default plan.</p>
          )}
          {o.subscription?.dashboardUrl && (
            <Button asChild variant="link" className="mt-2 px-0">
              <a href={o.subscription.dashboardUrl} target="_blank" rel="noreferrer">
                Open in {o.subscription.provider} <ExternalLink className="size-3" />
              </a>
            </Button>
          )}
        </Section>
        <Section
          title="Usage and limits"
          description={`Period ${formatDate(o.period.start)} – ${formatDate(o.period.end)}`}
          action={<LimitsDialog org={o} onDone={refresh} />}
        >
          <dl className="grid grid-cols-2 gap-2 text-sm tabular-nums">
            {(['seats', 'projects'] as const).map((k) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground capitalize">{k}</dt>
                <dd>
                  {o.usage[k].used} / {o.usage[k].limit}
                  {o.usage[k].limit !== o.usage[k].planLimit && (
                    <span className="text-muted-foreground">
                      {' '}
                      (override; plan {o.usage[k].planLimit})
                    </span>
                  )}
                </dd>
              </div>
            ))}
            {o.llmSpend.map((l) => (
              <div key={l.currency} className="contents">
                <dt className="text-muted-foreground">LLM spend, {l.currency}</dt>
                <dd className={l.spent >= l.limit ? 'text-destructive' : undefined}>{spend(l)}</dd>
              </div>
            ))}
          </dl>
        </Section>
      </div>

      <Section title="Members">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>2FA</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {o.members.map((m) => (
              <TableRow key={m.userId}>
                <TableCell>
                  <Link
                    to="/admin/users/$userId"
                    params={{ userId: m.userId }}
                    className="font-medium hover:underline"
                  >
                    {m.name}
                  </Link>
                  <span className="block text-xs text-muted-foreground">{m.email}</span>
                </TableCell>
                <TableCell>{m.role}</TableCell>
                <TableCell>
                  <Yes on={m.twoFactor} />
                </TableCell>
                <TableCell>{formatDate(m.joinedAt)}</TableCell>
                <TableCell className="text-right">
                  <ReasonDialog
                    trigger={
                      <Button variant="ghost" size="sm">
                        <Eye className="size-4" /> View as
                      </Button>
                    }
                    title={`View as ${m.name}`}
                    description="Opens the app as this member sees it in this organization: read-only, time-boxed, recorded in the organization's audit log."
                    confirm="View as user"
                    onConfirm={(reason) => viewAs(m.userId, reason, o.id)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title="API keys">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Last used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.apiKeys.length ? (
                o.apiKeys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>
                      {k.name}
                      <span className="block font-mono text-xs text-muted-foreground">
                        {k.start}…
                      </span>
                    </TableCell>
                    <TableCell>
                      <Yes on={k.enabled} yes="active" no="expired/off" />
                    </TableCell>
                    <TableCell>{dateTime(k.lastUsedAt)}</TableCell>
                  </TableRow>
                ))
              ) : (
                <Empty cols={3} text="No API keys." />
              )}
            </TableBody>
          </Table>
        </Section>
        <Section title="Webhooks">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Endpoint</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Failures</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.webhooks.length ? (
                o.webhooks.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell
                      className="max-w-56 truncate font-mono text-xs"
                      title={h.eventTypes.join(', ')}
                    >
                      {h.url}
                    </TableCell>
                    <TableCell>
                      <Yes
                        on={h.enabled}
                        yes="enabled"
                        no={`disabled (${h.disabledReason ?? 'manual'})`}
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {h.consecutiveFailures}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <Empty cols={3} text="No webhook endpoints." />
              )}
            </TableBody>
          </Table>
        </Section>
      </div>

      {o.pendingRewards.length > 0 && (
        <Section
          title="Rewards to apply"
          description="Not applied by the billing provider (manual contract, provider failing), or reserved for over an hour by a stuck workflow. Check the provider for the idempotency key first: it may have applied it already. Then apply it as a credit note or invoice line and mark it, or release a stuck reservation."
        >
          <Table>
            <TableBody>
              {o.pendingRewards.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {r.ruleId}
                    {r.status === 'reserved' && <Badge variant="outline">stuck</Badge>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{JSON.stringify(r.reward)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.key}
                    {r.providerRef && ` (${r.providerRef})`}
                  </TableCell>
                  <TableCell>{dateTime(r.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <ReasonDialog
                      trigger={
                        <Button size="sm" variant="outline">
                          Mark applied
                        </Button>
                      }
                      title="Mark the reward applied"
                      description="The credit note or invoice reference; it goes to the organization's audit log."
                      confirm="Mark applied"
                      onConfirm={async (reason) => {
                        await api(`/api/admin/orgs/${o.id}/rewards/${r.id}/applied`, {
                          method: 'POST',
                          json: { reason },
                        });
                        await refresh();
                      }}
                    />
                    {r.status === 'reserved' && (
                      <ReasonDialog
                        trigger={
                          <Button size="sm" variant="ghost">
                            Release
                          </Button>
                        }
                        title="Release the reservation"
                        description="Nothing is applied; the reservation stops counting against the rule's cap. The reason goes to the organization's audit log."
                        confirm="Release"
                        onConfirm={async (reason) => {
                          await api(`/api/admin/orgs/${o.id}/rewards/${r.id}/release`, {
                            method: 'POST',
                            json: { reason },
                          });
                          await refresh();
                        }}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      <Section
        title="Recent audit events"
        description="The latest 50 entries of this organization's audit log."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {o.audit.length ? (
              o.audit.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="whitespace-nowrap">{dateTime(a.createdAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{a.action}</TableCell>
                  <TableCell className="text-xs">{a.actorEmail ?? a.actorId ?? '–'}</TableCell>
                  <TableCell className="max-w-40 truncate font-mono text-xs">
                    {a.target ?? '–'}
                  </TableCell>
                  <TableCell className="text-xs">{a.reason ?? ''}</TableCell>
                </TableRow>
              ))
            ) : (
              <Empty cols={5} text="No audit events yet." />
            )}
          </TableBody>
        </Table>
      </Section>
    </div>
  );
}
