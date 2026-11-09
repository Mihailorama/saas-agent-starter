import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Circle, X } from 'lucide-react';
import { useState } from 'react';
import { FormDialog, InviteDialog } from '@/components/invite-dialog';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { track } from '@/lib/analytics';
import { client, type Ok, ok } from '@/lib/api';
import { authClient } from '@/lib/auth';
import { useFlag } from '@/lib/flags';
import { store, stored } from '@/lib/onboarding';

type ItemId = Ok<'/api/onboarding/', 'get'>['items'][number]['id'];
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
// Same values as ORG_SIZES in apps/api/src/auth.ts (the API validates them).
const SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'];

/**
 * Onboarding checklist on the projects page (docs/onboarding.md). The API returns only the items
 * the user's role can complete, each done or not from real data.
 */
export function OnboardingChecklist({ onNewProject }: { onNewProject: () => void }) {
  const { data: session } = authClient.useSession();
  const enabled = useFlag('onboarding') && !session?.session.impersonatedBy;
  const { data: org } = authClient.useActiveOrganization();
  const dismissKey = `onboarding-checklist-dismissed:${org?.id}`;
  const [dismissed, setDismissed] = useState(false);
  const [dialog, setDialog] = useState<'profile' | 'invite'>();
  const status = useQuery({
    queryKey: ['onboarding', org?.id],
    queryFn: () => ok(client.GET('/api/onboarding/')),
    enabled: enabled && Boolean(org),
  });
  const items = status.data?.items ?? [];
  const done = items.filter((i) => i.done).length;

  if (!enabled || !org || dismissed || stored(dismissKey) || done === items.length) return null;

  const click: Partial<Record<ItemId, () => void>> = {
    org_profile: () => setDialog('profile'),
    first_project: onNewProject,
    teammate_invited: () => setDialog('invite'),
  };
  const metadata = (org.metadata ?? {}) as { size?: string; website?: string };

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
        description="Helps us tailor the product to your team."
        submit="Save details"
        onSubmit={(f) =>
          authClient.organization.update({
            data: { metadata: { size: String(f.get('size')), website: String(f.get('website')) } },
          })
        }
      >
        <div className="space-y-2">
          <Label htmlFor="org-size">Company size</Label>
          <Select name="size" defaultValue={metadata.size} required>
            <SelectTrigger id="org-size" className="w-full">
              <SelectValue placeholder="Select a size" />
            </SelectTrigger>
            <SelectContent>
              {SIZES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s} people
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="org-website">Website</Label>
          <Input
            id="org-website"
            name="website"
            type="url"
            placeholder="https://example.com"
            maxLength={200}
            defaultValue={metadata.website}
            required
          />
        </div>
      </FormDialog>
      <InviteDialog
        open={dialog === 'invite'}
        onOpenChange={(o) => setDialog(o ? 'invite' : undefined)}
      />
    </Card>
  );
}
