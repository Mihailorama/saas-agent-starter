import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus, RotateCw, Webhook } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { SecretDialog } from '@/components/secret-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { track } from '@/lib/analytics';
import { type Body, client, type Ok, ok } from '@/lib/api';

type Endpoint = Ok<'/api/webhooks/endpoints', 'get'>[number];
type NewEndpoint = Body<'/api/webhooks/endpoints', 'post'>;

const PAGE = 25;
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** Why the worker turned an endpoint off (null/manual: an admin did). */
const AUTO_DISABLED = {
  gone: 'it answered 410 Gone',
  failures: 'too many deliveries in a row failed',
} as const;
const STATUS_VARIANT = {
  succeeded: 'secondary',
  pending: 'outline',
  failed: 'destructive',
} as const;

function NewEndpointDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (secret: string) => void;
}) {
  const queryClient = useQueryClient();
  const types = useQuery({
    queryKey: ['webhook-event-types'],
    queryFn: () => ok(client.GET('/api/webhooks/event-types')),
  });
  const create = useMutation({
    mutationFn: (json: NewEndpoint) => ok(client.POST('/api/webhooks/endpoints', { body: json })),
    onSuccess: ({ secret }, input) => {
      track('webhook_endpoint_created', { event_types: input.eventTypes.length });
      queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
      onOpenChange(false);
      onCreated(secret);
    },
    onError: (err) => toast.error(err.message),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    // The checkboxes list the API's own event types (/api/webhooks/event-types).
    const eventTypes = form.getAll('eventType').map(String) as NewEndpoint['eventTypes'];
    if (!eventTypes.length) return toast.error('Choose at least one event');
    create.mutate({
      url: String(form.get('url')),
      description: String(form.get('description') ?? ''),
      eventTypes,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="space-y-4" aria-label="New webhook endpoint">
          <DialogHeader>
            <DialogTitle>Add endpoint</DialogTitle>
            <DialogDescription>
              We POST each selected event as JSON, signed per Standard Webhooks, and retry with
              backoff until your endpoint answers 2xx.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="endpoint-url">URL</Label>
            <Input
              id="endpoint-url"
              name="url"
              type="url"
              required
              autoFocus
              placeholder="https://example.com/webhooks"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="endpoint-description">Description (optional)</Label>
            <Input id="endpoint-description" name="description" maxLength={500} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Events</legend>
            {types.data?.map((t) => (
              <label key={t.type} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="eventType"
                  value={t.type}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  <code className="text-xs">{t.type}</code>
                  <span className="block text-xs text-muted-foreground">{t.description}</span>
                </span>
              </label>
            )) ?? <Skeleton className="h-24 w-full" />}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Add endpoint
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeliveryDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['webhook-delivery', id],
    queryFn: () =>
      ok(client.GET('/api/webhooks/deliveries/{id}', { params: { path: { id: id! } } })),
    enabled: id !== null,
  });
  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delivery attempts</DialogTitle>
          <DialogDescription>
            {detail.data ? `${detail.data.eventType}, event ${detail.data.eventId}` : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        {detail.data ? (
          <div className="space-y-4">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.data.attemptLog.length ? (
                    detail.data.attemptLog.map((a) => (
                      <TableRow key={a.attempt}>
                        <TableCell className="tabular-nums">{a.attempt}</TableCell>
                        <TableCell className="whitespace-nowrap">{dateTime(a.createdAt)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {a.statusCode ?? a.error}
                        </TableCell>
                        <TableCell className="tabular-nums">{a.durationMs} ms</TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={4} className="h-16 text-center text-muted-foreground">
                        No attempt yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(detail.data.payload, null, 2)}
            </pre>
          </div>
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Organization settings: outbound webhook endpoints and their deliveries. Admins only. */
export function WebhooksPage() {
  const queryClient = useQueryClient();
  const endpoints = useQuery({
    queryKey: ['webhook-endpoints'],
    queryFn: () => ok(client.GET('/api/webhooks/endpoints')),
  });
  const [offset, setOffset] = useState(0);
  const deliveries = useQuery({
    queryKey: ['webhook-deliveries', offset],
    queryFn: () =>
      ok(client.GET('/api/webhooks/deliveries', { params: { query: { limit: PAGE, offset } } })),
    placeholderData: keepPreviousData,
    // Attempts are made in the background: refresh while any delivery is still pending.
    refetchInterval: (q) =>
      q.state.data?.items.some((d) => d.status === 'pending') ? 5000 : false,
  });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });

  const update = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      ok(
        client.PATCH('/api/webhooks/endpoints/{id}', {
          params: { path: { id } },
          body: { enabled },
        }),
      ),
    onSuccess: refresh,
    onError: (err) => toast.error(err.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      ok(client.DELETE('/api/webhooks/endpoints/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] });
      toast.success('Endpoint deleted');
    },
    onError: (err) => toast.error(err.message),
  });
  const rotate = useMutation({
    mutationFn: (id: string) =>
      ok(client.POST('/api/webhooks/endpoints/{id}/rotate-secret', { params: { path: { id } } })),
    onSuccess: ({ secret }) => setSecret(secret),
    onError: (err) => toast.error(err.message),
  });
  const replay = useMutation({
    mutationFn: (id: string) =>
      ok(client.POST('/api/webhooks/deliveries/{id}/replay', { params: { path: { id } } })),
    onSuccess: () => {
      toast.success('Replay queued');
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] }), 1500);
    },
    onError: (err) => toast.error(err.message),
  });
  const urlOf = (id: string) => endpoints.data?.find((e) => e.id === id)?.url ?? id;
  const autoDisabled = endpoints.data?.filter(
    (e): e is Endpoint & { disabledReason: keyof typeof AUTO_DISABLED } =>
      !e.enabled && (e.disabledReason === 'gone' || e.disabledReason === 'failures'),
  );
  const total = deliveries.data?.total ?? 0;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
          <p className="text-sm text-muted-foreground">
            Events from this organization, sent to your endpoints. Verify the signature with a{' '}
            <a href="https://www.standardwebhooks.com/" className="underline">
              Standard Webhooks
            </a>{' '}
            library and the endpoint secret.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> Add endpoint
        </Button>
      </div>

      {autoDisabled?.map((e) => (
        <Alert key={e.id} variant="destructive" role="status" aria-label="Endpoint disabled">
          <AlertTitle>Endpoint disabled: {e.url}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-4">
            <span>
              We stopped sending to it {e.disabledAt && `on ${dateTime(e.disabledAt)} `}because{' '}
              {AUTO_DISABLED[e.disabledReason]}. New events are not delivered until you enable it
              again.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => update.mutate({ id: e.id, enabled: true })}
            >
              Re-enable
            </Button>
          </AlertDescription>
        </Alert>
      ))}

      {endpoints.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load webhooks</AlertTitle>
          <AlertDescription>
            {endpoints.error.message === 'forbidden'
              ? 'Only organization admins can manage webhooks.'
              : endpoints.error.message}
          </AlertDescription>
        </Alert>
      ) : endpoints.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : endpoints.data.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-lg bg-muted">
            <Webhook className="size-6 text-muted-foreground" />
          </span>
          <h2 className="mt-4 font-semibold">No endpoints yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Add an endpoint to be notified when projects change.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Endpoint</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.data.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <span className="block max-w-xs truncate font-mono text-xs">{e.url}</span>
                    {e.description && (
                      <span className="text-xs text-muted-foreground">{e.description}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {e.eventTypes.map((t) => (
                        <Badge key={t} variant="secondary" className="font-normal">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={e.enabled ? 'outline' : 'destructive'}>
                      {e.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                    {e.enabled && e.consecutiveFailures > 0 && (
                      <span className="block text-xs text-muted-foreground">
                        {e.consecutiveFailures} failed in a row
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${e.url}`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => rotate.mutate(e.id)}>
                          Rotate secret
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => update.mutate({ id: e.id, enabled: !e.enabled })}
                        >
                          {e.enabled ? 'Disable' : 'Enable'}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => remove.mutate(e.id)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Recent deliveries</h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.data?.items.length ? (
                deliveries.data.items.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="whitespace-nowrap">{dateTime(d.createdAt)}</TableCell>
                    <TableCell>
                      <code className="text-xs">{d.eventType}</code>
                    </TableCell>
                    <TableCell>
                      <span className="block max-w-[14rem] truncate font-mono text-xs">
                        {urlOf(d.endpointId)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[d.status]}>{d.status}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {d.attempts}
                      {d.lastStatusCode !== null && (
                        <span className="text-muted-foreground"> (last {d.lastStatusCode})</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button variant="ghost" size="sm" onClick={() => setInspecting(d.id)}>
                        Attempts
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => replay.mutate(d.id)}
                        disabled={replay.isPending}
                      >
                        <RotateCw className="size-3.5" /> Replay
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="h-20 text-center text-muted-foreground">
                    {deliveries.isPending ? 'Loading…' : 'No deliveries yet.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {total > PAGE && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
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
        )}
        <p className="text-xs text-muted-foreground">
          A replay sends the same body and webhook-id again, so receivers can deduplicate.
        </p>
      </section>

      <NewEndpointDialog open={creating} onOpenChange={setCreating} onCreated={setSecret} />
      <SecretDialog
        title="Signing secret"
        description="Copy it now: it is stored encrypted and not shown again (rotate for a new one). After a rotation the previous secret also signs for 24 hours."
        value={secret}
        onClose={() => setSecret(null)}
      />
      <DeliveryDialog id={inspecting} onClose={() => setInspecting(null)} />
    </div>
  );
}
