import './index.css';
import '@/lib/sentry';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  redirect,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsentBanner } from '@/components/consent-banner';
import { Toaster } from '@/components/ui/sonner';
import { initAnalytics, page } from '@/lib/analytics';
import { authClient } from '@/lib/auth';
import { AiCallsPage } from '@/pages/ai-calls';
import { AiTransparencyPage } from '@/pages/ai-transparency';
import { ProjectPage } from '@/pages/project';
import { ProjectsPage } from '@/pages/projects';
import { SecurityPage } from '@/pages/security';
import { Shell } from '@/pages/shell';
import { SignInPage } from '@/pages/sign-in';
import { TwoFactorPage } from '@/pages/two-factor';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <Toaster richColors closeButton />
      <ConsentBanner />
    </>
  ),
});

const redirectSearch = (s: Record<string, unknown>): { redirect?: string } =>
  typeof s.redirect === 'string' ? { redirect: s.redirect } : {};

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  component: SignInPage,
  validateSearch: redirectSearch,
});

// Second sign-in step (2FA); reachable only with the challenge cookie from /sign-in.
const twoFactorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/two-factor',
  component: TwoFactorPage,
  validateSearch: redirectSearch,
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
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (!data) throw redirect({ to: '/sign-in' });
  },
});

const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: ProjectsPage,
});

const projectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId',
  component: ProjectPage,
});

const aiCallsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/ai-calls',
  component: AiCallsPage,
});

const securityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/security',
  component: SecurityPage,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    signInRoute,
    twoFactorRoute,
    aiTransparencyRoute,
    appRoute.addChildren([projectsRoute, projectRoute, aiCallsRoute, securityRoute]),
  ]),
});

initAnalytics();
// Page views carry the route pattern (/projects/$projectId), never ids from the URL.
router.subscribe('onResolved', () => page(router.state.matches.at(-1)?.fullPath ?? '/'));

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
