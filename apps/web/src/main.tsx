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
import { Shell } from '@/pages/shell';
import { SignInPage } from '@/pages/sign-in';

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

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  component: SignInPage,
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

const router = createRouter({
  routeTree: rootRoute.addChildren([
    signInRoute,
    aiTransparencyRoute,
    appRoute.addChildren([projectsRoute, projectRoute, aiCallsRoute]),
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
