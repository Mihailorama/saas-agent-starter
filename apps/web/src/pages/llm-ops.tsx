import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, type DayStats, type VersionStats } from '@/lib/api';
import { authClient } from '@/lib/auth';
import { AiCallsSection } from '@/pages/ai-calls';

const DAYS = 30;
const score = (v: number | null, n?: number) =>
  v === null ? '–' : `${v.toFixed(2)}${n === undefined ? '' : ` (${n})`}`;
const axis = { fontSize: 12, stroke: 'hsl(var(--muted-foreground))' };

/** All purposes summed per day; scores averaged over the purposes that have one. */
function perDay(rows: DayStats[]) {
  const days = new Map<
    string,
    { day: string; calls: number; errors: number; judge: number[]; user: number[] }
  >();
  for (const r of rows) {
    const d = days.get(r.day) ?? { day: r.day, calls: 0, errors: 0, judge: [], user: [] };
    d.calls += r.calls;
    d.errors += r.errors;
    if (r.judgeScore !== null) d.judge.push(r.judgeScore);
    if (r.userScore !== null) d.user.push(r.userScore);
    days.set(r.day, d);
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return [...days.values()].map((d) => ({
    day: d.day.slice(5),
    ok: d.calls - d.errors,
    errors: d.errors,
    judge: avg(d.judge),
    user: avg(d.user),
  }));
}

/** Org-admin quality loop: scores and cost per prompt version, trends, and every call. */
export function LlmOpsPage() {
  const { data: org } = authClient.useActiveOrganization();
  const stats = useQuery({
    queryKey: ['ai-stats', org?.id],
    queryFn: () =>
      api<{ versions: VersionStats[]; days: DayStats[] }>(
        `/api/orgs/${org?.id}/ai-calls/stats?days=${DAYS}`,
      ),
    enabled: Boolean(org),
  });
  const days = perDay(stats.data?.days ?? []);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">LLM Ops</h1>
        <p className="text-sm text-muted-foreground">
          Quality, cost and latency of every AI feature over the last {DAYS} days. Judge scores come
          from the daily drift check, user scores from confirmations (1) and corrections (0).
        </p>
      </div>

      {stats.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load LLM Ops data</AlertTitle>
          <AlertDescription>
            {stats.error.message === 'forbidden'
              ? 'Only organization admins can see LLM Ops.'
              : stats.error.message}
          </AlertDescription>
        </Alert>
      ) : stats.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Calls per day</CardTitle>
              </CardHeader>
              <CardContent className="h-56">
                {days.length ? (
                  <ResponsiveContainer>
                    <BarChart data={days}>
                      <CartesianGrid vertical={false} strokeOpacity={0.3} />
                      <XAxis dataKey="day" tick={axis} />
                      <YAxis allowDecimals={false} tick={axis} width={32} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="ok" stackId="c" fill="hsl(var(--primary))" name="ok" />
                      <Bar
                        dataKey="errors"
                        stackId="c"
                        fill="hsl(var(--destructive))"
                        name="error"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-sm text-muted-foreground">No calls yet.</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Average score per day</CardTitle>
              </CardHeader>
              <CardContent className="h-56">
                {days.some((d) => d.judge !== null || d.user !== null) ? (
                  <ResponsiveContainer>
                    <LineChart data={days}>
                      <CartesianGrid vertical={false} strokeOpacity={0.3} />
                      <XAxis dataKey="day" tick={axis} />
                      <YAxis domain={[0, 1]} tick={axis} width={32} />
                      <Tooltip />
                      <Legend />
                      <Line
                        dataKey="judge"
                        name="judge"
                        stroke="hsl(var(--primary))"
                        connectNulls
                      />
                      <Line
                        dataKey="user"
                        name="user"
                        stroke="hsl(var(--muted-foreground))"
                        strokeDasharray="4 3"
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-sm text-muted-foreground">No scores yet.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold tracking-tight">Prompt versions</h2>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Prompt</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Errors</TableHead>
                    <TableHead className="text-right">Judge (n)</TableHead>
                    <TableHead className="text-right">User (n)</TableHead>
                    <TableHead className="text-right">Avg cost</TableHead>
                    <TableHead className="text-right">Avg latency</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.data.versions.length ? (
                    stats.data.versions.map((v) => (
                      <TableRow key={`${v.template}:${v.version}:${v.model}`}>
                        <TableCell className="font-mono text-xs">
                          {v.template} v{v.version}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{v.model}</TableCell>
                        <TableCell className="text-right tabular-nums">{v.calls}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {(v.errorRate * 100).toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {score(v.judgeScore, v.judged)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {score(v.userScore, v.reviewed)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {v.avgCost === null ? '–' : v.avgCost.toFixed(6)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {Math.round(v.avgLatencyMs)} ms
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={8} className="h-16 text-center text-muted-foreground">
                        No prompt versions used in this period.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </>
      )}

      <AiCallsSection />
    </div>
  );
}
