import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Download, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { gaClientId, track } from '@/lib/analytics';
import { api, formatDate } from '@/lib/api';
import { authClient } from '@/lib/auth';

// Data-subject rights (docs/privacy.md): download or delete your data, or (owners) the
// organization's. The worker does the work; this page shows the requests and their outcome.
type Subject = 'user' | 'org';
type PrivacyRequest = {
  id: string;
  kind: 'export' | 'deletion';
  status: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  executeAfter: string;
  expiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
  downloadable: boolean;
  report: Record<string, { status: string; detail?: string }> | null;
};
const NOT_FRESH = 'sign in again to confirm this request';

const STATUS: Record<PrivacyRequest['status'], string> = {
  scheduled: 'Scheduled',
  running: 'In progress',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function SubjectCard({ subject }: { subject: Subject }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [stale, setStale] = useState(false);
  const key = ['privacy', subject];
  const base = `/api/privacy/${subject}`;
  const requests = useQuery({
    queryKey: key,
    queryFn: () => api<PrivacyRequest[]>(`${base}/requests`),
    // Poll while something is in flight.
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 5_000 : false),
  });
  const done = () => queryClient.invalidateQueries({ queryKey: key });
  const exportData = useMutation({
    mutationFn: () => api<PrivacyRequest>(`${base}/export`, { method: 'POST' }),
    onSuccess: () => {
      track('privacy_export_requested', { subject });
      toast.success('Export started. We will email you when it is ready.');
      return done();
    },
    onError: (e) => toast.error(e.message),
  });
  const deletion = useMutation({
    mutationFn: async () =>
      api<PrivacyRequest>(`${base}/deletion`, {
        method: 'POST',
        json: subject === 'user' ? { gaClientId: await gaClientId() } : {},
      }),
    onSuccess: () => {
      track('privacy_deletion_requested', { subject });
      setConfirming(false);
      return done();
    },
    onError: (e) => {
      setConfirming(false);
      if (e.message === NOT_FRESH) setStale(true);
      else toast.error(e.message);
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api<PrivacyRequest>(`${base}/requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      track('privacy_deletion_cancelled', { subject });
      toast.success('Deletion cancelled');
      return done();
    },
    onError: (e) => toast.error(e.message),
  });
  const download = async (id: string) => {
    const { url } = await api<{ url: string }>(`${base}/requests/${id}/download`);
    window.location.assign(url);
  };

  const pending = requests.data?.find((r) => r.kind === 'deletion' && r.status === 'scheduled');
  const what = subject === 'user' ? 'your account' : 'this organization';
  return (
    <Card>
      <CardHeader>
        <CardTitle>{subject === 'user' ? 'Your data' : 'Organization data'}</CardTitle>
        <CardDescription>
          {subject === 'user'
            ? 'Download everything we store about you, or delete your account.'
            : 'Download all data of this organization, or delete the organization (owners only).'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stale && (
          <Alert>
            <AlertTitle>Confirm it is you</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              Deletion needs a recent sign-in. Sign in again, then repeat it.
              <Button
                size="sm"
                onClick={async () => {
                  await authClient.signOut();
                  navigate({ to: '/sign-in', search: { redirect: '/settings/privacy' } });
                }}
              >
                Sign in again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {pending && (
          <Alert variant="destructive">
            <AlertTitle>Deletion scheduled for {formatDate(pending.executeAfter)}</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              Until then you can cancel it and nothing is deleted.
              <Button
                size="sm"
                variant="outline"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(pending.id)}
              >
                Cancel deletion
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={exportData.isPending}
            onClick={() => exportData.mutate()}
          >
            <Download className="size-4" /> Download {subject === 'user' ? 'my' : 'all'} data
          </Button>
          <Button
            variant="destructive"
            disabled={Boolean(pending)}
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="size-4" /> Delete {what}
          </Button>
        </div>
        {requests.data?.length ? (
          <ul className="divide-y rounded-md border text-sm" aria-label="Requests">
            {requests.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span>
                  {r.kind === 'export' ? 'Export' : 'Deletion'} requested {formatDate(r.createdAt)}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant={r.status === 'failed' ? 'destructive' : 'secondary'}>
                    {STATUS[r.status]}
                  </Badge>
                  {r.downloadable && (
                    <Button size="sm" variant="ghost" onClick={() => download(r.id)}>
                      Download
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {what}?</DialogTitle>
            <DialogDescription>
              The deletion starts after a grace period, during which you can cancel it. Then{' '}
              {subject === 'user'
                ? 'your account, sign-ins and personal data'
                : 'all projects, files, webhooks, API keys and memberships'}{' '}
              are deleted here and in the connected tools. Records the law requires us to keep
              (audit and AI logs) stay, without personal identifiers where allowed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Keep {what}
            </Button>
            <Button
              variant="destructive"
              disabled={deletion.isPending}
              onClick={() => deletion.mutate()}
            >
              Schedule deletion
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function PrivacyPage() {
  const { data: member } = authClient.useActiveMember();
  // UI hint only; the API enforces the owner role.
  const isOwner = member?.role.split(',').some((r) => r.trim() === 'owner') ?? false;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Privacy</h1>
      <SubjectCard subject="user" />
      {isOwner && <SubjectCard subject="org" />}
    </div>
  );
}
