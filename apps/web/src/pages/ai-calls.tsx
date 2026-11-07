import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { Download } from 'lucide-react';
import { useState } from 'react';
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
import { type AiCall, client, ok } from '@/lib/api';
import { authClient } from '@/lib/auth';

const PAGE = 50;
type Filters = Record<'purpose' | 'model' | 'status' | 'from' | 'to', string>;

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const columns: ColumnDef<AiCall>[] = [
  {
    accessorKey: 'createdAt',
    header: 'Time',
    cell: ({ row }) => (
      <span className="whitespace-nowrap">{dateTime(row.original.createdAt)}</span>
    ),
  },
  { accessorKey: 'purpose', header: 'Purpose' },
  {
    id: 'model',
    header: 'Model',
    cell: ({ row }) => (
      <span className="font-mono text-xs">
        {row.original.provider}/{row.original.responseModel ?? row.original.requestModel}
      </span>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) =>
      row.original.status === 'ok' ? (
        <Badge variant="secondary">ok</Badge>
      ) : (
        <Badge variant="destructive" title={row.original.errorClass ?? undefined}>
          error
        </Badge>
      ),
  },
  {
    id: 'tokens',
    header: 'Tokens in / out',
    cell: ({ row }) => (
      <span className="tabular-nums">
        {row.original.inputTokens ?? '–'} / {row.original.outputTokens ?? '–'}
      </span>
    ),
  },
  {
    accessorKey: 'cost',
    header: 'Cost',
    cell: ({ row }) =>
      row.original.cost === null ? (
        '–'
      ) : (
        <span className="tabular-nums">
          {row.original.cost.toFixed(6)} {row.original.costCurrency}
        </span>
      ),
  },
  {
    accessorKey: 'latencyMs',
    header: 'Latency',
    cell: ({ row }) => <span className="tabular-nums">{row.original.latencyMs} ms</span>,
  },
  { accessorKey: 'contour', header: 'Contour' },
];

/** Org-admin audit view of every LLM call (EU AI Act record-keeping). */
export function AiCallsPage() {
  const { data: org } = authClient.useActiveOrganization();
  const [filters, setFilters] = useState<Filters>({
    purpose: '',
    model: '',
    status: '',
    from: '',
    to: '',
  });
  const [offset, setOffset] = useState(0);
  const query = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Partial<
    Omit<Filters, 'status'> & { status: AiCall['status'] }
  >;
  const base = `/api/orgs/${org?.id}/ai-calls`;
  const calls = useQuery({
    queryKey: ['ai-calls', org?.id, query, offset],
    queryFn: () =>
      ok(
        client.GET('/api/orgs/{orgId}/ai-calls/', {
          params: { path: { orgId: org!.id }, query: { ...query, limit: PAGE, offset } },
        }),
      ),
    enabled: Boolean(org),
    placeholderData: keepPreviousData,
  });
  const table = useReactTable({
    data: calls.data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  const set = (key: keyof Filters) => (e: { target: { value: string } }) => {
    setFilters((f) => ({ ...f, [key]: e.target.value }));
    setOffset(0);
  };
  const total = calls.data?.total ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI calls</h1>
          <p className="text-sm text-muted-foreground">
            Every model call made for this organization. Prompts and outputs are kept in object
            storage and are not shown here.
          </p>
        </div>
        <Button variant="outline" asChild>
          <a href={`${base}/export?${query}`} download>
            <Download className="size-4" /> Export JSONL
          </a>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-5">
        <div className="space-y-1">
          <Label htmlFor="f-purpose">Purpose</Label>
          <Input id="f-purpose" value={filters.purpose} onChange={set('purpose')} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-model">Model</Label>
          <Input id="f-model" value={filters.model} onChange={set('model')} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-status">Status</Label>
          <select
            id="f-status"
            value={filters.status}
            onChange={set('status')}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
          >
            <option value="">Any</option>
            <option value="ok">ok</option>
            <option value="error">error</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-from">From</Label>
          <Input id="f-from" type="date" value={filters.from} onChange={set('from')} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-to">Before</Label>
          <Input id="f-to" type="date" value={filters.to} onChange={set('to')} />
        </div>
      </div>

      {calls.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load AI calls</AlertTitle>
          <AlertDescription>
            {calls.error.message === 'forbidden'
              ? 'Only organization admins can see the AI call log.'
              : calls.error.message}
          </AlertDescription>
        </Alert>
      ) : calls.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((group) => (
                  <TableRow key={group.id}>
                    {group.headers.map((header) => (
                      <TableHead key={header.id}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.length ? (
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length}
                      className="h-24 text-center text-muted-foreground"
                    >
                      No AI calls match these filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : '0 calls'}
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
