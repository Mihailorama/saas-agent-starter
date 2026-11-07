import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Check, Download, FileText, Pencil, ThumbsDown, ThumbsUp, Upload } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AiBadge } from '@/components/ai-badge';
import { PageContainer, PageHeader } from '@/components/patterns/page-header';
import { ErrorState, QueryView } from '@/components/patterns/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { aiFeedback, track } from '@/lib/analytics';
import { type Attachment, api, formatBytes, formatDate, type Project } from '@/lib/api';

async function upload(projectId: string, file: File) {
  const { uploadUrl } = await api<{ uploadUrl: string }>(`/api/projects/${projectId}/attachments`, {
    method: 'POST',
    json: {
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
    },
  });
  // Straight to object storage with a short-lived presigned URL; the API never proxies bytes.
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'content-type': file.type || 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

/** The AI summary with human oversight: confirm it, or correct it (both are audit-logged). */
const PURPOSE = 'project.summary';

function AiSummaryCard({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [rated, setRated] = useState<boolean>();
  const shown = Boolean(project.aiSummary);
  useEffect(() => {
    if (shown) track('ai_summary_shown', { purpose: PURPOSE });
  }, [shown]);

  function rate(up: boolean) {
    setRated(up);
    if (project.aiCallId) {
      aiFeedback({
        purpose: PURPOSE,
        aiCallId: project.aiCallId,
        traceId: project.aiTraceId,
        up,
      }).catch(() => {}); // feedback is best effort; never block the user on it
    }
    if (!up) setEditing(true); // a thumbs down invites the correction right away
  }
  const review = useMutation({
    mutationFn: (summary?: string) =>
      api<Project>(
        `/api/projects/${project.id}/ai-summary/${summary === undefined ? 'confirm' : 'correct'}`,
        { method: 'POST', json: summary === undefined ? {} : { summary } },
      ),
    onSuccess: (updated) => {
      track('ai_summary_reviewed', { purpose: PURPOSE, action: updated.aiStatus ?? '' });
      queryClient.setQueryData(['projects', project.id], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'], exact: true });
      setEditing(false);
      toast.success(updated.aiStatus === 'corrected' ? 'Summary corrected' : 'Summary confirmed');
    },
    onError: (err) => toast.error(err.message),
  });

  if (!project.aiSummary || !project.aiStatus) {
    return project.description ? (
      <p className="text-sm text-muted-foreground">No AI summary yet.</p>
    ) : null;
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    review.mutate(String(new FormData(e.currentTarget).get('summary')));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Summary</CardTitle>
        <CardDescription>
          {project.aiStatus === 'generated'
            ? 'Written by an AI model. Check it before relying on it.'
            : `Reviewed ${project.reviewedAt ? formatDate(project.reviewedAt) : ''}`}
        </CardDescription>
        <CardAction>
          <AiBadge status={project.aiStatus} />
        </CardAction>
      </CardHeader>
      {editing ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <CardContent className="space-y-2">
            <Label htmlFor="ai-summary">Corrected summary</Label>
            <Textarea
              id="ai-summary"
              name="summary"
              defaultValue={project.aiSummary}
              maxLength={1000}
              required
              rows={3}
            />
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={review.isPending}>
              Save correction
            </Button>
          </CardFooter>
        </form>
      ) : (
        <>
          <CardContent>
            <p className="text-sm">{project.aiSummary}</p>
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Good summary"
              aria-pressed={rated === true}
              onClick={() => rate(true)}
            >
              <ThumbsUp className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Bad summary"
              aria-pressed={rated === false}
              onClick={() => rate(false)}
            >
              <ThumbsDown className="size-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="size-4" /> Correct
            </Button>
            {project.aiStatus !== 'confirmed' && (
              <Button
                size="sm"
                onClick={() => review.mutate(undefined)}
                disabled={review.isPending}
              >
                <Check className="size-4" /> Confirm
              </Button>
            )}
          </CardFooter>
        </>
      )}
    </Card>
  );
}

export function ProjectPage() {
  const { projectId = '' } = useParams({ strict: false });
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const project = useQuery({
    queryKey: ['projects', projectId],
    queryFn: () => api<Project>(`/api/projects/${projectId}`),
    // The AI summary arrives asynchronously from the worker; poll briefly for it.
    refetchInterval: (q) => {
      const p = q.state.data;
      const fresh = p && Date.now() - Date.parse(p.createdAt) < 60_000;
      return fresh && p.description && !p.aiSummary ? 3000 : false;
    },
  });
  const files = useQuery({
    queryKey: ['projects', projectId, 'attachments'],
    queryFn: () => api<Attachment[]>(`/api/projects/${projectId}/attachments`),
  });
  const add = useMutation({
    mutationFn: (file: File) => upload(projectId, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'attachments'] });
      toast.success('File uploaded');
    },
    onError: (err) => toast.error(err.message),
  });

  async function download(a: Attachment) {
    try {
      const { url } = await api<{ url: string }>(
        `/api/projects/${projectId}/attachments/${a.id}/download`,
      );
      window.location.assign(url);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (project.isError) {
    return (
      <PageContainer width="narrow">
        <ErrorState
          title="Project not available"
          error={project.error}
          onRetry={() => project.refetch()}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="narrow">
      {project.isPending ? (
        <Skeleton className="h-9 w-64" />
      ) : (
        <div className="space-y-2">
          <PageHeader
            title={project.data.name}
            description={
              <span className="flex items-center gap-2">
                Created {formatDate(project.data.createdAt)}
                {project.data.fingerprint && (
                  <Badge variant="secondary" className="font-normal tabular-nums">
                    {project.data.fingerprint}
                  </Badge>
                )}
              </span>
            }
          />
          {project.data.description && (
            <p className="text-sm whitespace-pre-line">{project.data.description}</p>
          )}
        </div>
      )}

      {project.data && <AiSummaryCard project={project.data} />}

      <Card>
        <CardHeader>
          <CardTitle>Files</CardTitle>
          <CardDescription>
            Stored in S3-compatible object storage, up to 10 MB each.
          </CardDescription>
          <CardAction>
            <Button size="sm" onClick={() => input.current?.click()} disabled={add.isPending}>
              <Upload /> {add.isPending ? 'Uploading…' : 'Upload'}
            </Button>
            <input
              ref={input}
              type="file"
              className="hidden"
              aria-label="File to upload"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) add.mutate(file);
                e.target.value = '';
              }}
            />
          </CardAction>
        </CardHeader>
        <CardContent>
          <QueryView
            query={files}
            errorTitle="Could not load files"
            loading={<Skeleton className="h-12 w-full" />}
            isEmpty={(list) => list.length === 0}
            empty={
              <p className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
                No files yet.
              </p>
            }
          >
            {(list) => (
              <ul className="divide-y rounded-md border">
                {list.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
                    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {a.filename}
                    </span>
                    <span className="text-xs text-muted-foreground">{formatBytes(a.size)}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Download ${a.filename}`}
                      onClick={() => download(a)}
                    >
                      <Download />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </QueryView>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
