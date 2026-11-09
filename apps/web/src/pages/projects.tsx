import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { FolderPlus, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
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
import { Textarea } from '@/components/ui/textarea';
import { track } from '@/lib/analytics';
import { client, formatDate, ok, type Project } from '@/lib/api';

const projectsQuery = { queryKey: ['projects'], queryFn: () => ok(client.GET('/api/projects/')) };

// Same limits as the API schema (apps/api/src/routes/projects.ts); the API stays the authority.
const projectSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(200, 'Use at most 200 characters.'),
  description: z.string().max(2000, 'Use at most 2000 characters.'),
});
type ProjectInput = z.infer<typeof projectSchema>;

function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<ProjectInput>({
    resolver: zodResolver(projectSchema),
    defaultValues: { name: '', description: '' },
  });
  const create = useMutation({
    mutationFn: (json: ProjectInput) => ok(client.POST('/api/projects/', { body: json })),
    onSuccess: (project) => {
      track('project_created', { has_description: Boolean(project.description) });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      toast.success(`Created ${project.name}`);
      form.reset();
      onOpenChange(false);
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) => create.mutate(values))}
            className="space-y-4"
            aria-label="New project"
            noValidate
          >
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
              <DialogDescription>
                A background workflow fingerprints the name right after creation.
              </DialogDescription>
            </DialogHeader>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description (optional)</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} />
                  </FormControl>
                  <FormDescription>
                    If AI is enabled, a model summarizes it; you can confirm or correct the summary.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                Create project
              </Button>
            </DialogFooter>
          </form>
        </Form>
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
  const [deleting, setDeleting] = useState<Project>();

  const remove = useMutation({
    mutationFn: (p: Project) =>
      ok(client.DELETE('/api/projects/{id}', { params: { path: { id: p.id } } })),
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
      header: sortable('Name'),
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
      meta: { className: 'hidden sm:table-cell' },
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
      header: sortable('Created'),
      enableGlobalFilter: false,
      cell: ({ row }) => (
        <span className="text-muted-foreground">{formatDate(row.original.createdAt)}</span>
      ),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <RowActions
          label={row.original.name}
          actions={[
            {
              label: 'Delete',
              icon: Trash2,
              destructive: true,
              onSelect: () => setDeleting(row.original),
            },
          ]}
        />
      ),
    },
  ];

  const newProject = (
    <Button onClick={() => setCreating(true)}>
      <Plus /> New project
    </Button>
  );

  return (
    <PageContainer>
      <PageHeader
        title="Projects"
        description="Everything your organization is working on."
        actions={<div data-tour="new-project">{newProject}</div>}
      />
      <OnboardingChecklist onNewProject={() => setCreating(true)} />
      <DataTable
        query={projects}
        columns={columns}
        label="Projects"
        errorTitle="Could not load projects"
        filterPlaceholder="Filter projects…"
        initialSorting={[{ id: 'createdAt', desc: true }]}
        empty={
          <EmptyState
            icon={FolderPlus}
            title="No projects yet"
            description="Create your first project to see the background workflow fill in its fingerprint."
            action={newProject}
          />
        }
      />
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`Delete ${deleting?.name ?? 'project'}?`}
        description="The project and its files are deleted for everyone in the organization. This cannot be undone."
        confirmLabel="Delete project"
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </PageContainer>
  );
}
