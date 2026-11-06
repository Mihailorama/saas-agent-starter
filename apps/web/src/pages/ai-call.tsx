import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, Eye, ListPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { type AiCallDetail, api } from '@/lib/api';
import { authClient } from '@/lib/auth';

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

/** One LLM call: metadata, scores, trace link, content on request, "Add to golden set". */
export function AiCallPage() {
  const { callId } = useParams({ from: '/app/llm-ops/calls/$callId' });
  const { data: org } = authClient.useActiveOrganization();
  const base = `/api/orgs/${org?.id}/ai-calls/${callId}`;
  const queryClient = useQueryClient();
  const [showContent, setShowContent] = useState(false);
  const detail = useQuery({
    queryKey: ['ai-call', org?.id, callId],
    queryFn: () => api<AiCallDetail>(base),
    enabled: Boolean(org),
  });
  // Loaded only after an explicit click: every read is audit-logged.
  const content = useQuery({
    queryKey: ['ai-call-content', org?.id, callId],
    queryFn: () => api<{ request: unknown; response: unknown }>(`${base}/content`),
    enabled: Boolean(org) && showContent,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const addToDataset = useMutation({
    mutationFn: () => api(`${base}/dataset`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Added to the golden set. Run pnpm eval:pull to export it.');
      queryClient.invalidateQueries({ queryKey: ['ai-call', org?.id, callId] });
    },
    onError: (err) => toast.error(err.message),
  });

  if (detail.isError) {
    return (
      <Alert variant="destructive" className="mx-auto max-w-4xl">
        <AlertTitle>Could not load this call</AlertTitle>
        <AlertDescription>{detail.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (detail.isPending) return <Skeleton className="mx-auto h-64 max-w-4xl" />;
  const c = detail.data;
  const facts: [string, string][] = [
    ['Time', fmt(c.createdAt)],
    ['Purpose', c.purpose],
    ['Prompt', `${c.promptTemplateId} v${c.promptTemplateVersion}`],
    ['Model', `${c.provider}/${c.responseModel ?? c.requestModel}`],
    ['Status', c.status === 'ok' ? 'ok' : `error (${c.errorClass ?? 'unknown'})`],
    ['Tokens in / out', `${c.inputTokens ?? '–'} / ${c.outputTokens ?? '–'}`],
    ['Cost', c.cost === null ? '–' : `${c.cost.toFixed(6)} ${c.costCurrency}`],
    ['Latency', `${c.latencyMs} ms`],
    ['Contour', c.contour],
    ['Content kept until', fmt(c.contentExpiresAt)],
    ['Trace id', c.traceId ?? '–'],
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        to="/llm-ops"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> LLM Ops
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">AI call</h1>
        <div className="flex flex-wrap gap-2">
          {c.traceUrl && (
            <Button variant="outline" asChild>
              <a href={c.traceUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" /> Trace
              </a>
            </Button>
          )}
          {c.datasetItem ? (
            <Badge variant="secondary" className="h-9 px-3">
              In golden set ({c.datasetItem.status})
            </Badge>
          ) : (
            <Button
              onClick={() => addToDataset.mutate()}
              disabled={addToDataset.isPending || c.status !== 'ok' || !c.responseKey}
            >
              <ListPlus className="size-4" /> Add to golden set
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {facts.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scores</CardTitle>
          <CardDescription>
            user = human review, judge = daily LLM drift check, rule = deterministic check.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {c.scores.length ? (
            <ul className="divide-y text-sm">
              {c.scores.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-4 py-2">
                  <span>
                    <Badge variant="outline">{s.source}</Badge> {s.name}
                  </span>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    {s.judgeCallId && (
                      <Link
                        to="/llm-ops/calls/$callId"
                        params={{ callId: s.judgeCallId }}
                        className="underline-offset-4 hover:underline"
                      >
                        judge call
                      </Link>
                    )}
                    {fmt(s.createdAt)}
                    <span className="w-12 text-right font-medium text-foreground tabular-nums">
                      {s.value.toFixed(2)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No scores yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prompt and output</CardTitle>
          <CardDescription>
            May contain personal data. Viewing is recorded in the organization's audit log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!showContent ? (
            <Button variant="outline" onClick={() => setShowContent(true)}>
              <Eye className="size-4" /> Show content
            </Button>
          ) : content.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : content.isError ? (
            <p className="text-sm text-destructive">{content.error.message}</p>
          ) : content.data.request === null ? (
            <p className="text-sm text-muted-foreground">
              The content has been deleted (retention period over).
            </p>
          ) : (
            <div className="space-y-3">
              {[
                ['Request', content.data.request],
                ['Response', content.data.response],
              ].map(([label, doc]) => (
                <div key={label as string}>
                  <p className="mb-1 text-sm font-medium">{label as string}</p>
                  <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                    {JSON.stringify(doc, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
