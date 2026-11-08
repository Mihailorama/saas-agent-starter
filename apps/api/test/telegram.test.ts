import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { pool } from '../src/db.ts';
import { env } from '../src/env.ts';
import { telegramKey, telegramStartToken } from '../src/routes/support.ts';
import { ensureBucket, getJson } from '../src/s3.ts';
import { closeTemporal, temporal } from '../src/temporal.ts';
import { historyText } from './history.ts';

// Lite Telegram support (docs/support.md): the API checks the webhook secret, verifies /start
// links, stores /bug titles in S3 and signals one TelegramChatWorkflow per chat or topic, ids
// only; the relay is services/worker-py/tests/test_telegram.py.
const app = await buildApp();
const TOKEN = '123456:local-dev-token';
const GROUP = -1001234567890;
beforeAll(async () => {
  Object.assign(env, {
    TELEGRAM_SUPPORT_BOT_TOKEN: TOKEN,
    TELEGRAM_SUPPORT_CHAT_ID: String(GROUP),
  });
  env.FLAGS_ON.push('telegram-support');
  await ensureBucket();
});
afterAll(async () => {
  Object.assign(env, {
    TELEGRAM_SUPPORT_BOT_TOKEN: undefined,
    TELEGRAM_SUPPORT_CHAT_ID: undefined,
  });
  env.FLAGS_ON.splice(env.FLAGS_ON.indexOf('telegram-support'), 1);
  await app.close();
  await closeTemporal();
  await pool.end();
});

const rnd = () => Math.floor(Math.random() * 1e9);
const post = (update: object, secret = telegramKey(TOKEN, 'webhook')) =>
  app.inject({
    method: 'POST',
    url: '/api/hooks/telegram',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    payload: JSON.stringify(update),
  });
const fromUser = (user: number, messageId: number, text = 'my card 4111 1111 1111 1111') => ({
  update_id: rnd(),
  message: {
    message_id: messageId,
    chat: { id: user, type: 'private' },
    from: { id: user, is_bot: false, language_code: 'ru' },
    text,
  },
});
const inTopic = (messageId: number, text: string, extra: object = {}) => ({
  update_id: rnd(),
  message: {
    message_id: messageId,
    message_thread_id: 7,
    is_topic_message: true,
    chat: { id: GROUP, type: 'supergroup' },
    from: { id: 555, is_bot: false },
    text,
    ...extra,
  },
});
/** Type and decoded history of the chat's workflow, then terminates it. */
async function chat(chatId: number, threadId = 0) {
  const handle = (await temporal()).workflow.getHandle(`telegram-chat-${chatId}-${threadId}`);
  const run = await handle.describe();
  const history = await historyText(handle);
  await handle.terminate('test cleanup');
  return { type: run.type, history };
}

describe('POST /api/hooks/telegram', () => {
  it('answers 404 while the flag is off or the bot is not configured', async () => {
    env.FLAGS_ON.splice(env.FLAGS_ON.indexOf('telegram-support'), 1);
    try {
      expect((await post(fromUser(rnd(), 1))).statusCode).toBe(404);
    } finally {
      env.FLAGS_ON.push('telegram-support');
    }
    env.TELEGRAM_SUPPORT_CHAT_ID = undefined;
    try {
      expect((await post(fromUser(rnd(), 1))).statusCode).toBe(404);
    } finally {
      env.TELEGRAM_SUPPORT_CHAT_ID = String(GROUP);
    }
  });

  it('checks the secret token header', async () => {
    expect((await post(fromUser(rnd(), 1), 'wrong')).statusCode).toBe(401);
    expect((await post(fromUser(rnd(), 1), '')).statusCode).toBe(401);
    expect((await post(fromUser(rnd(), 1), telegramKey('other', 'webhook'))).statusCode).toBe(401);
  });

  it('signals the chat workflow with ids only', async () => {
    const user = rnd();
    expect((await post(fromUser(user, 3))).json()).toEqual({ action: 'queued' });
    expect((await post(fromUser(user, 4))).json()).toEqual({ action: 'queued' }); // same workflow
    const { type, history } = await chat(user);
    expect(type).toBe('TelegramChatWorkflow');
    expect(history).toContain(String(user)); // decoded: the check below can fail
    expect(history).not.toContain('4111');
  });

  it('verifies /start links: only the user id reaches Temporal, each link works once', async () => {
    const appUser = `u${rnd()}`;
    const link = telegramStartToken(TOKEN, appUser);
    const user = rnd();
    await post(fromUser(user, 1, `/start ${link}`));
    await post(fromUser(user, 2, `/start ${link}`)); // replayed
    const expired = telegramStartToken(TOKEN, appUser, Date.now() - 11 * 60_000);
    await post(fromUser(user, 3, `/start ${expired}`));
    const forged = telegramStartToken('other:token', appUser);
    await post(fromUser(user, 4, `/start ${forged}`));
    const { history } = await chat(user);
    expect(history).not.toContain(link);
    expect(history.match(new RegExp(`"userId":"${appUser}"`, 'g'))).toHaveLength(1);
    expect(history.match(/"linkFailed":true/g)).toHaveLength(3);
  });

  it('stores a redacted /bug title in S3 and passes the key', async () => {
    const id = rnd();
    const bug = inTopic(id, '/bug@SupportBot Export fails for jane.doe@example.com');
    expect((await post(bug)).json()).toEqual({ action: 'queued' });
    const { history } = await chat(GROUP, 7);
    const key = `tracker-inbox/telegram-${GROUP}-${id}.json`;
    expect(history).toContain(key);
    expect(history).not.toContain('Export fails');
    expect(await getJson(env.S3_BUCKET, key)).toEqual({ title: 'Export fails for [email]' });
  });

  it('ignores the General topic, service messages, bots and other chats', async () => {
    const general = inTopic(rnd(), 'hi', {
      message_thread_id: undefined,
      is_topic_message: undefined,
    });
    expect((await post(general)).json()).toEqual({ action: 'ignored' });
    const closed = inTopic(rnd(), '', { text: undefined, forum_topic_closed: {} });
    expect((await post(closed)).json()).toEqual({ action: 'ignored' });
    const bot = inTopic(rnd(), 'hi', { from: { id: 1, is_bot: true } });
    expect((await post(bot)).json()).toEqual({ action: 'ignored' });
    const elsewhere = {
      update_id: 1,
      message: { ...fromUser(5, 1).message, chat: { id: -5, type: 'group' } },
    };
    expect((await post(elsewhere)).json()).toEqual({ action: 'ignored' });
  });

  it('rate-limits each Telegram user with 200 answers (no redelivery storm)', async () => {
    const user = rnd();
    const answers = [];
    for (let i = 1; i <= 6; i++) answers.push((await post(fromUser(user, i, 'x'))).json().action);
    expect(answers).toEqual(['queued', 'queued', 'queued', 'queued', 'queued', 'limited']);
    await chat(user);
  });
});

describe('GET /api/support/telegram', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/support/telegram' });
    expect(res.statusCode).toBe(401);
  });
});
