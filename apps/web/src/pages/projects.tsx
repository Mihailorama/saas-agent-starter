import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { ArrowUpDown, FolderPlus, MoreHorizontal, Plus, Search, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
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
import { api, formatDate, type Project } from '@/lib/api';

const projectsQuery = { queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') };

function SortButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={onClick}>
      {label} <ArrowUpDown className="size-3.5" />
    </Button>
  );
}

function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: (name: string) => api<Project>('/api/projects', { method: 'POST', json: { name } }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(`Created ${project.name}`);
      onOpenChange(false);
    },
    onError: (err) => toast.error(err.message),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    create.mutate(String(new FormData(e.currentTarget).get('name')));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A background workflow fingerprints the name right after creation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input id="project-name" name="name" maxLength={200} required autoFocus />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const projects = useQuery({
    ...projectsQuery,
    // Fingerprints arrive asynchronously from the worker; poll until all are in.
    refetchInterval: (q) => (q.state.data?.some((p) => !p.fingerprint) ? 3000 : false),
  });
  const [creating, setCreating] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }]);
  const [filter, setFilter] = useState('');

  const remove = useMutation({
    mutationFn: (p: Project) => api(`/api/projects/${p.id}`, { method: 'DELETE' }),
    onSuccess: (_, p) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(`Deleted ${p.name}`);
    },
    onError: (err) =>
      toast.error(err.message === 'forbidden' ? 'Only admins can delete projects' : err.message),
  });

  const columns: ColumnDef<Project>[] = [
    {
      accessorKey: 'name',
      header: ({ column }) => <SortButton label="Name" onClick={() => column.toggleSorting()} />,
      cell: ({ row }) => (
        <Link
          to="/projects/$projectId"
          params={{ projectId: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: 'fingerprint',
      header: 'Fingerprint',
      enableGlobalFilter: false,
      cell: ({ row }) =>
        row.original.fingerprint ? (
          <Badge variant="secondary" className="font-normal tabular-nums">
            {row.original.fingerprint}
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">Processing…</span>
        ),
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) => <SortButton label="Created" onClick={() => column.toggleSorting()} />,
      enableGlobalFilter: false,
      cell: ({ row }) => (
        <span className="text-muted-foreground">{formatDate(row.original.createdAt)}</span>
      ),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <div className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Actions for ${row.original.name}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => remove.mutate(row.original)}
              >
                <Trash2 className="size-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  const table = useReactTable({
    data: projects.data ?? [],
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Everything your organization is working on.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> New project
        </Button>
      </div>

      {projects.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load projects</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-4">
            {projects.error.message}
            <Button size="sm" variant="outline" onClick={() => projects.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : projects.isPending ? (
        <div className="space-y-2 rounded-lg border p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : projects.data.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-lg bg-muted">
            <FolderPlus className="size-6 text-muted-foreground" />
          </span>
          <h2 className="mt-4 font-semibold">No projects yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Create your first project to see the background workflow fill in its fingerprint.
          </p>
          <Button className="mt-6" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New project
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative max-w-xs">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder="Filter projects…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-8"
            />
          </div>
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
                      No projects match “{filter}”.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
