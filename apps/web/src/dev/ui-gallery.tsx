// Dev-only UI gallery (/dev/ui): every catalog component and pattern in one place, in the
// current theme. The visual regression and accessibility checks run against this page
// (apps/web/e2e/visual.spec.ts, a11y.spec.ts). Add a section when you add a component.
import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Bold,
  FolderPlus,
  Inbox,
  Italic,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Trash2,
  Underline,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { Combobox } from '@/components/patterns/combobox';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { DataTable, RowActions, sortable } from '@/components/patterns/data-table';
import { DatePicker } from '@/components/patterns/date-picker';
import { PageHeader } from '@/components/patterns/page-header';
import { SettingsSection, SettingsSections } from '@/components/patterns/settings-section';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/patterns/states';
import { ThemeToggle } from '@/components/patterns/theme-toggle';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { modKey } from '@/lib/hotkeys';
import {
  ownerOptions,
  type SampleProject,
  sampleDate,
  sampleMonth,
  sampleProjects,
} from './fixtures';
import { SCREENS, type Screen } from './routes';
import { SampleProjectForm } from './ui-screens';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      data-gallery-section={id}
      className="space-y-4 py-8"
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Example({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const colorRoles: [string, string, string][] = [
  ['background', 'bg-background', 'Page'],
  ['card', 'bg-card', 'Raised surface'],
  ['muted', 'bg-muted', 'Subtle fill'],
  ['accent', 'bg-accent', 'Hover / selected'],
  ['primary', 'bg-primary', 'Primary action'],
  ['secondary', 'bg-secondary', 'Secondary action'],
  ['destructive', 'bg-destructive', 'Danger'],
  ['border', 'bg-border', 'Borders, dividers'],
  ['ring', 'bg-ring', 'Focus ring'],
  ['sidebar', 'bg-sidebar', 'Sidebar'],
];

const sections: [string, string][] = [
  ['foundations', 'Foundations'],
  ['buttons', 'Buttons'],
  ['badges', 'Badges, avatars, keys'],
  ['inputs', 'Inputs'],
  ['form', 'Form with validation'],
  ['feedback', 'Feedback'],
  ['overlays', 'Overlays'],
  ['navigation', 'Navigation'],
  ['cards', 'Cards'],
  ['table', 'Table'],
  ['data-table', 'Data table'],
  ['states', 'Empty, loading, error'],
  ['patterns', 'Page patterns'],
];

const tableColumns: ColumnDef<SampleProject>[] = [
  { accessorKey: 'name', header: sortable('Name') },
  { accessorKey: 'owner', header: 'Owner', meta: { className: 'hidden sm:table-cell' } },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <Badge variant="secondary">{row.original.status}</Badge>,
  },
  {
    accessorKey: 'updated',
    header: sortable('Updated'),
    meta: { className: 'hidden sm:table-cell' },
  },
  {
    id: 'actions',
    cell: ({ row }) => (
      <RowActions
        label={row.original.name}
        actions={[
          { label: 'Edit', icon: Pencil, onSelect: () => toast(`Edit ${row.original.name}`) },
          {
            label: 'Delete',
            icon: Trash2,
            destructive: true,
            onSelect: () => toast(`Would confirm deleting ${row.original.name}`),
          },
        ]}
      />
    ),
  },
];
const loaded = {
  data: sampleProjects,
  error: null,
  isPending: false,
  isError: false,
  refetch: () => {},
};

export function UiGallery() {
  const [owner, setOwner] = useState<string>();
  const [date, setDate] = useState<Date | undefined>(sampleDate);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">UI gallery</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Every component and pattern in the catalog (development builds only). Build screens from
            these; see docs/ui.md and DESIGN.md.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <nav aria-label="Gallery sections" className="flex flex-wrap gap-x-4 gap-y-1 pt-4 text-sm">
        {sections.map(([id, title]) => (
          <a key={id} href={`#${id}`} className="text-muted-foreground hover:text-foreground">
            {title}
          </a>
        ))}
      </nav>

      <Section id="foundations" title="Foundations">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {colorRoles.map(([name, cls, use]) => (
            <div key={name} className="space-y-1.5">
              <div className={`h-12 rounded-md border ${cls}`} />
              <p className="text-sm font-medium">{name}</p>
              <p className="text-xs text-muted-foreground">{use}</p>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <p className="text-2xl font-semibold tracking-tight">Page title, 24/semibold</p>
          <p className="text-lg font-semibold">Section title, 18/semibold</p>
          <p className="font-medium">Card title, 16/medium</p>
          <p className="text-sm">Body text, 14/regular: the default for app UI.</p>
          <p className="text-sm text-muted-foreground">Secondary text, 14, muted.</p>
          <p className="text-xs text-muted-foreground">Caption, 12, muted.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {['rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl', 'rounded-full'].map((r) => (
            <div key={r} className="space-y-1 text-center">
              <div className={`size-12 border bg-muted ${r}`} />
              <p className="text-xs text-muted-foreground">{r.replace('rounded-', '')}</p>
            </div>
          ))}
        </div>
      </Section>

      <Separator />
      <Section id="buttons" title="Buttons">
        <Example label="Variants">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button variant="destructive">Delete</Button>
        </Example>
        <Example label="Sizes, icons, states">
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button>
            <Plus /> With icon
          </Button>
          <Button size="icon" variant="outline" aria-label="Settings">
            <Settings />
          </Button>
          <Button disabled>Disabled</Button>
          <Button disabled>
            <Spinner /> Saving…
          </Button>
        </Example>
      </Section>

      <Separator />
      <Section id="badges" title="Badges, avatars, keys">
        <Example label="Badges">
          <Badge>Active</Badge>
          <Badge variant="secondary">Paused</Badge>
          <Badge variant="outline">Archived</Badge>
          <Badge variant="destructive">Failed</Badge>
        </Example>
        <Example label="Avatars and keyboard keys">
          <Avatar>
            <AvatarFallback>AL</AvatarFallback>
          </Avatar>
          <Avatar className="size-8">
            <AvatarFallback className="text-xs">GH</AvatarFallback>
          </Avatar>
          <Kbd>{modKey} K</Kbd>
          <Kbd>Esc</Kbd>
        </Example>
      </Section>

      <Separator />
      <Section id="inputs" title="Inputs">
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="g-input">Text input</Label>
            <Input id="g-input" placeholder="Placeholder" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="g-invalid">Invalid input</Label>
            <Input id="g-invalid" aria-invalid aria-describedby="g-invalid-msg" defaultValue="x" />
            <p id="g-invalid-msg" className="text-sm text-destructive">
              Use at least 3 characters.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="g-disabled">Disabled input</Label>
            <Input id="g-disabled" disabled defaultValue="Read only" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="g-select">Select</Label>
            <Select defaultValue="active">
              <SelectTrigger id="g-select" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="g-combobox">Combobox (searchable select)</Label>
            <Combobox
              id="g-combobox"
              options={ownerOptions}
              value={owner}
              onChange={setOwner}
              placeholder="Choose a person"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="g-date">Date picker</Label>
            <DatePicker id="g-date" value={date} onChange={setDate} defaultMonth={sampleMonth} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="g-otp">One-time code</Label>
            <InputOTP id="g-otp" maxLength={6} autoComplete="one-time-code">
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="g-textarea">Textarea</Label>
            <Textarea id="g-textarea" placeholder="A few sentences" />
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Checkbox id="g-check" defaultChecked />
              <Label htmlFor="g-check" className="font-normal">
                Checkbox
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="g-switch" defaultChecked />
              <Label htmlFor="g-switch" className="font-normal">
                Switch
              </Label>
            </div>
          </div>
          <RadioGroup defaultValue="org" aria-label="Radio group">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="org" id="g-r1" />
              <Label htmlFor="g-r1" className="font-normal">
                Radio: everyone in the organization
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="private" id="g-r2" />
              <Label htmlFor="g-r2" className="font-normal">
                Radio: only people I invite
              </Label>
            </div>
          </RadioGroup>
        </div>
        <Example label="Calendar">
          <Calendar
            mode="single"
            selected={date}
            onSelect={setDate}
            defaultMonth={sampleMonth}
            className="rounded-md border"
          />
        </Example>
      </Section>

      <Separator />
      <Section id="form" title="Form with validation">
        <p className="text-sm text-muted-foreground">
          react-hook-form + zod: submit it empty to see the messages.
        </p>
        <Card>
          <CardContent>
            <SampleProjectForm />
          </CardContent>
        </Card>
      </Section>

      <Separator />
      <Section id="feedback" title="Feedback">
        <div className="grid gap-4 sm:grid-cols-2">
          <Alert>
            <Mail />
            <AlertTitle>Check your email</AlertTitle>
            <AlertDescription>We sent a confirmation link to ada@example.com.</AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <Inbox />
            <AlertTitle>Could not send the invitation</AlertTitle>
            <AlertDescription>The address bounced. Check it and try again.</AlertDescription>
          </Alert>
        </div>
        <Example label="Progress and loading">
          <Progress value={60} aria-label="Upload progress" className="w-64" />
          <Spinner aria-label="Loading" />
          <Skeleton className="h-4 w-40" />
        </Example>
        <Example label="Toasts (sonner)">
          <Button variant="outline" onClick={() => toast.success('Project created')}>
            Success
          </Button>
          <Button variant="outline" onClick={() => toast.error('Could not save the project')}>
            Error
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              toast('Project archived', { action: { label: 'Undo', onClick: () => {} } })
            }
          >
            With undo
          </Button>
        </Example>
      </Section>

      <Separator />
      <Section id="overlays" title="Overlays">
        <Example label="Dialogs and panels">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Rename project</DialogTitle>
                <DialogDescription>The new name is shown to everyone.</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="g-rename">Name</Label>
                <Input id="g-rename" defaultValue="Apollo" />
              </div>
              <DialogFooter>
                <Button>Save</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Sheet</Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Filters</SheetTitle>
                <SheetDescription>Narrow the list down.</SheetDescription>
              </SheetHeader>
              <SheetFooter>
                <Button>Apply</Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Confirm (destructive)
          </Button>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title="Delete Apollo?"
            description="The project and its files are deleted for everyone. This cannot be undone."
            confirmLabel="Delete project"
            onConfirm={() => toast.success('Deleted Apollo')}
          />
        </Example>
        <Example label="Popover, tooltip, menu">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">Popover</Button>
            </PopoverTrigger>
            <PopoverContent className="text-sm">Short contextual content.</PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline">Tooltip</Button>
            </TooltipTrigger>
            <TooltipContent>Explains an icon or a shortcut</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              <DropdownMenuItem>
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Example>
        <Example label={`Command palette (${modKey} K opens it in the app shell)`}>
          <Command className="max-w-sm rounded-lg border">
            <CommandInput placeholder="Type a command or search…" />
            <CommandList>
              <CommandEmpty>No matching commands.</CommandEmpty>
              <CommandGroup heading="Go to">
                <CommandItem>
                  <FolderPlus /> Projects
                </CommandItem>
                <CommandItem>
                  <Settings /> Settings
                  <CommandShortcut>{modKey} ,</CommandShortcut>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </Example>
      </Section>

      <Separator />
      <Section id="navigation" title="Navigation">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#navigation">Projects</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Apollo</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="text-sm text-muted-foreground">
            Tabs switch between views of the same object.
          </TabsContent>
          <TabsContent value="files" className="text-sm text-muted-foreground">
            Files tab.
          </TabsContent>
          <TabsContent value="activity" className="text-sm text-muted-foreground">
            Activity tab.
          </TabsContent>
        </Tabs>
        <Example label="Toolbar (icon buttons need a label)">
          {[
            [Bold, 'Bold'],
            [Italic, 'Italic'],
            [Underline, 'Underline'],
          ].map(([Icon, label]) => {
            const I = Icon as typeof Bold;
            return (
              <Button
                key={label as string}
                variant="ghost"
                size="icon"
                aria-label={label as string}
              >
                <I />
              </Button>
            );
          })}
        </Example>
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#navigation" />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#navigation">1</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#navigation" isActive>
                2
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
            <PaginationItem>
              <PaginationNext href="#navigation" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
        <Example label="Scroll area">
          <ScrollArea className="h-32 w-64 rounded-md border">
            <ul className="p-3 text-sm">
              {sampleProjects.map((p) => (
                <li key={p.id} className="py-1">
                  {p.name}
                </li>
              ))}
            </ul>
          </ScrollArea>
        </Example>
      </Section>

      <Separator />
      <Section id="cards" title="Cards">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Files</CardTitle>
              <CardDescription>Up to 10 MB each.</CardDescription>
              <CardAction>
                <Button size="sm">Upload</Button>
              </CardAction>
            </CardHeader>
            <CardContent className="text-sm">brief.pdf, budget.xlsx</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Invite a member</CardTitle>
              <CardDescription>They get an email with a link.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="g-invite">Email</Label>
              <Input id="g-invite" type="email" placeholder="name@example.com" />
            </CardContent>
            <CardFooter className="justify-end">
              <Button>Send invitation</Button>
            </CardFooter>
          </Card>
        </div>
      </Section>

      <Separator />
      <Section id="table" title="Table">
        <div className="rounded-lg border">
          <Table aria-label="Static table">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Files</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sampleProjects.slice(0, 3).map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>{p.owner}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.files}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      <Separator />
      <Section id="data-table" title="Data table">
        <p className="text-sm text-muted-foreground">
          Sorting, filter, pagination (5 per page here) and row actions on TanStack Table.
        </p>
        <DataTable
          query={loaded}
          columns={tableColumns}
          label="Sample projects"
          errorTitle="Could not load projects"
          filterPlaceholder="Filter projects…"
          pageSize={5}
          empty={<EmptyState title="No projects yet" />}
        />
      </Section>

      <Separator />
      <Section id="states" title="Empty, loading, error">
        <EmptyState
          icon={FolderPlus}
          title="No projects yet"
          description="Projects group your work. Create the first one to get started."
          action={
            <Button>
              <Plus /> New project
            </Button>
          }
        />
        <ListSkeleton rows={3} />
        <ErrorState
          title="Could not load projects"
          error={{ message: 'The server did not respond in time.' }}
          onRetry={() => toast.info('Retrying…')}
        />
      </Section>

      <Separator />
      <Section id="patterns" title="Page patterns">
        <div className="rounded-lg border p-6">
          <PageHeader
            title="Projects"
            description="Page header: one h1, a one-line description, primary action right."
            actions={
              <Button>
                <Plus /> New project
              </Button>
            }
          />
        </div>
        <div className="rounded-lg border p-6">
          <SettingsSections>
            <SettingsSection
              title="Profile"
              description="Settings section: label left, controls right."
            >
              <div className="space-y-2">
                <Label htmlFor="g-profile">Name</Label>
                <Input id="g-profile" defaultValue="Ada Lovelace" />
              </div>
            </SettingsSection>
            <SettingsSection title="Notifications" description="Stacks on mobile.">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="g-digest">Daily digest</Label>
                <Switch id="g-digest" />
              </div>
            </SettingsSection>
          </SettingsSections>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Reference screens (app shell with sidebar, header, breadcrumbs)
          </p>
          <ul className="flex flex-wrap gap-2">
            {(Object.entries(SCREENS) as [Screen, string][]).map(([key, title]) => (
              <li key={key}>
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/dev/ui/screens/${key}`}>{title}</Link>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </div>
  );
}
