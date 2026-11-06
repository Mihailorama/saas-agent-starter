import { aiCalls, aiScores, type Tx } from '@app/db';
import { metrics } from '@opentelemetry/api';
import { eq } from 'drizzle-orm';

// Same instrument as the worker (worker/ai.py): app_ai_score_* in Prometheus.
const scoreHistogram = metrics.getMeter('api.ai').createHistogram('app_ai_score', {
  description: 'Quality scores (0..1) of LLM calls by source (judge, rule, user)',
  advice: { explicitBucketBoundaries: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] },
});

export type NewScore = {
  orgId: string;
  callId: string;
  name: string;
  value: number;
  actorId: string;
};

/** Appends a user score (inside the caller's tenant transaction). Returns the call's trace ids. */
export async function addUserScore(tx: Tx, score: NewScore) {
  const [call] = await tx.select().from(aiCalls).where(eq(aiCalls.id, score.callId));
  if (!call) return null;
  const [row] = await tx
    .insert(aiScores)
    .values({ ...score, source: 'user' })
    .returning();
  scoreHistogram.record(score.value, {
    purpose: call.purpose,
    prompt_template: call.promptTemplateId,
    prompt_version: call.promptTemplateVersion,
    model: call.requestModel,
    source: 'user',
    name: score.name,
  });
  return { scoreId: row!.id, traceId: call.traceId, spanId: call.spanId };
}
