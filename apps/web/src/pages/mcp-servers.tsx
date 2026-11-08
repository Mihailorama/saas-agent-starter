import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Plug, Plus, Power, Trash2 } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { DataTable, RowActions, sortable } from '@/components/patterns/data-table';
import { PageContainer, PageHeader } from '@/components/patterns/page-header';
import { EmptyState } from '@/components/patterns/states';
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
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { track } from '@/lib/analytics';
import { type Body, client, type Ok, ok } from '@/lib/api';
import { useFlag } from '@/lib/flags';

/** External MCP servers whose allowed tools AI features may call (docs/mcp.md). Org admins. */
type Server = Ok<'/api/mcp-servers/', 'get'>[number];
const listQuery = { queryKey: ['mcp-servers'], queryFn: () => ok(client.GET('/api/mcp-servers/')) };

// Same limits as the API schema (apps/api/src/routes/mcp-servers.ts); the API stays the authority.
const toolList = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
const schema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name.').max(100, 'Use at most 100 characters.'),
    url: z.url({ protocol: /^https?$/, message: 'Enter an http(s) URL.' }).max(2048),
    tools: z
      .string()
      .refine(
        (s) => toolList(s).every((t) => /^[A-Za-z0-9_.-]{1,128}$/.test(t)),
        'Tool names use letters, digits, _ . and -.',
      ),
    authHeader: z.string().regex(/^([A-Za-z0-9-]{1,100})?$/, 'Use letters, digits and -.'),
    authSecret: z.string().max(4096),
  })
  .refine((v) => !v.authSecret || v.authHeader, {
    path: ['authHeader'],
    message: 'Name the header that carries the secret.',
  });
type ServerInput = z.infer<typeof schema>;

function NewServerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<ServerInput>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', url: '', tools: '', authHeader: 'Authorization', authSecret: '' },
  });
  const create = useMutation({
    mutationFn: (json: Body<'/api/mcp-servers/', 'post'>) =>
      ok(client.POST('/api/mcp-servers/', { body: json })),
    onSuccess: (s) => {
      track('mcp_server_connected', {
        tools: s.allowedTools.length,
        has_auth: Boolean(s.authSecretHint),
      });
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
      toast.success(`Connected ${s.name}`);
      form.reset();
      onOpenChange(false);
    },
    onError: (err) => toast.error(err.message),
  });
  const submit = (v: ServerInput) =>
    create.mutate({
      name: v.name,
      url: v.url,
      allowedTools: toolList(v.tools),
      ...(v.authSecret && { authHeader: v.authHeader, authSecret: v.authSecret }),
    });

  const field = (
    name: keyof ServerInput,
    label: string,
    help?: string,
    props: ComponentProps<'input'> = {},
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field: f }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input {...props} {...f} />
          </FormControl>
          {help && <FormDescription>{help}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(submit)}
            className="space-y-4"
            aria-label="Connect MCP server"
            noValidate
          >
            <DialogHeader>
              <DialogTitle>Connect an MCP server</DialogTitle>
              <DialogDescription>
                AI features may call only the tools you list. The secret is stored encrypted and
                never shown again.
              </DialogDescription>
            </DialogHeader>
            {field('name', 'Name', undefined, { autoFocus: true })}
            {field('url', 'Server URL', 'Streamable HTTP endpoint, usually ending in /mcp.', {
              type: 'url',
              placeholder: 'https://mcp.example.com/mcp',
            })}
            {field('tools', 'Allowed tools', 'Tool names, separated by commas or spaces.', {
              placeholder: 'search, fetch_page',
            })}
            {field('authHeader', 'Auth header (optional)')}
            {field('authSecret', 'Auth header value (optional)', 'For example: Bearer <token>.', {
              type: 'password',
              autoComplete: 'off',
            })}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                Connect server
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function McpServersPage() {
  const enabled = useFlag('mcp-tools');
  const queryClient = useQueryClient();
  const servers = useQuery({ ...listQuery, enabled });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Server>();
  const change = useMutation({
    mutationFn: ({ id, ...body }: { id: string; enabled?: boolean; remove?: boolean }) =>
      body.remove
        ? ok(client.DELETE('/api/mcp-servers/{id}', { params: { path: { id } } }))
        : ok(client.PATCH('/api/mcp-servers/{id}', { params: { path: { id } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }),
    onError: (err) => toast.error(err.message),
  });
  if (!enabled) return null;

  const columns: ColumnDef<Server>[] = [
    {
      accessorKey: 'name',
      header: sortable('Name'),
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.name}</div>
          <div className="text-xs text-muted-foreground break-all">{row.original.url}</div>
        </div>
      ),
    },
    {
      id: 'tools',
      header: 'Allowed tools',
      accessorFn: (s) => s.allowedTools.join(' '),
      meta: { className: 'hidden md:table-cell' },
      cell: ({ row }) =>
        row.original.allowedTools.length ? (
          <div className="flex flex-wrap gap-1">
            {row.original.allowedTools.map((t) => (
              <Badge key={t} variant="secondary" className="font-normal">
                {t}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">None</span>
        ),
    },
    {
      id: 'auth',
      header: 'Auth',
      enableGlobalFilter: false,
      meta: { className: 'hidden sm:table-cell' },
      cell: ({ row }) =>
        row.original.authSecretHint ? (
          <span className="text-xs">
            {row.original.authHeader}{' '}
            <span className="tabular-nums">…{row.original.authSecretHint}</span>
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">None</span>
        ),
    },
    {
      accessorKey: 'enabled',
      header: 'Status',
      enableGlobalFilter: false,
      cell: ({ row }) => (
        <Badge variant={row.original.enabled ? 'default' : 'secondary'}>
          {row.original.enabled ? 'On' : 'Off'}
        </Badge>
      ),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <RowActions
          label={row.original.name}
          actions={[
            {
              label: row.original.enabled ? 'Turn off' : 'Turn on',
              icon: Power,
              onSelect: () =>
                change.mutate({ id: row.original.id, enabled: !row.original.enabled }),
            },
            {
              label: 'Remove',
              icon: Trash2,
              destructive: true,
              onSelect: () => setDeleting(row.original),
            },
          ]}
        />
      ),
    },
  ];

  const connect = (
    <Button onClick={() => setCreating(true)}>
      <Plus /> Connect server
    </Button>
  );

  return (
    <PageContainer>
      <PageHeader
        title="MCP servers"
        description="External tools that AI features of this organization may call."
        actions={connect}
      />
      <DataTable
        query={servers}
        columns={columns}
        label="MCP servers"
        errorTitle="Could not load MCP servers"
        filterPlaceholder="Filter servers…"
        empty={
          <EmptyState
            icon={Plug}
            title="No MCP servers yet"
            description="Connect a server and list the tools AI features may use."
            action={connect}
          />
        }
      />
      <NewServerDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`Remove ${deleting?.name ?? 'server'}?`}
        description="AI features stop calling its tools, and its stored secret is deleted."
        confirmLabel="Remove server"
        onConfirm={() => {
          if (!deleting) return;
          change.mutate(
            { id: deleting.id, remove: true },
            { onSuccess: () => toast.success(`Removed ${deleting.name}`) },
          );
        }}
      />
    </PageContainer>
  );
}
