import type { WorkflowHandle } from '@temporalio/client';

/**
 * Every payload in a workflow's history, decoded. Payload data are bytes, so a JSON dump of the
 * history never contains their text: checks for "no customer data in Temporal" must decode.
 */
export async function historyText(handle: WorkflowHandle): Promise<string> {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (v instanceof Uint8Array) out.push(Buffer.from(v).toString('utf8'));
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(await handle.fetchHistory());
  return out.join('\n');
}
