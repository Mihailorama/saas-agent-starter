import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, organization, projects, withOrg } from '../src/index.ts';

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
