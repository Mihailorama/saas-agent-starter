import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trackerFromEnv } from '../src/tracker.ts';

/** One fake HTTP server for both trackers; each test sets `route` and reads `calls`. */
// biome-ignore lint/suspicious/noExplicitAny: JSON the fake received
type Call = { method: string; path: string; query: URLSearchParams; body: any };
let route: (c: Call) => [number, unknown, Record<string, string>?] = () => [404, {}];
const calls: Call[] = [];
let base = '';
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url!, 'http://x');
  const call = {
    method: req.method!,
    path: url.pathname,
    query: url.searchParams,
    body: raw ? JSON.parse(raw) : undefined,
  };
  calls.push(call);
  const [status, body, headers] = route(call);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
});
beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));
const posted = (suffix: string) =>
  calls.filter((c) => c.method !== 'GET' && c.path.endsWith(suffix)).map((c) => c.body);

describe('Plane tracker (default)', () => {
  const p = '/api/v1/workspaces/ws/projects/p1';
  const plane = () =>
    trackerFromEnv({
      PLANE_API_URL: base,
      PLANE_APP_URL: 'https://app.plane.test',
      PLANE_WORKSPACE: 'ws',
      PLANE_PROJECT_ID: 'p1',
      PLANE_API_TOKEN: 'key',
    })!;

  it('is the default and dry-runs without credentials', () => {
    expect(plane().name).toBe('plane');
    expect(trackerFromEnv({ GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' })).toBeUndefined();
    expect(() => trackerFromEnv({ TRACKER: 'jira' })).toThrow(/plane or github/);
  });

  it('finds open duplicates in Intake (every page) and in search, skipping finished ones', async () => {
    calls.length = 0;
    route = ({ method, path, query }) => {
      if (path === `${p}/intake-issues/`) {
        const second = query.get('cursor') === '100:1:0';
        const results = second
          ? [{ status: -2, issue: 'wi-intake', issue_detail: { name: '[cjm] signup' } }]
          : [{ status: -1, issue: 'wi-declined', issue_detail: { name: '[cjm] signup' } }];
        return [200, { results, next_cursor: '100:1:0', next_page_results: !second }];
      }
      if (path === '/api/v1/workspaces/ws/work-items/search/') {
        const issues = [
          { id: 'wi-done', name: '[cjm] activation' },
          { id: 'wi-open', name: '[cjm] activation' },
          { id: 'wi-other', name: '[cjm] activation dropped' },
        ];
        return [200, { issues }];
      }
      if (method === 'GET' && path.startsWith(`${p}/work-items/wi-`)) {
        return [200, { state: { group: path.includes('done') ? 'completed' : 'started' } }];
      }
      return [404, {}];
    };
    const t = plane();
    expect(await t.findOpen('cjm-regression', '[cjm] signup')).toEqual({
      ref: 'wi-intake',
      url: 'https://app.plane.test/ws/projects/p1/issues/wi-intake',
    });
    expect((await t.findOpen('cjm-regression', '[cjm] activation'))?.ref).toBe('wi-open');
    expect(calls.find((c) => c.path.endsWith('/search/'))?.query.get('project_id')).toBe('p1');
    expect(calls.every((c) => c.method === 'GET')).toBe(true); // finding never writes
  });

  it('files into Intake with the producer labels, comments, never changes a state', async () => {
    calls.length = 0;
    route = ({ method, path, body }) => {
      if (path === `${p}/labels/` && method === 'GET') {
        return [200, { results: [{ id: 'l-1', name: 'cjm-regression' }] }];
      }
      if (path === `${p}/labels/`) return [201, { id: `l-${body.name}` }];
      if (path === `${p}/intake-issues/`) return [201, { id: 'in-1', issue: 'wi-9' }];
      if (path === `${p}/work-items/wi-9/comments/` && method === 'GET') {
        return [200, { results: [{ comment_stripped: 'Released in v1.0.0 (via #1).' }] }];
      }
      return [200, {}];
    };
    const t = plane();
    const item = await t.create('cjm-regression', '[cjm] signup', 'Fired <b>\nBreaches: 12%');
    expect(item.ref).toBe('wi-9');
    expect(posted('/intake-issues/')).toEqual([
      {
        issue: {
          name: '[cjm] signup',
          description_html: '<p>Fired &lt;b&gt;</p><p>Breaches: 12%</p>',
        },
      },
    ]);
    expect(posted('/work-items/wi-9/')).toEqual([{ labels: ['l-1'] }]);
    await t.create('support-bug', 'Upload fails', 'x'); // from-users, support, bug: all missing
    expect(posted('/labels/')).toEqual([
      { name: 'from-users' },
      { name: 'support' },
      { name: 'bug' },
    ]);
    await t.comment('wi-9', 'again');
    expect(posted('/work-items/wi-9/comments/')).toEqual([{ comment_html: '<p>again</p>' }]);
    expect(await t.comments('wi-9')).toEqual(['Released in v1.0.0 (via #1).']);
    expect(calls.some((c) => c.body && 'state' in c.body)).toBe(false);
  });

  it('finds the work items a PR names by identifier', async () => {
    calls.length = 0;
    route = ({ path }) => {
      if (path === `${p}/`) return [200, { id: 'p1', identifier: 'APP' }];
      if (path === '/api/v1/workspaces/ws/work-items/APP-12/') return [200, { id: 'wi-12' }];
      if (path === '/api/v1/workspaces/ws/work-items/APP-404/') return [404, { error: 'nope' }];
      return [500, {}];
    };
    const pr = {
      number: 5,
      title: 'fix: upload (APP-12)',
      body: 'Also APP-404, not UTF-8 or XAPP-1',
    };
    expect(await plane().referencedBy(pr)).toEqual(['wi-12']);
  });
});

describe('GitHub Issues tracker (optional)', () => {
  const github = () =>
    trackerFromEnv({
      TRACKER: 'github',
      GITHUB_TOKEN: 't',
      GITHUB_REPO: 'o/r',
      GITHUB_API_URL: base,
    })!;

  it('reads every page of open issues to find a duplicate (not just the first 100)', async () => {
    calls.length = 0;
    route = ({ path, query }) => {
      if (path !== '/repos/o/r/issues') return [404, {}];
      const page = Number(query.get('page') ?? 1);
      const issues = Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
        number: page * 1000 + i,
        title: page === 1 ? `other ${i}` : '[cjm] signup',
        html_url: `https://github.com/o/r/issues/${page * 1000 + i}`,
      }));
      const next =
        page === 1 ? { link: `<${base}/repos/o/r/issues?page=2>; rel="next"` } : undefined;
      return [200, issues, next];
    };
    const hit = await github().findOpen('cjm-regression', '[cjm] signup');
    expect(hit).toEqual({ ref: '2000', url: 'https://github.com/o/r/issues/2000' });
    expect(calls[0]!.query.get('labels')).toBe('cjm-regression');
    expect(calls[0]!.query.get('state')).toBe('open');
  });
});
