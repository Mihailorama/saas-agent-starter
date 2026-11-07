import { describe, expect, it } from 'vitest';
import { flagEvaluator, posthogRemote } from '../src/flags.ts';

const catalog = { 'new-form': { default: false }, 'old-form': { default: true } };
const none = { on: [], off: [] };
const ctx = { userId: 'u1', orgId: 'o1', plan: 'pro' };

describe('isEnabled', () => {
  it('without PostHog: the catalog default', async () => {
    const isEnabled = flagEvaluator(catalog, none);
    expect(await isEnabled('new-form', ctx)).toBe(false);
    expect(await isEnabled('old-form', ctx)).toBe(true);
  });

  it('with PostHog: its answer wins; no answer or an error falls back to the default', async () => {
    const answers: Record<string, boolean | undefined> = { 'new-form': true, 'old-form': false };
    expect(await flagEvaluator(catalog, none, async (f) => answers[f])('new-form', ctx)).toBe(true);
    expect(await flagEvaluator(catalog, none, async (f) => answers[f])('old-form', ctx)).toBe(
      false,
    );
    expect(await flagEvaluator(catalog, none, async () => undefined)('old-form', ctx)).toBe(true);
    const failing = flagEvaluator(catalog, none, () => Promise.reject(new Error('timeout')));
    expect(await failing('old-form', ctx)).toBe(true);
  });

  it('FLAGS_ON / FLAGS_OFF override the default and PostHog', async () => {
    const remote = async () => false;
    const isEnabled = flagEvaluator(catalog, { on: ['new-form'], off: ['old-form'] }, remote);
    expect(await isEnabled('new-form', ctx)).toBe(true);
    expect(await isEnabled('old-form', ctx)).toBe(false);
  });

  it('rejects flags that are not in the catalog', async () => {
    await expect(flagEvaluator(catalog, none)('typo', ctx)).rejects.toThrow(/config\/flags.json/);
  });
});

describe('posthogRemote', () => {
  it('evaluates for the user, with the organization as a group and its plan', async () => {
    const calls: unknown[] = [];
    const client = {
      evaluateFlags: async (...args: unknown[]) => {
        calls.push(args);
        return { getFlag: (k: string) => (k === 'new-form' ? 'variant-b' : undefined) };
      },
    } as unknown as Parameters<typeof posthogRemote>[0];
    const remote = posthogRemote(client);
    expect(await remote('new-form', ctx)).toBe(true);
    expect(await remote('old-form', { userId: 'u2' })).toBeUndefined();
    expect(calls).toEqual([
      [
        'u1',
        {
          flagKeys: ['new-form'],
          groups: { organization: 'o1' },
          groupProperties: { organization: { plan: 'pro' } },
        },
      ],
      ['u2', { flagKeys: ['old-form'], groups: undefined, groupProperties: undefined }],
    ]);
  });
});
