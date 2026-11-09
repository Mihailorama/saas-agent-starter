import { readFile } from 'node:fs/promises';
import { type Config, createApp, load } from './server.ts';

const token = process.env.LLM_CLI_TOKEN ?? '';
if (token.length < 32) throw new Error('LLM_CLI_TOKEN must be set (32+ characters)');
const config = JSON.parse(
  await readFile(process.env.LLM_CLI_CONFIG ?? '/etc/llm-cli/config.json', 'utf8'),
) as Config;
const clis = await load(config);
const server = createApp(clis, { token, timeoutMs: config.timeoutMs ?? 300_000 });
const port = Number(process.env.PORT ?? 8080);
server.listen(port, () =>
  process.stdout.write(
    `${JSON.stringify({ msg: 'llm-cli listening', port, clis: [...clis.keys()] })}\n`,
  ),
);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close());
