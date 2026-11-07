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
import { Toaster } from '@/components/ui/sonner';
import { initAnalytics, page } from '@/lib/analytics';
import { authClient } from '@/lib/auth';
import { AcceptInvitationPage } from '@/pages/accept-invitation';
import { AiCallsPage } from '@/pages/ai-calls';
import { AiTransparencyPage } from '@/pages/ai-transparency';
import { ApiKeysPage } from '@/pages/api-keys';
import { BillingPage } from '@/pages/billing';
import { PrivacyPage } from '@/pages/privacy';
import { ProjectPage } from '@/pages/project';
import { ProjectsPage } from '@/pages/projects';
import { ResetPasswordPage } from '@/pages/reset-password';
import { SecurityPage } from '@/pages/security';
import { Shell } from '@/pages/shell';
import { SignInPage, safeRedirect } from '@/pages/sign-in';
import { TwoFactorPage } from '@/pages/two-factor';
import { WebhooksPage } from '@/pages/webhooks';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <Toaster richColors closeButton />
    </>
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

const billingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/billing',
  component: BillingPage,
});

const apiKeysRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/api-keys',
  component: ApiKeysPage,
});

const webhooksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/webhooks',
  component: WebhooksPage,
});

const securityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/security',
  component: SecurityPage,
});

const privacyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/privacy',
  component: PrivacyPage,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    signInRoute,
    twoFactorRoute,
    resetPasswordRoute,
    acceptInvitationRoute,
    aiTransparencyRoute,
    appRoute.addChildren([
      projectsRoute,
      projectRoute,
      aiCallsRoute,
      securityRoute,
      privacyRoute,
      apiKeysRoute,
      webhooksRoute,
      billingRoute,
    ]),
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
