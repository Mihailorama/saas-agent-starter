import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { PageContainer, PageHeader } from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { track } from '@/lib/analytics';
import { client, ok } from '@/lib/api';

/** The organization's referral link (docs/growth.md). Admins; flag `referrals`. */
export function ReferralsPage() {
  const referral = useQuery({
    queryKey: ['referrals'],
    queryFn: () => ok(client.GET('/api/referrals/')),
  });
  const link = referral.data?.link;

  async function copy() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    track('referral_link_copied');
    toast.success('Link copied');
  }

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Referrals"
        description="Share your link. A new organization that signs up with it gets a discount on its first payment; your organization gets a credit once it pays."
      />
      {referral.isError ? (
        <p className="text-sm text-muted-foreground">Referrals are not available.</p>
      ) : referral.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="referral-link">Your referral link</Label>
            <div className="flex gap-2">
              <Input id="referral-link" readOnly value={link ?? 'Not available yet'} />
              <Button type="button" variant="outline" onClick={copy} disabled={!link}>
                <Copy className="size-4" /> Copy
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {referral.data.via === 'dub'
              ? 'Referrals run through our partner program; earnings are shown there.'
              : `Rewarded referrals so far: ${referral.data.rewarded}.`}
          </p>
        </div>
      )}
    </PageContainer>
  );
}
