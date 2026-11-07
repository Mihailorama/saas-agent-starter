import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One vendor CLI run, non-interactive, explicit model, no tools, prompt on stdin, structured
 * output where the CLI has it (docs/llm-providers.md "CLI subscriptions"). Each run's HOME holds
 * the CLI's login, so no tool may read files or run commands: a prompt injection could otherwise
 * copy the subscription token into the answer. Flags checked against each CLI's docs and `--help`
 * on 2026-11-07, and the tool list each CLI sends checked against a local mock of the vendor API
 * (Codex 0.167.0, Gemini CLI 0.67.0, the Dockerfile's versions); a CLI release can change them,
 * so adapters stay small and tested against a fake binary (test/fake-cli.mjs).
 */
export type Message = { role: 'system' | 'user' | 'assistant'; content: string };
export type Result = {
  text: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
};
export type Kind = 'rate_limited' | 'failed' | 'timeout';
export class CliError extends Error {
  readonly kind: Kind;
  constructor(message: string, kind: Kind) {
    super(message);
    this.kind = kind;
  }
}

type Run = { args: string[]; stdin: string; env: Record<string, string> };
export type Adapter = {
  prepare(model: string, system: string, prompt: string, tmp: string): Promise<Run> | Run;
  parse(stdout: string): Result;
};

// Error texts of the CLIs and their APIs when a subscription is out of quota or throttled.
const RATE_LIMITED = /rate[ _-]?limit|usage limit|too many requests|\b429\b|quota|limit reached/i;
const kindOf = (text: string): Kind => (RATE_LIMITED.test(text) ? 'rate_limited' : 'failed');
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const sum = (...v: unknown[]) =>
  v.some((x) => typeof x === 'number') ? v.reduce<number>((s, x) => s + (num(x) ?? 0), 0) : null;
const json = (stdout: string): Record<string, unknown> => {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new CliError('CLI output is not JSON', kindOf(stdout));
  }
};

/** Claude Code: `claude -p --output-format json` (result, is_error, usage, modelUsage). */
const claude: Adapter = {
  prepare: (model, system, prompt) => ({
    args: [
      '-p',
      '--model',
      model,
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      ...(system ? ['--system-prompt', system] : []),
    ],
    stdin: prompt,
    env: {},
  }),
  parse(stdout) {
    const res = json(stdout);
    if (res.is_error) throw new CliError(String(res.result ?? 'claude failed'), kindOf(stdout));
    const u = (res.usage ?? {}) as Record<string, unknown>;
    const models = Object.keys((res.modelUsage ?? {}) as object);
    return {
      text: String(res.result ?? ''),
      model: models.length === 1 ? models[0]! : null,
      inputTokens: sum(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens),
      outputTokens: num(u.output_tokens),
    };
  },
};

type CodexEvent = {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: Record<string, unknown>;
  error?: { message?: string };
  message?: string;
};

/**
 * OpenAI Codex: `codex exec --json` JSONL events; no system prompt flag, so it leads the prompt.
 * Tools off via `codex exec --help` (`--disable <feature>` = `-c features.<name>=false`) and the
 * feature list of `codex features list`: no shell (`shell_tool`, `unified_exec`), no file or image
 * reads (`view_image`), no web search, no sub-agents (`multi_agent`, which also brings
 * `tool_search`), no goals; no user config, rules or MCP servers. Left by Codex itself (model
 * catalog, no switch): `apply_patch`, refused by the read-only sandbox with approvals `never`, and
 * `request_user_input`; neither reads files.
 */
const codex: Adapter = {
  prepare: (model, system, prompt) => ({
    args: [
      'exec',
      '--model',
      model,
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'web_search="disabled"',
      ...['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'goals'].flatMap((f) => [
        '--disable',
        f,
      ]),
      '-',
    ],
    stdin: system ? `<instructions>\n${system}\n</instructions>\n\n${prompt}` : prompt,
    env: {},
  }),
  parse(stdout) {
    let text = '';
    let usage: Record<string, unknown> = {};
    for (const line of stdout.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      const e = JSON.parse(line) as CodexEvent;
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') text = e.item.text ?? '';
      if (e.type === 'turn.completed') usage = e.usage ?? {};
      if (e.type === 'turn.failed' || e.type === 'error') {
        const msg = String(e.error?.message ?? e.message ?? 'codex failed');
        throw new CliError(msg, kindOf(msg));
      }
    }
    return {
      text,
      model: null,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
    };
  },
};

/**
 * Gemini CLI: `gemini -p --output-format json` (response, stats); system prompt from a file.
 * Tools off with a policy file that denies every tool (geminicli.com/docs/reference/policy-engine:
 * a global `deny` rule removes the tool from what the model is offered; `*` matches all, MCP
 * included). Without it, headless runs still offer read_file, grep_search, glob, web search.
 * `--skip-trust`: the run directory is a fresh scratch dir (the CLI refuses untrusted ones in
 * headless mode). GOOGLE_GENAI_USE_GCA: the subscription login (oauth_creds.json), not an API key.
 */
const DENY_ALL = '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n';
const gemini: Adapter = {
  async prepare(model, system, prompt, tmp) {
    const env: Record<string, string> = { GOOGLE_GENAI_USE_GCA: 'true' };
    if (system) {
      env.GEMINI_SYSTEM_MD = join(tmp, 'system.md');
      await writeFile(env.GEMINI_SYSTEM_MD, system, { mode: 0o600 });
    }
    const policy = join(tmp, 'no-tools.toml');
    await writeFile(policy, DENY_ALL, { mode: 0o600 });
    // -p is appended to stdin and forces non-interactive mode; the prompt itself goes on stdin.
    return {
      args: [
        '--model',
        model,
        '--output-format',
        'json',
        '--skip-trust',
        '--policy',
        policy,
        '-p',
        ' ',
      ],
      stdin: prompt,
      env,
    };
  },
  parse(stdout) {
    const res = json(stdout);
    const err = res.error as { message?: string } | undefined;
    if (err) throw new CliError(String(err.message ?? 'gemini failed'), kindOf(stdout));
    const models = (res.stats as { models?: Record<string, { tokens?: Record<string, unknown> }> })
      ?.models;
    const [[model, stats] = [null, undefined]] = Object.entries(models ?? {});
    return {
      text: String(res.response ?? ''),
      model,
      inputTokens: num(stats?.tokens?.prompt),
      outputTokens: num(stats?.tokens?.candidates),
    };
  },
};

/**
 * Any other CLI (Kimi Code, Grok Build, ...): an argv template from the config with `{model}`; the
 * prompt always goes on stdin (never argv: text starting with `--` would parse as an option, and a
 * large prompt hits E2BIG). Plain-text output, no usage. Whether it can run without tools is that
 * CLI's business: configure it tool-less in the template (docs/llm-providers.md).
 */
export const command = (argv: string[]): Adapter => {
  if (argv.some((a) => a.includes('{prompt}'))) {
    throw new Error('command: {prompt} is not supported, the prompt is sent on stdin');
  }
  return {
    prepare(model, system, prompt) {
      return {
        args: argv.slice(1).map((a) => a.replaceAll('{model}', model)),
        stdin: system ? `${system}\n\n${prompt}` : prompt,
        env: {},
      };
    },
    parse: (stdout) => ({
      text: stdout.trim(),
      model: null,
      inputTokens: null,
      outputTokens: null,
    }),
  };
};

export const adapters: Record<string, Adapter> = { claude, codex, gemini };

/** System messages joined; a single user turn as is, a conversation as labelled turns. */
export function render(messages: Message[]) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  const prompt =
    turns.length === 1 && turns[0]!.role === 'user'
      ? turns[0]!.content
      : turns.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
  return { system, prompt };
}

const MAX_OUTPUT = 10 * 1024 * 1024;

/**
 * Runs the CLI with exactly `env` (never the shim's own environment, so its token and other
 * subscriptions' secrets are not visible), in a scratch dir outside the subscription's HOME (so
 * the login is not in the CLI's workspace). Prompt and output are never logged.
 */
export async function runCli(opts: {
  bin: string;
  adapter: Adapter;
  model: string;
  messages: Message[];
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<Result> {
  const { system, prompt } = render(opts.messages);
  const tmp = await mkdtemp(join(tmpdir(), 'llm-cli-run-'));
  try {
    const run = await opts.adapter.prepare(opts.model, system, prompt, tmp);
    const { code, stdout, stderr, timedOut } = await exec(opts.bin, run.args, {
      cwd: tmp,
      env: { ...opts.env, ...run.env },
      stdin: run.stdin,
      timeoutMs: opts.timeoutMs,
    });
    if (timedOut) throw new CliError(`CLI timed out after ${opts.timeoutMs} ms`, 'timeout');
    if (code !== 0) {
      throw new CliError(`CLI exited with ${code}`, kindOf(`${stdout}\n${stderr}`));
    }
    return opts.adapter.parse(stdout);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function exec(
  bin: string,
  args: string[],
  o: { cwd: string; env: Record<string, string>; stdin: string; timeoutMs: number },
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve, reject) => {
      const child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, o.timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (d: string) => {
        if (stdout.length < MAX_OUTPUT) stdout += d;
      });
      child.stderr.setEncoding('utf8').on('data', (d: string) => {
        if (stderr.length < 65_536) stderr += d;
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new CliError(`cannot start CLI: ${(err as NodeJS.ErrnoException).code}`, 'failed'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
      child.stdin.on('error', () => {}); // a CLI that exits early closes its stdin
      child.stdin.end(o.stdin);
    },
  );
}
