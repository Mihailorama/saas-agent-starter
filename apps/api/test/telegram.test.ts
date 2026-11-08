import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { pool } from '../src/db.ts';
import { env } from '../src/env.ts';
import { telegramKey } from '../src/routes/support.ts';
import { closeTemporal, temporal } from '../src/temporal.ts';
import { historyText } from './history.ts';

// Lite Telegram support (docs/support.md): the API checks the webhook secret and starts one
// TelegramSupportWorkflow per message, ids only; the relay is services/worker-py/tests/test_telegram.py.
const app = await buildApp();
const TOKEN = '123456:local-dev-token';
const GROUP = -1001234567890;
beforeAll(() => {
  Object.assign(env, {
    TELEGRAM_SUPPORT_BOT_TOKEN: TOKEN,
    TELEGRAM_SUPPORT_CHAT_ID: String(GROUP),
  });
  env.FLAGS_ON.push('telegram-support');
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
/** Decoded input and history of the message's workflow, then terminates it. */
async function started(chatId: number, messageId: number) {
  const handle = (await temporal()).workflow.getHandle(`telegram-support-${chatId}-${messageId}`);
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
    // The secret of another bot token does not pass either.
    expect((await post(fromUser(rnd(), 1), telegramKey('other', 'webhook'))).statusCode).toBe(401);
  });

  it('starts one workflow per user message, without its content', async () => {
    const user = rnd();
    expect((await post(fromUser(user, 3))).json()).toEqual({ action: 'started' });
    expect((await post(fromUser(user, 3))).json()).toEqual({ action: 'duplicate' }); // redelivery
    const { type, history } = await started(user, 3);
    expect(type).toBe('TelegramSupportWorkflow');
    expect(history).toContain(String(user)); // decoded: the check below can fail
    expect(history).not.toContain('4111');
  });

  it('passes the /start payload and a redacted /bug title, ignores the rest', async () => {
    const user = rnd();
    await post(fromUser(user, 1, '/start abc_DEF-123'));
    expect((await started(user, 1)).history).toContain('abc_DEF-123');

    const id = rnd();
    const bug = inTopic(id, '/bug@SupportBot Export fails for jane.doe@example.com');
    expect((await post(bug)).json()).toEqual({ action: 'started' });
    const { history } = await started(GROUP, id);
    expect(history).toContain('Export fails for [email]');
    expect(history).not.toContain('jane.doe');

    // The General topic, service messages, bots and other chats are not relayed.
    const general = inTopic(rnd(), 'hi', {
      message_thread_id: undefined,
      is_topic_message: undefined,
    });
    expect((await post(general)).json()).toEqual({ action: 'ignored' });
    const closed = inTopic(rnd(), '', { text: undefined, forum_topic_closed: {} });
    expect((await post(closed)).json()).toEqual({ action: 'ignored' });
    const bot = inTopic(rnd(), 'hi', { from: { id: 1, is_bot: true } });
    expect((await post(bot)).json()).toEqual({ action: 'ignored' });
    // An anonymous admin's reply comes from Telegram's stand-in bot, on behalf of the group.
    const anon = rnd();
    const admin = { from: { id: 1087968824, is_bot: true }, sender_chat: { id: GROUP } };
    expect((await post(inTopic(anon, 'answer', admin))).json()).toEqual({ action: 'started' });
    await started(GROUP, anon);
    const elsewhere = {
      update_id: 1,
      message: { ...fromUser(5, 1).message, chat: { id: -5, type: 'group' } },
    };
    expect((await post(elsewhere)).json()).toEqual({ action: 'ignored' });
  });

  it('rate-limits each Telegram user with 200 answers (no redelivery storm)', async () => {
    const user = rnd();
    const answers = [];
    for (let i = 1; i <= 21; i++) answers.push((await post(fromUser(user, i, 'x'))).json().action);
    expect(answers.filter((a) => a === 'started')).toHaveLength(20);
    expect(answers.at(-1)).toBe('limited');
    for (let i = 1; i <= 20; i++) await started(user, i);
  });
});

describe('GET /api/support/telegram', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/support/telegram' });
    expect(res.statusCode).toBe(401);
  });
});
