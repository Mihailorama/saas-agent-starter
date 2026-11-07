import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Adapter, adapters, CliError, command, type Message, runCli } from './cli.ts';
import { Busy, type Subscription, Vendor } from './pool.ts';

/**
 * llm-cli: vendor CLI subscriptions (Claude Code, Codex, Gemini CLI, any other via `command`)
 * behind an internal OpenAI-compatible endpoint, `POST /<cli>/v1/chat/completions`, so the
 * worker's AI gateway reaches them through LiteLLM like any other provider (docs/llm-providers.md).
 * Internal only: bearer token (LLM_CLI_TOKEN), never published on a host port in production.
 *
 * Config (LLM_CLI_CONFIG, JSON): per CLI its subscriptions; each names its secrets as files,
 * `env` (variable -> file whose content becomes the variable, e.g. CLAUDE_CODE_OAUTH_TOKEN) and
 * `files` (path under the subscription's private HOME -> file to copy there, e.g.
 * `.codex/auth.json`). Secrets are read from mounted files, never baked into the image, never
 * logged, and each CLI run sees only its own subscription's.
 */
type CliConfig = {
  bin?: string;
  command?: string[];
  subscriptions: {
    name: string;
    concurrency?: number;
    env?: Record<string, string>;
    files?: Record<string, string>;
  }[];
};
export type Config = {
  timeoutMs?: number;
  cooldownMs?: number;
  queue?: { max?: number; timeoutMs?: number };
  clis: Record<string, CliConfig>;
};
type Cli = { bin: string; adapter: Adapter; vendor: Vendor };

const log = (msg: string, fields: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), msg, ...fields })}\n`);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const MAX_BODY = 1024 * 1024;

async function subscription(
  cli: string,
  s: CliConfig['subscriptions'][number],
): Promise<Subscription> {
  const home = await mkdtemp(join(tmpdir(), `llm-cli-${cli}-`));
  await chmod(home, 0o700);
  for (const [rel, src] of Object.entries(s.files ?? {})) {
    const dest = join(home, rel);
    if (!dest.startsWith(`${home}/`)) throw new Error(`${s.name}: file ${rel} leaves HOME`);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await copyFile(src, dest);
    await chmod(dest, 0o600);
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    // Claude Code: no self-update, no non-essential traffic (code.claude.com/docs/en/env-vars).
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  for (const [name, file] of Object.entries(s.env ?? {})) {
    env[name] = (await readFile(file, 'utf8')).trim();
  }
  return { name: s.name, concurrency: s.concurrency ?? 1, env, home };
}

export async function load(config: Config): Promise<Map<string, Cli>> {
  const limits = {
    maxQueue: config.queue?.max ?? 100,
    queueTimeoutMs: config.queue?.timeoutMs ?? 120_000,
    cooldownMs: config.cooldownMs ?? 60_000,
  };
  const clis = new Map<string, Cli>();
  for (const [name, c] of Object.entries(config.clis)) {
    const adapter = c.command ? command(c.command) : adapters[name];
    if (!adapter) throw new Error(`cli ${name}: no adapter; set "command" for other CLIs`);
    const subs: Subscription[] = [];
    for (const s of c.subscriptions) {
      try {
        subs.push(await subscription(name, s));
      } catch (err) {
        // A login not mounted (yet): skip it, serve the others; never log the file's content.
        log('subscription skipped', {
          cli: name,
          subscription: s.name,
          error: (err as NodeJS.ErrnoException).code ?? 'error',
        });
      }
    }
    if (!subs.length) {
      log('cli not served: no usable subscription', { cli: name });
      continue;
    }
    clis.set(name, {
      bin: c.bin ?? c.command?.[0] ?? name,
      adapter,
      vendor: new Vendor(subs, limits),
    });
  }
  return clis;
}

function send(res: ServerResponse, status: number, body: unknown, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
const fail = (res: ServerResponse, status: number, type: string, message: string, h = {}) =>
  send(res, status, { error: { message, type } }, h);

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseRequest(raw: unknown): { model: string; messages: Message[] } | null {
  const r = raw as { model?: unknown; messages?: unknown };
  if (typeof r?.model !== 'string' || !MODEL.test(r.model) || !Array.isArray(r.messages)) {
    return null;
  }
  const messages = r.messages as { role?: unknown; content?: unknown }[];
  const ok = messages.every(
    (m) =>
      ['system', 'user', 'assistant'].includes(String(m?.role)) && typeof m.content === 'string',
  );
  return ok && messages.length ? { model: r.model, messages: messages as Message[] } : null;
}

export function createApp(clis: Map<string, Cli>, opts: { token: string; timeoutMs: number }) {
  const want = createHash('sha256').update(opts.token).digest();
  const authorized = (req: IncomingMessage) => {
    const got = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
    return timingSafeEqual(createHash('sha256').update(got).digest(), want);
  };

  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      return send(res, 200, { ok: true, clis: [...clis.keys()] });
    }
    const name = req.url?.match(/^\/([a-z0-9_-]+)\/v1\/chat\/completions$/)?.[1];
    const cli = name ? clis.get(name) : undefined;
    if (req.method !== 'POST' || !cli) return fail(res, 404, 'not_found', 'unknown route or CLI');
    if (!authorized(req)) return fail(res, 401, 'authentication_error', 'invalid token');
    const parsed = await body(req).then(parseRequest, () => null);
    if (!parsed) return fail(res, 400, 'invalid_request_error', 'expected model and messages');

    const id = `cli-${randomUUID()}`;
    const started = Date.now();
    try {
      let used = '';
      const result = await cli.vendor.run((sub) => {
        used = sub.name;
        return runCli({
          bin: cli.bin,
          adapter: cli.adapter,
          model: parsed.model,
          messages: parsed.messages,
          env: sub.env,
          cwd: sub.home,
          timeoutMs: opts.timeoutMs,
        });
      });
      log('cli call', { id, cli: name, subscription: used, ms: Date.now() - started });
      const usage =
        result.inputTokens !== null && result.outputTokens !== null
          ? {
              prompt_tokens: result.inputTokens,
              completion_tokens: result.outputTokens,
              total_tokens: result.inputTokens + result.outputTokens,
            }
          : undefined;
      return send(res, 200, {
        id,
        object: 'chat.completion',
        created: Math.floor(started / 1000),
        model: result.model ?? parsed.model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: result.text },
          },
        ],
        ...(usage && { usage }),
      });
    } catch (err) {
      // Error class and kind only: CLI output can echo the prompt.
      const kind = err instanceof Busy ? 'busy' : err instanceof CliError ? err.kind : 'error';
      log('cli call failed', { id, cli: name, kind, ms: Date.now() - started });
      if (err instanceof Busy) {
        return fail(res, 429, 'rate_limit_error', err.message, {
          'retry-after': String(err.retryAfterSeconds),
        });
      }
      if (err instanceof CliError && err.kind === 'timeout') {
        return fail(res, 504, 'timeout', 'CLI timed out');
      }
      return fail(res, 502, 'api_error', 'CLI failed');
    }
  });
}
