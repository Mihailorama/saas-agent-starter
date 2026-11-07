import { readFileSync } from 'node:fs';
import { PlaneClient } from '@makeplane/plane-node-sdk';
import { Octokit } from '@octokit/rest';

/**
 * The one tracker every producer files into (docs/support.md "Trackers"): the PostHog alert and
 * survey hook (routes/hooks.ts) and the release comments (scripts/released.mjs) here, the support
 * triage in its Python twin services/worker-py/worker/tracker.py. Plane is the default; GitHub
 * Issues is an optional alternative (TRACKER=github). Nothing here ever closes an item or moves
 * it to a completed state: that is for humans.
 */
export interface Tracker {
  name: 'plane' | 'github';
  /** An open item of the producer with exactly this title (Plane: Intake included). */
  findOpen(producer: string, title: string): Promise<Item | undefined>;
  create(producer: string, title: string, body: string): Promise<Item>;
  comment(ref: string, body: string): Promise<void>;
  /** Comment texts of an item (plain text). */
  comments(ref: string): Promise<string[]>;
  /** Items a merged PR refers to: Plane `PROJ-123` in its title or body, GitHub "Closes #12". */
  referencedBy(pr: { number: number; title: string; body?: string | null }): Promise<string[]>;
}
export type Item = { ref: string; url: string };

/** config/tracker.json: per producer the labels and, for Plane, the target state (none = Intake). */
type Producer = { labels: string[]; state?: string };
const producers: Record<string, Producer> = JSON.parse(
  readFileSync(new URL('../../../config/tracker.json', import.meta.url), 'utf8'),
).producers;
export const producer = (name: string) => {
  const p = producers[name];
  if (!p) throw new Error(`tracker producer ${name} is not in config/tracker.json`);
  return p;
};

export type TrackerEnv = {
  TRACKER?: string;
  PLANE_API_URL?: string;
  PLANE_APP_URL?: string;
  PLANE_WORKSPACE?: string;
  PLANE_PROJECT_ID?: string;
  PLANE_API_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  /** GitHub Enterprise Server; set by GitHub Actions. Default https://api.github.com */
  GITHUB_API_URL?: string;
};

/** TRACKER picks the adapter (plane by default); undefined = no credentials = dry run. */
export function trackerFromEnv(e: TrackerEnv): Tracker | undefined {
  const kind = e.TRACKER || 'plane';
  if (kind === 'plane') {
    const { PLANE_API_URL: api, PLANE_WORKSPACE: ws, PLANE_PROJECT_ID: pid, PLANE_API_TOKEN } = e;
    if (!api || !ws || !pid || !PLANE_API_TOKEN) return undefined;
    return plane(api, e.PLANE_APP_URL || api, ws, pid, PLANE_API_TOKEN);
  }
  if (kind === 'github') {
    if (!e.GITHUB_TOKEN || !e.GITHUB_REPO) return undefined;
    return github(e.GITHUB_REPO, e.GITHUB_TOKEN, e.GITHUB_API_URL || 'https://api.github.com');
  }
  throw new Error(`TRACKER must be plane or github, not ${kind}`);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
/** Intake statuses that are still waiting for a human: pending (-2) and snoozed (0). */
const WAITING = new Set([-2, 0]);
const FINISHED = new Set(['completed', 'cancelled']);

function plane(api: string, app: string, ws: string, pid: string, token: string): Tracker {
  const c = new PlaneClient({ baseUrl: api.replace(/\/$/, ''), apiKey: token });
  const url = (id: string) => `${app.replace(/\/$/, '')}/${ws}/projects/${pid}/issues/${id}`;
  /** Every page of a cursor-paginated list. */
  async function all<T>(
    list: (
      params: object,
    ) => Promise<{ results: T[]; next_cursor?: string; next_page_results?: boolean }>,
  ) {
    const out: T[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await list({ per_page: 100, ...(cursor && { cursor }) });
      out.push(...page.results);
      if (!page.next_page_results || !page.next_cursor) return out;
      cursor = page.next_cursor;
    }
  }
  async function labelIds(names: string[]) {
    if (!names.length) return [];
    const have = await all((p) => c.labels.list(ws, pid, p));
    return Promise.all(
      names.map(
        async (n) =>
          have.find((l) => l.name === n)?.id ?? (await c.labels.create(ws, pid, { name: n })).id,
      ),
    );
  }
  return {
    name: 'plane',
    async findOpen(_producer, title) {
      // Search skips items still in Intake (triage state), so those come from the Intake list.
      const intake = await all((p) => c.intake.list(ws, pid, p));
      const waiting = intake.find(
        (i) => WAITING.has(Number(i.status)) && i.issue_detail?.name === title && i.issue,
      );
      if (waiting) return { ref: waiting.issue!, url: url(waiting.issue!) };
      // The SDK sends the project as `project`; the server reads `project_id` (plane-node-sdk 0.3.1).
      const found = await c.workItems.search(ws, title, pid, { limit: 20, project_id: pid });
      for (const hit of found.issues.filter((i) => i.name === title)) {
        const item = (await c.workItems.retrieve(ws, pid, hit.id, ['state'])) as {
          state?: { group?: string };
        };
        if (!FINISHED.has(item.state?.group ?? '')) return { ref: hit.id, url: url(hit.id) };
      }
      return undefined;
    },
    async create(name, title, body) {
      const p = producer(name);
      const labels = await labelIds(p.labels);
      let id: string;
      if (p.state) {
        const state = (await all((q) => c.states.list(ws, pid, q))).find((s) => s.name === p.state);
        if (!state) throw new Error(`Plane state ${p.state} not found (config/tracker.json)`);
        const description_html = html(body);
        id = (
          await c.workItems.create(ws, pid, {
            name: title,
            description_html,
            state: state.id,
            labels,
          })
        ).id;
      } else {
        const res = await c.intake.create(ws, pid, {
          issue: { name: title, description_html: html(body) },
        });
        id = String(res.issue);
        // Intake takes no labels on create; the work item behind it does.
        if (labels.length) await c.workItems.update(ws, pid, id, { labels });
      }
      return { ref: id, url: url(id) };
    },
    async comment(ref, body) {
      await c.workItems.comments.create(ws, pid, ref, { comment_html: html(body) });
    },
    async comments(ref) {
      const list = await all((p) => c.workItems.comments.list(ws, pid, ref, p));
      return list.map((x) => String(x.comment_stripped ?? ''));
    },
    async referencedBy(pr) {
      const { identifier } = await c.projects.retrieve(ws, pid);
      const keys = new Set(
        `${pr.title}\n${pr.body ?? ''}`.match(new RegExp(`\\b${identifier}-\\d+\\b`, 'g')),
      );
      const ids: string[] = [];
      for (const key of keys) {
        try {
          ids.push((await c.workItems.retrieveByIdentifier(ws, key)).id);
        } catch (err) {
          if ((err as { statusCode?: number }).statusCode !== 404) throw err; // a typo in a PR
        }
      }
      return ids;
    },
  };
}

function github(fullName: string, token: string, baseUrl: string): Tracker {
  const octokit = new Octokit({ auth: token, baseUrl });
  const [owner, repo] = fullName.split('/') as [string, string];
  return {
    name: 'github',
    async findOpen(name, title) {
      const labels = producer(name).labels.join(',');
      // Every page, stopping at the first match (the old first-100-only check missed older ones).
      const [hit] = await octokit.paginate(
        octokit.rest.issues.listForRepo,
        { owner, repo, state: 'open', labels, per_page: 100 },
        (res, done) => {
          const found = res.data.filter((i) => i.title === title && !i.pull_request);
          if (found.length) done();
          return found;
        },
      );
      return hit && { ref: String(hit.number), url: hit.html_url };
    },
    async create(name, title, body) {
      const { labels } = producer(name);
      const { data } = await octokit.rest.issues.create({ owner, repo, title, body, labels });
      return { ref: String(data.number), url: data.html_url };
    },
    async comment(ref, body) {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: Number(ref), body });
    },
    async comments(ref) {
      const list = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: Number(ref),
        per_page: 100,
      });
      return list.map((x) => x.body ?? '');
    },
    async referencedBy(pr) {
      const res = await octokit.graphql<{
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: { number: number; repository: { nameWithOwner: string } }[];
            };
          };
        };
      }>(
        `query($owner: String!, $name: String!, $pr: Int!) {
          repository(owner: $owner, name: $name) { pullRequest(number: $pr) {
            closingIssuesReferences(first: 50) { nodes { number repository { nameWithOwner } } } } } }`,
        { owner, name: repo, pr: pr.number },
      );
      return res.repository.pullRequest.closingIssuesReferences.nodes
        .filter((i) => i.repository.nameWithOwner === fullName)
        .map((i) => String(i.number));
    },
  };
}

/** The GitHub client, for scripts that read pull requests (scripts/released.mjs). */
export { Octokit };
