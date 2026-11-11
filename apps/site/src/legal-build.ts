// The legal pages of this build (docs/legal.md): config + what this deployment uses. Processors
// in use come from the build env (browser tools) and deploy/setup/<SITE_DEPLOY_ENV>.answers.json
// (installed or connected components; without the file, core components only).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import catalog from '../../../config/components.json' with { type: 'json' };
import config from '../../../config/legal.json' with { type: 'json' };
import plans from '../../../config/plans.json' with { type: 'json' };
import { DOC_IDS, inUse, type LegalConfig, legalDocs, legalPath } from './legal.ts';

function answers() {
  // `astro build` runs in apps/site (pnpm --filter site build, also in the Dockerfile).
  const file = `${process.env.SITE_DEPLOY_ENV || 'production'}.answers.json`;
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), '../../deploy/setup', file), 'utf8'));
  } catch {
    return undefined;
  }
}

export const legal = config as LegalConfig;
const used = legal.processors.filter((p) => inUse(p, catalog.components, process.env, answers()));
export const legalPages = legalDocs(legal, used, plans);
/** Footer links: every legal page, in a fixed order. */
export const legalLinks = DOC_IDS.map((id) => ({
  id,
  title: legal.documents[id].title,
  href: legalPath(id),
}));
