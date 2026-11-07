import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
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
import { type Body, client, formatDate, type Ok, ok } from '@/lib/api';
import { authClient } from '@/lib/auth';

type ApiKey = Ok<'/api/api-keys/', 'get'>[number];
type NewKey = Body<'/api/api-keys/', 'post'>;
const RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 };
const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs';

function NewKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (key: string) => void;
}) {
  const queryClient = useQueryClient();
  const scopes = useQuery({
    queryKey: ['api-key-scopes'],
    queryFn: () => ok(client.GET('/api/api-keys/scopes')),
  });
  const { data: member } = authClient.useActiveMember();
  const rank = Math.max(0, ...(member?.role.split(',') ?? []).map((r) => RANK[r.trim()] ?? 0));
  const create = useMutation({
    mutationFn: (json: NewKey) => ok(client.POST('/api/api-keys/', { body: json })),
    onSuccess: ({ key }, input) => {
      track('api_key_created', {
        scopes: input.scopes.length,
        expires: input.expiresInDays !== null,
      });
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      onOpenChange(false);
      onCreated(key);
    },
    onError: (err) => toast.error(err.message),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    // The checkboxes list the API's own scopes (/api/api-keys/scopes).
    const chosen = form.getAll('scope').map(String) as NewKey['scopes'];
    if (!chosen.length) return toast.error('Choose at least one scope');
    const days = String(form.get('expires'));
    create.mutate({
      name: String(form.get('name')),
      scopes: chosen,
      expiresInDays: days === 'never' ? null : Number(days),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="space-y-4" aria-label="New API key">
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>
              The key belongs to the organization and can do only what its scopes allow.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="key-name">Name</Label>
            <Input id="key-name" name="name" maxLength={32} required autoFocus placeholder="CI" />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Scopes</legend>
            {scopes.data?.map((s) => (
              <label key={s.scope} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="scope"
                  value={s.scope}
                  disabled={(RANK[s.role] ?? 0) > rank}
                  className="size-4 accent-primary"
                />
                <code className="text-xs">{s.scope}</code>
                <span className="text-xs text-muted-foreground">({s.role})</span>
              </label>
            )) ?? <Skeleton className="h-24 w-full" />}
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="key-expires">Expires</Label>
            <select id="key-expires" name="expires" defaultValue="90" className={selectClass}>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In 1 year</option>
              <option value="never">Never</option>
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Organization settings: API keys for the public API (docs/public-api.md). Admins only. */
export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => ok(client.GET('/api/api-keys/')),
  });
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: (k: ApiKey) =>
      ok(client.DELETE('/api/api-keys/{id}', { params: { path: { id: k.id } } })),
    onSuccess: (_, k) => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success(`Revoked ${k.name ?? k.start}`);
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
          <p className="text-sm text-muted-foreground">
            Send a key as <code>Authorization: Bearer &lt;key&gt;</code>. Routes and scopes are in{' '}
            <a href="/api/openapi.json" className="underline">
              the OpenAPI spec
            </a>
            .
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> New API key
        </Button>
      </div>

      {keys.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load API keys</AlertTitle>
          <AlertDescription>
            {keys.error.message === 'forbidden'
              ? 'Only organization admins can manage API keys.'
              : keys.error.message}
          </AlertDescription>
        </Alert>
      ) : keys.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : keys.data.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-lg bg-muted">
            <KeyRound className="size-6 text-muted-foreground" />
          </span>
          <h2 className="mt-4 font-semibold">No API keys yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Create a key to call the API from scripts and other services.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.data.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell className="font-mono text-xs">{k.start}…</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <Badge key={s} variant="secondary" className="font-normal">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {k.lastUsedAt ? formatDate(k.lastUsedAt) : 'Never'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {k.expiresAt ? formatDate(k.expiresAt) : 'Never'}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${k.name}`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => revoke.mutate(k)}
                        >
                          <Trash2 className="size-4" /> Revoke
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
      <NewKeyDialog open={creating} onOpenChange={setCreating} onCreated={setShown} />
      <SecretDialog
        title="Your new API key"
        description="Copy it now: it is stored hashed and will not be shown again."
        value={shown}
        onClose={() => setShown(null)}
      />
    </div>
  );
}
