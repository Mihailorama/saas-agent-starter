import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  aiCalls,
  auditLog,
  createDb,
  OPERATOR_READ_ROLE,
  organization,
  projects,
  withOperatorRead,
  withOrg,
} from '../src/index.ts';

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

describe('operator read path (docs/admin.md)', () => {
  it('sees every tenant read-only; the app role does not inherit it', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await withOrg(db, a, (tx) => tx.insert(projects).values({ orgId: a, name: 'a-op' }));
    await withOrg(db, b, (tx) => tx.insert(projects).values({ orgId: b, name: 'b-op' }));

    // Membership without inheritance: no rows and no operator rights without the explicit switch.
    const { rows } = await db.execute<{ usage: boolean; member: boolean }>(
      sql`select pg_has_role(current_user, ${OPERATOR_READ_ROLE}, 'USAGE') as usage,
                 pg_has_role(current_user, ${OPERATOR_READ_ROLE}, 'MEMBER') as member`,
    );
    expect(rows[0]).toEqual({ usage: false, member: true });
    expect(
      await withOrg(db, a, (tx) => tx.select().from(projects).where(eq(projects.orgId, b))),
    ).toEqual([]);

    const seen = await withOperatorRead(db, (tx) =>
      tx
        .select({ orgId: projects.orgId })
        .from(projects)
        .where(inArray(projects.orgId, [a, b])),
    );
    expect(new Set(seen.map((p) => p.orgId))).toEqual(new Set([a, b]));

    // Read-only: no write of any kind, not even into one tenant.
    for (const write of [
      (tx: Parameters<Parameters<typeof withOperatorRead>[1]>[0]) =>
        tx.insert(projects).values({ orgId: a, name: 'x' }),
      (tx: Parameters<Parameters<typeof withOperatorRead>[1]>[0]) =>
        tx.update(projects).set({ name: 'x' }).where(eq(projects.orgId, a)),
      (tx: Parameters<Parameters<typeof withOperatorRead>[1]>[0]) =>
        tx.delete(projects).where(eq(projects.orgId, b)),
    ]) {
      await expect(withOperatorRead(db, write)).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/read-only transaction|permission denied/) },
      });
    }
    // The role switch ends with the transaction: the pooled connection is the app role again.
    expect(await db.select().from(projects).where(eq(projects.orgId, a))).toEqual([]);
  });

  it('org-less audit rows: only operator actions, invisible to tenants', async () => {
    const a = await newOrg();
    const target = randomUUID();
    await db.insert(auditLog).values({ orgId: null, action: 'operator.user.x', target });
    await expect(
      db.insert(auditLog).values({ orgId: null, action: 'POST /api/projects', target }),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
    expect(
      await withOrg(db, a, (tx) => tx.select().from(auditLog).where(eq(auditLog.target, target))),
    ).toEqual([]);
    const rows = await withOperatorRead(db, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.target, target)),
    );
    expect(rows.map((r) => r.action)).toEqual(['operator.user.x']);
  });
});
