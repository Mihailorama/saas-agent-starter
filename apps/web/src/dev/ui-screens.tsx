// Reference screens for the dev gallery: each pattern assembled into a full page, the way a
// product screen should look. Copy one as the starting point for a new screen (docs/ui.md).
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ArrowLeft,
  ExternalLink,
  FileText,
  FolderKanban,
  FolderPlus,
  Layers,
  Pencil,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { AppShell, type Crumb, type NavGroup } from '@/components/patterns/app-shell';
import { Combobox } from '@/components/patterns/combobox';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { DataTable, RowActions, sortable } from '@/components/patterns/data-table';
import { DatePicker } from '@/components/patterns/date-picker';
import { PageContainer, PageHeader } from '@/components/patterns/page-header';
import { SettingsSection, SettingsSections } from '@/components/patterns/settings-section';
import { EmptyState, type QueryLike } from '@/components/patterns/states';
import { THEMES } from '@/components/patterns/theme-toggle';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { setTheme, type ThemeChoice, useThemeChoice } from '@/lib/theme';
import { ownerOptions, type SampleProject, sampleMonth, sampleProjects } from './fixtures';
import { SCREENS, type Screen } from './routes';

const fixture = <T,>(state: Partial<QueryLike<T>>): QueryLike<T> => ({
  data: undefined,
  error: null,
  isPending: false,
  isError: false,
  refetch: () => toast.info('Retrying…'),
  ...state,
});

const statusVariant = {
  Active: 'default',
  Paused: 'secondary',
  Archived: 'outline',
} as const;

// ── List ─────────────────────────────────────────────────────────────────────────────────

function ProjectList({ query }: { query: QueryLike<SampleProject[]> }) {
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<SampleProject>();
  const columns: ColumnDef<SampleProject>[] = [
    {
      accessorKey: 'name',
      header: sortable('Name'),
      cell: ({ row }) => (
        <Link to="/dev/ui/screens/detail" className="font-medium hover:underline">
          {row.original.name}
        </Link>
      ),
    },
    { accessorKey: 'owner', header: 'Owner', meta: { className: 'hidden md:table-cell' } },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={statusVariant[row.original.status]}>{row.original.status}</Badge>
      ),
    },
    {
      accessorKey: 'files',
      meta: { className: 'hidden md:table-cell' },
      header: () => <span className="block text-right">Files</span>,
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">{row.original.files}</span>
      ),
    },
    {
      accessorKey: 'updated',
      header: sortable('Updated'),
      meta: { className: 'hidden sm:table-cell' },
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.updated}</span>,
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <RowActions
          label={row.original.name}
          actions={[
            {
              label: 'Open',
              icon: ExternalLink,
              onSelect: () => navigate({ to: '/dev/ui/screens/detail' }),
            },
            {
              label: 'Edit',
              icon: Pencil,
              onSelect: () => navigate({ to: '/dev/ui/screens/form' }),
            },
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
  const create = (
    <Button asChild>
      <Link to="/dev/ui/screens/form">
        <Plus /> New project
      </Link>
    </Button>
  );
  return (
    <PageContainer>
      <PageHeader
        title="Projects"
        description="Everything your organization is working on."
        actions={create}
      />
      <DataTable
        query={query}
        columns={columns}
        label="Projects"
        errorTitle="Could not load projects"
        filterPlaceholder="Filter projects…"
        empty={
          <EmptyState
            icon={FolderPlus}
            title="No projects yet"
            description="Projects group your work. Create the first one to get started."
            action={create}
          />
        }
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`Delete ${deleting?.name}?`}
        description="The project and its files are deleted for everyone. This cannot be undone."
        confirmLabel="Delete project"
        onConfirm={() => toast.success(`Deleted ${deleting?.name}`)}
      />
    </PageContainer>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────────────────

function ProjectDetail() {
  const project = sampleProjects[0]!;
  const [deleting, setDeleting] = useState(false);
  return (
    <PageContainer width="narrow">
      <PageHeader
        title={project.name}
        description={`Owned by ${project.owner} · Updated ${project.updated}`}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/dev/ui/screens/form">
                <Pencil /> Edit
              </Link>
            </Button>
            <Button variant="outline" onClick={() => setDeleting(true)}>
              <Trash2 /> Delete
            </Button>
          </>
        }
      />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
              <CardDescription>What this project is and who looks after it.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  <Badge variant={statusVariant[project.status]}>{project.status}</Badge>
                </dd>
                <dt className="text-muted-foreground">Owner</dt>
                <dd>{project.owner}</dd>
                <dt className="text-muted-foreground">Description</dt>
                <dd>Telemetry pipeline for the ground station, from ingest to dashboards.</dd>
              </dl>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="files">
          <ul className="divide-y rounded-md border">
            {['brief.pdf', 'budget.xlsx', 'diagram.png'].map((f) => (
              <li key={f} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <FileText className="size-4 text-muted-foreground" aria-hidden /> {f}
              </li>
            ))}
          </ul>
        </TabsContent>
        <TabsContent value="activity">
          <p className="text-sm text-muted-foreground">No activity in the last 30 days.</p>
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${project.name}?`}
        description="The project and its files are deleted for everyone. This cannot be undone."
        confirmLabel="Delete project"
        onConfirm={() => toast.success(`Deleted ${project.name}`)}
      />
    </PageContainer>
  );
}

// ── Create / edit form ───────────────────────────────────────────────────────────────────

const formSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(80, 'Use at most 80 characters.'),
  description: z.string().max(500, 'Use at most 500 characters.'),
  owner: z.string({ error: 'Choose an owner.' }).min(1, 'Choose an owner.'),
  status: z.enum(['Active', 'Paused', 'Archived']),
  visibility: z.enum(['private', 'organization']),
  due: z.date().optional(),
  notify: z.boolean(),
});
type FormValues = z.infer<typeof formSchema>;

/** Labels above fields, help text under them, errors in place after submit, actions bottom-left. */
export function SampleProjectForm({ onCancel }: { onCancel?: () => void }) {
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      description: '',
      owner: '',
      status: 'Active',
      visibility: 'organization',
      notify: true,
    },
  });
  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((v) => toast.success(`Saved ${v.name}`))}
        className="space-y-6"
        aria-label="Project"
        noValidate
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Apollo" {...field} />
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
              <FormDescription>Shown on the project page. Plain text.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid gap-6 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="owner"
            render={({ field, fieldState }) => (
              <FormItem>
                <FormLabel>Owner</FormLabel>
                <FormControl>
                  <Combobox
                    options={ownerOptions}
                    value={field.value || undefined}
                    onChange={(v) => field.onChange(v ?? '')}
                    placeholder="Choose a person"
                    searchPlaceholder="Search people…"
                    aria-invalid={Boolean(fieldState.error)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {(['Active', 'Paused', 'Archived'] as const).map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="due"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Due date (optional)</FormLabel>
                <FormControl>
                  <DatePicker
                    value={field.value}
                    onChange={field.onChange}
                    defaultMonth={sampleMonth}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="visibility"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Visibility</FormLabel>
              <FormControl>
                <RadioGroup value={field.value} onValueChange={field.onChange}>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="organization" id="vis-org" />
                    <Label htmlFor="vis-org" className="font-normal">
                      Everyone in the organization
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="private" id="vis-private" />
                    <Label htmlFor="vis-private" className="font-normal">
                      Only people I invite
                    </Label>
                  </div>
                </RadioGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="notify"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <FormLabel>Email me about changes</FormLabel>
                <FormDescription>A daily digest, never more than one email a day.</FormDescription>
              </div>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )}
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            Save project
          </Button>
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </Form>
  );
}

function ProjectFormScreen() {
  const navigate = useNavigate();
  return (
    <PageContainer width="narrow">
      <PageHeader title="New project" description="You can change all of this later." />
      <Card>
        <CardContent>
          <SampleProjectForm onCancel={() => navigate({ to: '/dev/ui/screens/list' })} />
        </CardContent>
      </Card>
    </PageContainer>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────

function SettingsScreen() {
  const choice = useThemeChoice();
  const [confirming, setConfirming] = useState(false);
  return (
    <PageContainer width="narrow">
      <PageHeader title="Settings" description="Your profile and workspace preferences." />
      <SettingsSections>
        <SettingsSection title="Profile" description="How others see you in this workspace.">
          <div className="space-y-2">
            <Label htmlFor="settings-name">Name</Label>
            <Input id="settings-name" defaultValue="Ada Lovelace" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-email">Email</Label>
            <Input id="settings-email" type="email" defaultValue="ada@example.com" />
          </div>
          <Button onClick={() => toast.success('Profile saved')}>Save profile</Button>
        </SettingsSection>
        <SettingsSection title="Notifications" description="Email is the only channel for now.">
          {[
            ['digest', 'Daily digest', 'One summary of changes in your projects.'],
            ['mentions', 'Mentions', 'When someone mentions you in a comment.'],
          ].map(([id, label, help]) => (
            <div key={id} className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor={`notify-${id}`}>{label}</Label>
                <p className="text-sm text-muted-foreground">{help}</p>
              </div>
              <Switch id={`notify-${id}`} defaultChecked={id === 'digest'} />
            </div>
          ))}
        </SettingsSection>
        <SettingsSection title="Appearance" description="System follows your device setting.">
          <RadioGroup
            value={choice}
            onValueChange={(v) => setTheme(v as ThemeChoice)}
            aria-label="Theme"
          >
            {THEMES.map((t) => (
              <div key={t.value} className="flex items-center gap-2">
                <RadioGroupItem value={t.value} id={`theme-${t.value}`} />
                <Label htmlFor={`theme-${t.value}`} className="font-normal">
                  {t.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </SettingsSection>
        <SettingsSection
          title="Delete workspace"
          description="Deletes every project and file in it for all members."
        >
          <div>
            <Button variant="destructive" onClick={() => setConfirming(true)}>
              Delete workspace
            </Button>
          </div>
        </SettingsSection>
      </SettingsSections>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this workspace?"
        description="All projects, files and members are removed. This cannot be undone."
        confirmLabel="Delete workspace"
        onConfirm={() => toast.success('Workspace deleted')}
      />
    </PageContainer>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────────────────────

const listScreens: Screen[] = ['list', 'detail', 'form', 'empty', 'loading', 'error'];
const nav: NavGroup[] = [
  {
    items: [
      {
        label: 'Projects',
        icon: FolderKanban,
        to: '/dev/ui/screens/list',
        active: (p) => listScreens.some((s) => p.endsWith(`/${s}`)),
      },
      { label: 'Settings', icon: Settings, to: '/dev/ui/screens/settings' },
    ],
  },
  { label: 'Gallery', items: [{ label: 'All components', icon: ArrowLeft, to: '/dev/ui' }] },
];

const crumbsFor: Record<Screen, Crumb[]> = {
  list: [{ label: 'Projects' }],
  empty: [{ label: 'Projects' }],
  loading: [{ label: 'Projects' }],
  error: [{ label: 'Projects' }],
  detail: [{ label: 'Projects', to: '/dev/ui/screens/list' }, { label: 'Apollo' }],
  form: [{ label: 'Projects', to: '/dev/ui/screens/list' }, { label: 'New project' }],
  settings: [{ label: 'Settings' }],
};

const screens: Record<Screen, () => ReactNode> = {
  list: () => <ProjectList query={fixture({ data: sampleProjects })} />,
  empty: () => <ProjectList query={fixture({ data: [] })} />,
  loading: () => <ProjectList query={fixture({ isPending: true })} />,
  error: () => (
    <ProjectList
      query={fixture({ isError: true, error: { message: 'The server did not respond in time.' } })}
    />
  ),
  detail: () => <ProjectDetail />,
  form: () => <ProjectFormScreen />,
  settings: () => <SettingsScreen />,
};

export function UiScreen() {
  const screen = useLocation({ select: (l) => l.pathname.split('/').pop() }) as Screen;
  return (
    <AppShell
      nav={nav}
      crumbs={crumbsFor[screen]}
      sidebarHeader={
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg">
              <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Layers className="size-4" aria-hidden />
              </span>
              <span className="truncate font-medium">Acme workspace</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      }
      sidebarFooter={
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg">
              <Avatar className="size-8">
                <AvatarFallback className="text-xs">AL</AvatarFallback>
              </Avatar>
              <span className="min-w-0 text-left">
                <span className="block truncate text-sm font-medium">Ada Lovelace</span>
                <span className="block truncate text-xs text-muted-foreground">
                  ada@example.com
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      }
      commands={[
        {
          label: 'New project',
          group: 'Actions',
          icon: Plus,
          run: () => toast.info('Would open the new project form'),
        },
      ]}
    >
      {screens[screen]?.() ?? <p>Unknown screen. Known: {Object.keys(SCREENS).join(', ')}</p>}
    </AppShell>
  );
}
