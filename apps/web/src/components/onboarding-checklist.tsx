import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Circle, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { track } from '@/lib/analytics';
import { client, type Ok, ok } from '@/lib/api';
import { authClient } from '@/lib/auth';
import { useFlag } from '@/lib/flags';
import { store, stored } from '@/lib/onboarding';

type ItemId = Ok<'/api/onboarding/', 'get'>['items'][number]['id'];
type Dialogs = 'profile' | 'invite';
/** Copy and action per item; `to` links to the page where it is done, else a click handler. */
const ITEMS: Record<ItemId, { text: string; action: string; to?: string }> = {
  org_profile: { text: 'Add your company details', action: 'Add details' },
  first_project: { text: 'Create your first project', action: 'New project' },
  teammate_invited: { text: 'Invite a teammate', action: 'Invite' },
  two_factor: {
    text: 'Turn on two-factor authentication',
    action: 'Turn on',
    to: '/settings/security',
  },
  api_key: { text: 'Create an API key', action: 'Create key', to: '/settings/api-keys' },
};

/** A small form dialog: one submit, pending state, toast on error (profile and invite). */
function FormDialog(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  submit: string;
  onSubmit: (data: FormData) => Promise<{ error?: { message?: string } | null }>;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const { error } = await props.onSubmit(new FormData(e.currentTarget));
    setPending(false);
    if (error) return toast.error(error.message ?? 'Something went wrong');
    await queryClient.invalidateQueries({ queryKey: ['onboarding'] });
    toast.success('Saved');
    props.onOpenChange(false);
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="space-y-4" aria-label={props.title}>
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
            <DialogDescription>{props.description}</DialogDescription>
          </DialogHeader>
          {props.children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {props.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const field = (id: string, label: string, input: ReactNode) => (
  <div className="space-y-2">
    <Label htmlFor={id}>{label}</Label>
    {input}
  </div>
);

/** Onboarding checklist on the projects page (docs/onboarding.md). Done = the server says so. */
export function OnboardingChecklist({ onNewProject }: { onNewProject: () => void }) {
  const enabled = useFlag('onboarding');
  const { data: org } = authClient.useActiveOrganization();
  const dismissKey = `onboarding-checklist-dismissed:${org?.id}`;
  const [dismissed, setDismissed] = useState(false);
  const [dialog, setDialog] = useState<Dialogs>();
  const status = useQuery({
    queryKey: ['onboarding', org?.id],
    queryFn: () => ok(client.GET('/api/onboarding/')),
    enabled: enabled && Boolean(org),
  });
  const items = status.data?.items ?? [];
  const done = items.filter((i) => i.done).length;

  // `onboarding_item_completed` once per item and browser, when it is first seen done.
  useEffect(() => {
    if (!org) return;
    const key = `onboarding-reported:${org.id}`;
    const reported = new Set((stored(key) ?? '').split(','));
    const fresh = items.filter((i) => i.done && !reported.has(i.id));
    for (const i of fresh) track('onboarding_item_completed', { item: i.id });
    if (fresh.length) store(key, [...reported, ...fresh.map((i) => i.id)].join(','));
  }, [items, org]);

  if (!org || !status.data || dismissed || stored(dismissKey) || done === items.length) return null;

  const click: Partial<Record<ItemId, () => void>> = {
    org_profile: () => setDialog('profile'),
    first_project: onNewProject,
    teammate_invited: () => setDialog('invite'),
  };
  const metadata = (org.metadata ?? {}) as Record<string, string | undefined>;

  return (
    <Card data-tour="onboarding-checklist">
      <CardHeader>
        <CardTitle>Get set up</CardTitle>
        <CardDescription>
          {done} of {items.length} done. Each step ticks off by itself.
        </CardDescription>
        <CardAction>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Dismiss the setup checklist"
            onClick={() => {
              store(dismissKey, new Date().toISOString());
              setDismissed(true);
              track('onboarding_checklist_dismissed', { done });
            }}
          >
            <X />
          </Button>
        </CardAction>
        <Progress
          value={(done / items.length) * 100}
          aria-label="Setup progress"
          className="col-span-full mt-2"
        />
      </CardHeader>
      <CardContent>
        <ul className="divide-y" aria-label="Setup steps">
          {items.map((i) => (
            <li key={i.id} className="flex min-h-12 items-center gap-3 py-2">
              {i.done ? (
                <CheckCircle2 className="size-5 shrink-0 text-primary" aria-label="Done" />
              ) : (
                <Circle className="size-5 shrink-0 text-muted-foreground" aria-label="Not done" />
              )}
              <span className={i.done ? 'flex-1 text-muted-foreground line-through' : 'flex-1'}>
                {ITEMS[i.id].text}
              </span>
              {!i.done && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={click[i.id]}
                  asChild={!!ITEMS[i.id].to}
                >
                  {ITEMS[i.id].to ? (
                    <Link to={ITEMS[i.id].to}>{ITEMS[i.id].action}</Link>
                  ) : (
                    ITEMS[i.id].action
                  )}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <FormDialog
        open={dialog === 'profile'}
        onOpenChange={(o) => setDialog(o ? 'profile' : undefined)}
        title="Company details"
        description="Helps us tailor the product to your team. Only admins can change them."
        submit="Save details"
        onSubmit={(f) =>
          authClient.organization.update({
            data: {
              metadata: {
                ...metadata,
                size: String(f.get('size')),
                website: String(f.get('website')),
              },
            },
          })
        }
      >
        {field(
          'org-size',
          'Company size',
          <Input
            id="org-size"
            name="size"
            placeholder="11-50"
            defaultValue={metadata.size}
            required
          />,
        )}
        {field(
          'org-website',
          'Website',
          <Input
            id="org-website"
            name="website"
            type="url"
            placeholder="https://example.com"
            defaultValue={metadata.website}
            required
          />,
        )}
      </FormDialog>
      <FormDialog
        open={dialog === 'invite'}
        onOpenChange={(o) => setDialog(o ? 'invite' : undefined)}
        title="Invite a teammate"
        description="They get an email with a link to join this organization as a member."
        submit="Send invitation"
        onSubmit={(f) =>
          authClient.organization.inviteMember({ email: String(f.get('email')), role: 'member' })
        }
      >
        {field(
          'invite-email',
          'Email',
          <Input id="invite-email" name="email" type="email" required autoFocus />,
        )}
      </FormDialog>
    </Card>
  );
}
