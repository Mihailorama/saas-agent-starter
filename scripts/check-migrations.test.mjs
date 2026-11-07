// node --test 'scripts/*.test.mjs'  (part of pnpm check:ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breaking } from './check-migrations.mjs';

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
