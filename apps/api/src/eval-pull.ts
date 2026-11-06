// `pnpm eval:pull --org <orgId>`: turns the org's pending golden-set items ("Add to golden set"
// on the LLM Ops page) into Promptfoo test cases in evals/<purpose>/pulled.jsonl and marks them
// exported. pulled.jsonl is gitignored on purpose: it holds real prompts and outputs. Review and
// anonymize each case, then move it into evals/<purpose>/dataset.jsonl (AGENTS.md recipe).
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { aiCalls, aiDatasetItems, auditLog, withOrg } from '@app/db';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from './db.ts';
import { getAiContent } from './s3.ts';

type Message = { role: string; content: string };
export type TestCase = {
  description: string;
  vars: { input: string; recorded_output: string };
  metadata: Record<string, string>;
};

/** Pending items of one org as Promptfoo test cases, marked exported in the same transaction. */
export async function exportPending(orgId: string): Promise<{ purpose: string; test: TestCase }[]> {
  return withOrg(db, orgId, async (tx) => {
    const rows = await tx
      .select({ item: aiDatasetItems, call: aiCalls })
      .from(aiDatasetItems)
      .innerJoin(aiCalls, eq(aiCalls.id, aiDatasetItems.callId))
      .where(eq(aiDatasetItems.status, 'pending'))
      .for('update', { of: aiDatasetItems });
    const out: { purpose: string; test: TestCase }[] = [];
    for (const { call } of rows) {
      const request = (await getAiContent(call.requestKey)) as { messages: Message[] } | null;
      const response = call.responseKey
        ? ((await getAiContent(call.responseKey)) as { text: string } | null)
        : null;
      if (!request || !response) continue; // content expired: stays pending, nothing to export
      out.push({
        purpose: call.purpose,
        test: {
          description: `call ${call.id}`,
          vars: {
            input: request.messages
              .filter((m) => m.role === 'user')
              .map((m) => m.content)
              .join('\n\n'),
            recorded_output: response.text,
          },
          metadata: {
            callId: call.id,
            model: call.responseModel ?? call.requestModel,
            prompt: `${call.promptTemplateId} v${call.promptTemplateVersion}`,
          },
        },
      });
    }
    const exported = out.map((o) => o.test.metadata.callId!);
    if (exported.length) {
      await tx
        .update(aiDatasetItems)
        .set({ status: 'exported', exportedAt: new Date() })
        .where(inArray(aiDatasetItems.callId, exported));
      await tx.insert(auditLog).values(
        exported.map((callId) => ({
          orgId,
          actorId: 'eval:pull',
          action: 'ai_dataset.exported',
          target: callId,
        })),
      );
    }
    return out;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { org: { type: 'string' } } });
  if (!values.org) throw new Error('usage: pnpm eval:pull --org <orgId>');
  const root = new URL('../../../evals/', import.meta.url);
  const cases = await exportPending(values.org);
  for (const { purpose, test } of cases) {
    const dir = new URL(`${purpose}/`, root);
    mkdirSync(dir, { recursive: true });
    appendFileSync(new URL('pulled.jsonl', dir), `${JSON.stringify(test)}\n`);
  }
  console.log(
    `eval:pull: ${cases.length} case(s) appended to evals/<purpose>/pulled.jsonl (gitignored).` +
      ' They contain real prompts and outputs: review and anonymize before moving them into' +
      ' dataset.jsonl.',
  );
  await pool.end();
}
