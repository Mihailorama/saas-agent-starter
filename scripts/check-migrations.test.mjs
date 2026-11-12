// node --test 'scripts/*.test.mjs'  (part of pnpm check:ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breaking, journalOrder } from './check-migrations.mjs';

test('expand steps pass', () => {
  assert.deepEqual(
    breaking(`CREATE TABLE "t" ("id" uuid PRIMARY KEY NOT NULL);--> statement-breakpoint
ALTER TABLE "p" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "p" ADD COLUMN "n" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "p" ALTER COLUMN "x" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "p" DROP CONSTRAINT "c";
CREATE INDEX "i" ON "p" ("note");`),
    [],
  );
});

test('breaking steps fail', () => {
  const cases = {
    'ALTER TABLE "p" DROP COLUMN "x";': 'drops a table, column, type or default',
    'DROP TABLE "t";': 'drops a table, column, type or default',
    'ALTER TABLE "p" RENAME COLUMN "a" TO "b";': 'renames',
    'ALTER TABLE "p" ALTER COLUMN "a" SET DATA TYPE bigint;': 'changes a column type',
    'ALTER TABLE "p" ALTER COLUMN "a" SET NOT NULL;': 'makes a column NOT NULL',
    'ALTER TABLE "p" ADD COLUMN "a" text NOT NULL;': 'adds a NOT NULL column without DEFAULT',
  };
  for (const [sql, why] of Object.entries(cases)) assert.deepEqual(breaking(sql), [why], sql);
});

test('a marked contract step passes; a mention in a comment alone does not count', () => {
  assert.deepEqual(
    breaking('-- contract: v1.4 stopped reading "x"\nALTER TABLE "p" DROP COLUMN "x";'),
    [],
  );
  assert.deepEqual(breaking('-- DROP COLUMN later\nALTER TABLE "p" ADD COLUMN "y" text;'), []);
});

test('journal order: newer, numbered once, idx in sequence', () => {
  const e = (idx, tag, when) => ({ idx, tag, when });
  assert.deepEqual(journalOrder([e(0, '0000_a', 1), e(1, '0001_b', 2)]), []);
  const merged = journalOrder([e(0, '0000_a', 1), e(1, '0001_mine', 5), e(2, '0001_starter', 3)]);
  assert.equal(merged.length, 2);
  assert.match(merged.join(), /used twice/);
  assert.match(merged.join(), /skip this one/);
  assert.match(journalOrder([e(0, '0000_a', 1), e(2, '0001_b', 2)]).join(), /expected 1/);
});
