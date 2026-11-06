import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { aiCalls, aiScores, createDb, organization, projects, withOrg } from '../src/index.ts';

// Connects as the restricted app role, exactly like the API.
const { db, pool } = createDb(process.env.DATABASE_URL!);
afterAll(() => pool.end());

async function newOrg() {
  const id = randomUUID();
  await db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
  return id;
}

describe('row-level security', () => {
  it('app role cannot bypass RLS', async () => {
    const { rows } = await db.execute<{ bypass: boolean }>(
      sql`select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user`,
    );
    expect(rows[0]?.bypass).toBe(false);
  });

  it('tenant A cannot read or change tenant B rows, even with a buggy query', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await withOrg(db, a, (tx) => tx.insert(projects).values({ orgId: a, name: 'a-secret' }));
    await withOrg(db, b, (tx) => tx.insert(projects).values({ orgId: b, name: 'b-secret' }));

    // Buggy query: forgot the org filter entirely. RLS still scopes it.
    const seenByA = await withOrg(db, a, (tx) => tx.select().from(projects));
    expect(seenByA.map((p) => p.name)).toEqual(['a-secret']);

    // Buggy query: explicitly asks for B's rows. Still nothing.
    const leaked = await withOrg(db, a, (tx) =>
      tx.select().from(projects).where(eq(projects.orgId, b)),
    );
    expect(leaked).toEqual([]);

    const updated = await withOrg(db, a, (tx) =>
      tx.update(projects).set({ name: 'pwned' }).where(eq(projects.orgId, b)).returning(),
    );
    expect(updated).toEqual([]);

    // Writing a row into another tenant is rejected by WITH CHECK.
    await expect(
      withOrg(db, a, (tx) => tx.insert(projects).values({ orgId: b, name: 'planted' })),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });

    // No tenant context at all -> no rows.
    expect(await db.select().from(projects)).toEqual([]);
  });
});

describe('ai_calls', () => {
  const row = (orgId: string) => ({
    orgId,
    purpose: 'test',
    provider: 'fake',
    requestModel: 'fake-model',
    promptTemplateId: 'test',
    promptTemplateVersion: '1',
    requestKey: `${orgId}/req.json`,
    contentExpiresAt: new Date(),
    latencyMs: 1,
    status: 'ok' as const,
    contour: 'eu',
  });

  it('is tenant-isolated and append-only for the app role', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const [call] = await withOrg(db, a, (tx) => tx.insert(aiCalls).values(row(a)).returning());
    await withOrg(db, b, (tx) => tx.insert(aiCalls).values(row(b)));

    const seenByA = await withOrg(db, a, (tx) => tx.select().from(aiCalls));
    expect(seenByA.map((c) => c.id)).toEqual([call!.id]);
    expect(await db.select().from(aiCalls)).toEqual([]);
    await expect(withOrg(db, a, (tx) => tx.insert(aiCalls).values(row(b)))).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/row-level security/) },
    });

    // No UPDATE/DELETE grant at all, even on the tenant's own rows.
    await expect(
      withOrg(db, a, (tx) =>
        tx.update(aiCalls).set({ status: 'error' }).where(eq(aiCalls.id, call!.id)),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
    await expect(
      withOrg(db, a, (tx) => tx.delete(aiCalls).where(eq(aiCalls.id, call!.id))),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
  });
});

describe('ai_scores', () => {
  it('is tenant-isolated and append-only for the app role', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const call = async (org: string) => {
      const [c] = await withOrg(db, org, (tx) =>
        tx
          .insert(aiCalls)
          .values({
            orgId: org,
            purpose: 'test',
            provider: 'fake',
            requestModel: 'fake-model',
            promptTemplateId: 'test',
            promptTemplateVersion: '1',
            requestKey: `${org}/req.json`,
            contentExpiresAt: new Date(),
            latencyMs: 1,
            status: 'ok',
            contour: 'eu',
          })
          .returning(),
      );
      return c!.id;
    };
    const callA = await call(a);
    const callB = await call(b);
    const score = (orgId: string, callId: string) => ({
      orgId,
      callId,
      source: 'user' as const,
      name: 'review',
      value: 1,
    });
    const [mine] = await withOrg(db, a, (tx) =>
      tx.insert(aiScores).values(score(a, callA)).returning(),
    );
    await withOrg(db, b, (tx) => tx.insert(aiScores).values(score(b, callB)));

    expect((await withOrg(db, a, (tx) => tx.select().from(aiScores))).map((s) => s.id)).toEqual([
      mine!.id,
    ]);
    expect(await db.select().from(aiScores)).toEqual([]);
    await expect(
      withOrg(db, a, (tx) => tx.insert(aiScores).values(score(b, callB))),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
    await expect(
      withOrg(db, a, (tx) =>
        tx.insert(aiScores).values({ ...score(a, callA), source: 'bogus' as 'user' }),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/ai_scores_source/) } });
    await expect(
      withOrg(db, a, (tx) =>
        tx.update(aiScores).set({ value: 0 }).where(eq(aiScores.id, mine!.id)),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
    await expect(
      withOrg(db, a, (tx) => tx.delete(aiScores).where(eq(aiScores.id, mine!.id))),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
  });
});
