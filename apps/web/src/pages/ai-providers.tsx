import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
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
import { useFlag } from '@/lib/flags';

/** The organization's own AI providers (docs/llm-providers.md "BYO"). Org admins, plan feature. */
type Provider = Ok<'/api/ai-providers/', 'get'>[number];
const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs';

function NewProviderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const options = useQuery({
    queryKey: ['ai-provider-options'],
    queryFn: () => ok(client.GET('/api/ai-providers/options')),
  });
  const [provider, setProvider] = useState('');
  const kind = options.data?.providers.find((p) => p.id === provider)?.kind;
  const create = useMutation({
    mutationFn: (json: Body<'/api/ai-providers/', 'post'>) =>
      ok(client.POST('/api/ai-providers/', { body: json })) as Promise<Provider>,
    onSuccess: (p) => {
      track('ai_provider_created', { kind: p.kind, purposes: Object.keys(p.models).length });
      queryClient.invalidateQueries({ queryKey: ['ai-providers'] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(err.message),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const models = Object.fromEntries(
      (options.data?.purposes ?? [])
        .map((p) => [p, String(form.get(`model:${p}`) ?? '').trim()])
        .filter(([, m]) => m),
    );
    if (!Object.keys(models).length) return toast.error('Set a model for at least one use');
    const apiKey = String(form.get('apiKey') ?? '');
    create.mutate({
      name: String(form.get('name')),
      provider,
      models,
      ...(kind === 'custom' && { baseUrl: String(form.get('baseUrl')) }),
      ...(apiKey && { apiKey }),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="space-y-4" aria-label="New AI provider">
          <DialogHeader>
            <DialogTitle>Add your own AI provider</DialogTitle>
            <DialogDescription>
              AI features of this organization then use your key or endpoint; you pay the provider
              directly. The key is stored encrypted and never shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ai-name">Name</Label>
            <Input id="ai-name" name="name" maxLength={100} required autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-provider">Provider</Label>
            <select
              id="ai-provider"
              required
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className={selectClass}
            >
              <option value="" disabled>
                Choose…
              </option>
              {options.data?.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.kind === 'custom' ? 'Custom OpenAI-compatible endpoint' : p.id}
                </option>
              ))}
            </select>
          </div>
          {kind === 'custom' && (
            <div className="space-y-2">
              <Label htmlFor="ai-base">Base URL</Label>
              <Input
                id="ai-base"
                name="baseUrl"
                type="url"
                required
                placeholder="https://llm.example.com/v1"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="ai-key">API key{kind === 'custom' ? ' (optional)' : ''}</Label>
            <Input
              id="ai-key"
              name="apiKey"
              type="password"
              autoComplete="off"
              required={kind !== 'custom'}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Model per use</legend>
            {options.data?.purposes.map((p) => (
              <div key={p} className="grid grid-cols-[10rem_1fr] items-center gap-2">
                <Label htmlFor={`ai-model-${p}`} className="font-mono text-xs">
                  {p}
                </Label>
                <Input id={`ai-model-${p}`} name={`model:${p}`} placeholder="model id" />
              </div>
            )) ?? <Skeleton className="h-16 w-full" />}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !provider}>
              Add provider
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AiProvidersPage() {
  const enabled = useFlag('byo-llm-providers');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: ['ai-providers'],
    queryFn: () => ok(client.GET('/api/ai-providers/')),
    enabled,
  });
  const change = useMutation({
    mutationFn: ({ id, ...json }: { id: string; enabled?: boolean; remove?: boolean }) =>
      json.remove
        ? ok(client.DELETE('/api/ai-providers/{id}', { params: { path: { id } } }))
        : ok(client.PATCH('/api/ai-providers/{id}', { params: { path: { id } }, body: json })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-providers'] }),
    onError: (err) => toast.error(err.message),
  });
  if (!enabled) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Cpu className="size-5" aria-hidden /> AI providers
          </h1>
          <p className="text-sm text-muted-foreground">
            Bring your own API key or endpoint. Without one, AI features use the models listed on
            the "How we use AI" page.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="size-4" /> Add provider
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Models</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.isPending && (
            <TableRow>
              <TableCell colSpan={6}>
                <Skeleton className="h-8 w-full" />
              </TableCell>
            </TableRow>
          )}
          {list.data?.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                No providers of your own yet.
              </TableCell>
            </TableRow>
          )}
          {list.data?.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">{p.name}</TableCell>
              <TableCell>
                {p.provider}
                {p.baseUrl && <div className="text-xs text-muted-foreground">{p.baseUrl}</div>}
              </TableCell>
              <TableCell className="text-xs">
                {Object.entries(p.models).map(([purpose, model]) => (
                  <div key={purpose}>
                    <code>{purpose}</code>: {model}
                  </div>
                ))}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {p.apiKeyHint ? `…${p.apiKeyHint}` : '-'}
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => change.mutate({ id: p.id, enabled: !p.enabled })}
                >
                  <Badge variant={p.enabled ? 'default' : 'secondary'}>
                    {p.enabled ? 'On' : 'Off'}
                  </Badge>
                </Button>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${p.name}`}
                  onClick={() => change.mutate({ id: p.id, remove: true })}
                >
                  <Trash2 className="size-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <NewProviderDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
