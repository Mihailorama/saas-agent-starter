// `pnpm eval:pull --org <orgId> --purpose <purpose> [--call <id>]... [--days 7] [--limit 20]`:
// turns logged LLM calls (ai_calls + their S3 content) into Promptfoo test cases appended to
// evals/<purpose>/pulled.jsonl. That file is gitignored on purpose: it holds real prompts and
// outputs. Review and anonymize each case, then move it into dataset.jsonl (AGENTS.md recipe).
// Every exported call is audit-logged.
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { aiCalls, auditLog, withOrg } from '@app/db';
import { and, desc, eq, gte, inArray, notLike } from 'drizzle-orm';
import { db, pool } from './db.ts';
import { getAiContent } from './s3.ts';

type Message = { role: string; content: string };
export type TestCase = {
  description: string;
  vars: { input: string; recorded_output: string };
  metadata: Record<string, string>;
};
export type PullOptions = { purpose: string; callIds?: string[]; days?: number; limit?: number };

/** Successful calls of one org and purpose as Promptfoo cases; skips calls whose content expired. */
export async function exportCalls(orgId: string, o: PullOptions): Promise<TestCase[]> {
  return withOrg(db, orgId, async (tx) => {
    const since = new Date(Date.now() - (o.days ?? 7) * 86_400_000);
    const rows = await tx
      .select()
      .from(aiCalls)
      .where(
        and(
          eq(aiCalls.purpose, o.purpose),
          eq(aiCalls.status, 'ok'),
          // MCP tool calls (provider `mcp` / `mcp:<server>`) are not model calls.
          notLike(aiCalls.provider, 'mcp%'),
          o.callIds?.length ? inArray(aiCalls.id, o.callIds) : gte(aiCalls.createdAt, since),
        ),
      )
      .orderBy(desc(aiCalls.createdAt))
      .limit(o.limit ?? 20);
    const out: TestCase[] = [];
    for (const call of rows) {
      const request = (await getAiContent(call.requestKey)) as { messages: Message[] } | null;
      const response = call.responseKey
        ? ((await getAiContent(call.responseKey)) as { text: string } | null)
        : null;
      if (!request || !response) continue;
      out.push({
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
      });
    }
    if (out.length) {
      await tx.insert(auditLog).values(
        out.map((c) => ({
          orgId,
          actorId: 'eval:pull',
          action: 'ai_call.exported_for_eval',
          target: c.metadata.callId!,
        })),
      );
    }
    return out;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      org: { type: 'string' },
      purpose: { type: 'string' },
      call: { type: 'string', multiple: true },
      days: { type: 'string' },
      limit: { type: 'string' },
    },
  });
  if (!values.org || !values.purpose) {
    throw new Error('usage: pnpm eval:pull --org <orgId> --purpose <purpose> [--call <id>]...');
  }
  const cases = await exportCalls(values.org, {
    purpose: values.purpose,
    callIds: values.call,
    days: values.days ? Number(values.days) : undefined,
    limit: values.limit ? Number(values.limit) : undefined,
  });
  const dir = new URL(`../../../evals/${values.purpose}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const test of cases)
    appendFileSync(new URL('pulled.jsonl', dir), `${JSON.stringify(test)}\n`);
  console.log(
    `eval:pull: ${cases.length} case(s) appended to evals/${values.purpose}/pulled.jsonl` +
      ' (gitignored). They contain real prompts and outputs: review and anonymize before' +
      ' moving them into dataset.jsonl.',
  );
  await pool.end();
}
