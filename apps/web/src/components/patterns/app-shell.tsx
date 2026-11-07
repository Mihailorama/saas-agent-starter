import { Link, type LinkProps, useLocation, useNavigate } from '@tanstack/react-router';
import { type LucideIcon, PanelLeft } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { type CommandAction, CommandMenu } from '@/components/patterns/command-menu';
import { THEMES, ThemeToggle } from '@/components/patterns/theme-toggle';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { modKey } from '@/lib/hotkeys';
import { setTheme } from '@/lib/theme';

export type NavItem = {
  label: string;
  icon: LucideIcon;
  to: LinkProps['to'];
  /** Active state; default: the path is `to` or below it. */
  active?: (pathname: string) => boolean;
};
export type NavGroup = { label?: string; items: NavItem[] };
export type Crumb = { label: string; to?: string };

const isActive = (item: NavItem, pathname: string) =>
  item.active
    ? item.active(pathname)
    : pathname === item.to || (item.to !== '/' && pathname.startsWith(`${item.to}/`));

function Nav({ groups }: { groups: NavGroup[] }) {
  const pathname = useLocation({ select: (l) => l.pathname });
  const { setOpenMobile } = useSidebar();
  return groups.map((group, i) => (
    <SidebarGroup key={group.label ?? i}>
      {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
      <SidebarMenu>
        {group.items.map((item) => (
          <SidebarMenuItem key={item.label}>
            <SidebarMenuButton asChild isActive={isActive(item, pathname)} tooltip={item.label}>
              <Link to={item.to} onClick={() => setOpenMobile(false)}>
                <item.icon aria-hidden />
                <span>{item.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  ));
}

/** Where am I: parents link back, the last crumb is the current page. Mobile shows only that. */
export function PageBreadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  if (!crumbs.length) return null;
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={`${c.to ?? ''}:${c.label}`}>
              <BreadcrumbItem className={last ? 'min-w-0' : 'hidden md:inline-flex'}>
                {last || !c.to ? (
                  <BreadcrumbPage className="truncate">{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={c.to}>{c.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!last && <BreadcrumbSeparator className="hidden md:block" />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function Header({
  crumbs,
  nav,
  commands,
  actions,
}: {
  crumbs: Crumb[];
  nav: NavGroup[];
  commands: CommandAction[];
  actions?: ReactNode;
}) {
  const navigate = useNavigate();
  const { toggleSidebar } = useSidebar();
  const all: CommandAction[] = [
    ...nav.flatMap((g) =>
      g.items.map((item) => ({
        label: item.label,
        group: 'Go to',
        icon: item.icon,
        run: () => navigate({ to: item.to }),
      })),
    ),
    ...commands,
    ...THEMES.map(({ value, label, icon }) => ({
      label: `Theme: ${label.toLowerCase()}`,
      group: 'Preferences',
      icon,
      keywords: ['appearance', 'mode'],
      run: () => setTheme(value),
    })),
    {
      label: 'Toggle sidebar',
      group: 'Preferences',
      icon: PanelLeft,
      shortcut: `${modKey} B`,
      run: toggleSidebar,
    },
  ];
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <PageBreadcrumbs crumbs={crumbs} />
      <div className="ml-auto flex items-center gap-1">
        <CommandMenu commands={all} />
        {actions}
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * The signed-in layout: collapsible sidebar (a sheet on mobile), a header with breadcrumbs,
 * the command palette and the theme toggle, then the page. Navigation targets become
 * "Go to" commands automatically; pass extra `commands` for frequent actions.
 */
export function AppShell({
  nav,
  crumbs = [],
  sidebarHeader,
  sidebarFooter,
  headerActions,
  commands = [],
  children,
}: {
  nav: NavGroup[];
  crumbs?: Crumb[];
  sidebarHeader?: ReactNode;
  sidebarFooter?: ReactNode;
  headerActions?: ReactNode;
  commands?: CommandAction[];
  children: ReactNode;
}) {
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        {sidebarHeader && <SidebarHeader>{sidebarHeader}</SidebarHeader>}
        <SidebarContent>
          <Nav groups={nav} />
        </SidebarContent>
        {sidebarFooter && <SidebarFooter>{sidebarFooter}</SidebarFooter>}
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0">
        <Header crumbs={crumbs} nav={nav} commands={commands} actions={headerActions} />
        <main className="flex-1 p-4 md:p-8">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
