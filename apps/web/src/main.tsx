import './index.css';
import '@/lib/sentry';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
  redirect,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Crumb } from '@/components/patterns/app-shell';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { devRoutes } from '@/dev/routes';
import { initAnalytics, page } from '@/lib/analytics';
import { authClient } from '@/lib/auth';
import { AcceptInvitationPage } from '@/pages/accept-invitation';
import { AiTransparencyPage } from '@/pages/ai-transparency';
import { ResetPasswordPage } from '@/pages/reset-password';
import { SecurityPage } from '@/pages/security';
import { Shell } from '@/pages/shell';
import { SignInPage, safeRedirect } from '@/pages/sign-in';
import { TwoFactorPage } from '@/pages/two-factor';

// App pages load on first visit (own chunks: data table, forms, zod); the bundle budget in
// lighthouserc.cjs keeps the entry chunk from regrowing.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

const rootRoute = createRootRoute({
  component: () => (
    <TooltipProvider>
      <Outlet />
      <Toaster closeButton />
    </TooltipProvider>
  ),
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  // After signing in, back to where the user was sent away from (e.g. an invitation link).
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirect(s.redirect),
  }),
  component: SignInPage,
});

// Second sign-in step (2FA); works only with the challenge cookie set by /sign-in.
const twoFactorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/two-factor',
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirect(s.redirect),
  }),
  component: TwoFactorPage,
});

// Public: the emailed reset link lands here with ?token= (or ?error= when it is invalid).
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  validateSearch: (s: Record<string, unknown>): { token?: string; error?: string } => ({
    token: typeof s.token === 'string' ? s.token : undefined,
    error: typeof s.error === 'string' ? s.error : undefined,
  }),
  component: ResetPasswordPage,
});

/** Session required; signed-out visitors come back here after signing in. */
const requireSession = async ({ location }: { location: { href: string } }) => {
  const { data } = await authClient.getSession();
  if (!data) throw redirect({ to: '/sign-in', search: { redirect: location.href } });
};

// Outside the shell: an invitee without an organization of their own must see it too.
const acceptInvitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-invitation/$invitationId',
  beforeLoad: requireSession,
  component: AcceptInvitationPage,
});

// Public: affected people must be able to read it without an account.
const aiTransparencyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ai-transparency',
  component: AiTransparencyPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: Shell,
  beforeLoad: requireSession,
});

const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  staticData: { crumbs: [{ label: 'Projects' }] },
  component: lazyRouteComponent(() => import('@/pages/projects'), 'ProjectsPage'),
});

const projectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId',
  staticData: { crumbs: [{ label: 'Projects', to: '/' }, { label: 'Project' }] },
  component: lazyRouteComponent(() => import('@/pages/project'), 'ProjectPage'),
});

const aiCallsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/ai-calls',
  staticData: { crumbs: [{ label: 'AI calls' }] },
  component: lazyRouteComponent(() => import('@/pages/ai-calls'), 'AiCallsPage'),
});

const billingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/billing',
  staticData: { crumbs: [{ label: 'Settings' }, { label: 'Billing' }] },
  component: lazyRouteComponent(() => import('@/pages/billing'), 'BillingPage'),
});

const apiKeysRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/api-keys',
  staticData: { crumbs: [{ label: 'Settings' }, { label: 'API keys' }] },
  component: lazyRouteComponent(() => import('@/pages/api-keys'), 'ApiKeysPage'),
});

const membersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/members',
  staticData: { crumbs: [{ label: 'Settings' }, { label: 'Members' }] },
  component: lazyRouteComponent(() => import('@/pages/members'), 'MembersPage'),
});

const webhooksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/webhooks',
  staticData: { crumbs: [{ label: 'Settings' }, { label: 'Webhooks' }] },
  component: lazyRouteComponent(() => import('@/pages/webhooks'), 'WebhooksPage'),
});

const aiProvidersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/ai-providers',
  staticData: { crumbs: [{ label: 'Settings' }, { label: 'AI providers' }] },
  component: lazyRouteComponent(() => import('@/pages/ai-providers'), 'AiProvidersPage'),
});

const securityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/security',
  staticData: { crumbs: [{ label: 'Settings' }, { label: 'Security' }] },
  component: SecurityPage, // eager: the shell imports its 2FA policy query anyway
});

// Operator console (docs/admin.md): its own layout, outside the customer shell. The API decides
// who may use it; others see "not available".
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  beforeLoad: requireSession,
  component: lazyRouteComponent(() => import('@/pages/admin'), 'AdminShell'),
});
const adminOrgsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  component: lazyRouteComponent(() => import('@/pages/admin-orgs'), 'AdminOrgsPage'),
});
const adminOrgRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/orgs/$orgId',
  component: lazyRouteComponent(() => import('@/pages/admin-orgs'), 'AdminOrgPage'),
});
const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/users',
  component: lazyRouteComponent(() => import('@/pages/admin-users'), 'AdminUsersPage'),
});
const adminUserRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/users/$userId',
  component: lazyRouteComponent(() => import('@/pages/admin-users'), 'AdminUserPage'),
});
const privacyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/privacy',
  staticData: { crumbs: [{ label: 'Settings' }, { label: 'Privacy' }] },
  component: lazyRouteComponent(() => import('@/pages/privacy'), 'PrivacyPage'),
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    signInRoute,
    twoFactorRoute,
    resetPasswordRoute,
    acceptInvitationRoute,
    aiTransparencyRoute,
    adminRoute.addChildren([adminOrgsRoute, adminOrgRoute, adminUsersRoute, adminUserRoute]),
    appRoute.addChildren([
      projectsRoute,
      projectRoute,
      aiCallsRoute,
      securityRoute,
      privacyRoute,
      apiKeysRoute,
      membersRoute,
      webhooksRoute,
      aiProvidersRoute,
      billingRoute,
    ]),
    // Dev-only UI gallery (/dev/ui): dead code in production builds, so Vite drops it (and the
    // gallery chunks); the cast keeps the routes in the types for typed links.
    ...(import.meta.env.DEV
      ? devRoutes(rootRoute)
      : ([] as unknown as ReturnType<typeof devRoutes<typeof rootRoute>>)),
  ]),
});

initAnalytics();
// Page views carry the route pattern (/projects/$projectId), never ids from the URL.
router.subscribe('onResolved', () => page(router.state.matches.at(-1)?.fullPath ?? '/'));

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    /** Breadcrumb trail shown in the app shell header; the last one is the current page. */
    crumbs?: Crumb[];
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
