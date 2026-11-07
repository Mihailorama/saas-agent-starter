#!/usr/bin/env node
// Expand/contract gate (docs/deploy.md, ADR 0016). During a rollout, and after a rollback, the
// previous release runs against the new schema, so a migration may only expand it: new tables,
// nullable columns or columns with a DEFAULT, indexes, relaxed constraints. Whatever the previous
// release would break on goes into a later contract migration, shipped once no deployed release
// still uses the old shape, and that file must say why with a `-- contract: <reason>` line.
import { readdirSync, readFileSync } from 'node:fs';

const RULES = [
  [/\bDROP\s+(TABLE|COLUMN|SCHEMA|VIEW|TYPE|DEFAULT)\b/i, 'drops a table, column, type or default'],
  [/\bRENAME\b/i, 'renames'],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, 'changes a column type'],
  [/\bSET\s+NOT\s+NULL\b/i, 'makes a column NOT NULL'],
  [
    /\bADD\s+COLUMN\b(?![\s\S]*\bDEFAULT\b)[\s\S]*\bNOT\s+NULL\b/i,
    'adds a NOT NULL column without DEFAULT',
  ],
];

/** Breaking statements in one migration file; none if it is marked as a contract step. */
export function breaking(sql) {
  if (/^\s*--\s*contract:\s*\S/im.test(sql)) return [];
  const statements = sql.replace(/--.*$/gm, '').split(';');
  return statements.flatMap((s) => RULES.filter(([re]) => re.test(s)).map(([, why]) => why));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL('../packages/db/migrations/', import.meta.url);
  const bad = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .flatMap((f) => breaking(readFileSync(new URL(f, dir), 'utf8')).map((why) => `${f}: ${why}`));
  if (bad.length) {
    console.error(
      `Not backward compatible with the running release (expand/contract, docs/deploy.md):\n  ${bad.join('\n  ')}\n` +
        'Split it: expand now, contract in a later release, marked with `-- contract: <reason>`.',
    );
    process.exit(1);
  }
  console.log('migrations: expand-only (or marked contract steps)');
}
