import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Download, FileText, Upload } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
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

export function ProjectPage() {
  const { projectId = '' } = useParams({ strict: false });
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const project = useQuery({
    queryKey: ['projects', projectId],
    queryFn: () => api<Project>(`/api/projects/${projectId}`),
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
      <Alert variant="destructive" className="mx-auto max-w-3xl">
        <AlertTitle>Project not available</AlertTitle>
        <AlertDescription>{project.error.message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Projects
      </Link>
      {project.isPending ? (
        <Skeleton className="h-9 w-64" />
      ) : (
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{project.data.name}</h1>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            Created {formatDate(project.data.createdAt)}
            {project.data.fingerprint && (
              <Badge variant="secondary" className="font-normal tabular-nums">
                {project.data.fingerprint}
              </Badge>
            )}
          </p>
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Files</CardTitle>
            <CardDescription>
              Stored in S3-compatible object storage, up to 10 MB each.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => input.current?.click()} disabled={add.isPending}>
            <Upload className="size-4" /> {add.isPending ? 'Uploading…' : 'Upload'}
          </Button>
          <input
            ref={input}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) add.mutate(file);
              e.target.value = '';
            }}
          />
        </CardHeader>
        <CardContent>
          {files.isPending ? (
            <Skeleton className="h-12 w-full" />
          ) : files.data?.length ? (
            <ul className="divide-y rounded-md border">
              {files.data.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.filename}</span>
                  <span className="text-xs text-muted-foreground">{formatBytes(a.size)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Download ${a.filename}`}
                    onClick={() => download(a)}
                  >
                    <Download className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
              No files yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
