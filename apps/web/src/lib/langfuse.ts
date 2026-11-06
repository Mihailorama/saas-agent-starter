import type { LangfuseWeb } from 'langfuse';
import { api } from '@/lib/api';

type ClientConfig = { langfuse: { baseUrl: string; publicKey: string } | null };
export type AiTrace = { traceId: string; spanId: string | null };

let client: Promise<LangfuseWeb | null> | undefined;

/** LangfuseWeb with the public key only (it can create scores, nothing else); null = Lite. */
function langfuse() {
  client ??= api<ClientConfig>('/api/client-config').then(async ({ langfuse: cfg }) => {
    if (!cfg) return null;
    const { LangfuseWeb } = await import('langfuse'); // loaded only when Langfuse is on
    return new LangfuseWeb({ publicKey: cfg.publicKey, baseUrl: cfg.baseUrl });
  });
  return client;
}

/**
 * User feedback on an AI output as a Langfuse trace score (Full LLM-ops profile). The same
 * judgement is already stored in ai_scores by the API; this copy is best effort.
 */
export async function sendFeedback(trace: AiTrace | null, value: number) {
  if (!trace) return;
  try {
    await (await langfuse())?.score({
      traceId: trace.traceId,
      ...(trace.spanId && { observationId: trace.spanId }),
      name: 'review',
      value,
    });
  } catch {
    // Feedback in Langfuse is a copy; the review itself has been saved.
  }
}
