import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from './app.ts';
import { ScoreDb } from './db.ts';
import { eventMessage, validateEvent } from './events.ts';
import { createNotifier, notifierFromEnv, silent } from './notifier.ts';

const PLAYER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** The chat line for a body, or the validation error. */
const line = (body: Record<string, unknown>) => {
  const checked = validateEvent({ player: PLAYER, ...body });
  return checked.ok ? eventMessage(checked.value) : `error: ${checked.error}`;
};

describe('event messages', () => {
  test('name the player, or the start of their id as a guest', () => {
    assert.equal(line({ type: 'start', mode: 'cut', name: 'ann' }), '🎮 ANN started a Cut game');
    assert.equal(line({ type: 'start', mode: 'cut' }), '🎮 guest a1b2c3 started a Cut game');
    // A name the leaderboard wouldn't take is dropped, not refused
    assert.equal(line({ type: 'start', mode: 'cut', name: '<b>x</b>' }), '🎮 guest a1b2c3 started a Cut game');
  });

  test('games started', () => {
    assert.equal(line({ type: 'start', mode: 'versus', name: 'ANN' }), '⚔️ ANN started a Versus game (two players, one device)');
    assert.equal(line({ type: 'start', mode: 'online', host: false, round: 2, name: 'ANN' }), '🌐 ANN started Online Versus round 2 as guest');
  });

  test('games finished, with the score', () => {
    assert.equal(
      line({ type: 'finish', mode: 'cut', score: 1234, lines: 12, level: 1, durationMs: 225_400, name: 'ANN' }),
      '🏁 ANN finished a Cut game: 1234 points, 12 lines, level 1, 3:45',
    );
    assert.equal(line({ type: 'finish', mode: 'versus', scores: [300, 900], name: 'ANN' }), "🏁 ANN's Versus game: Player 2 wins, 300 – 900");
    assert.equal(line({ type: 'finish', mode: 'versus', scores: [5, 5], name: 'ANN' }), "🏁 ANN's Versus game: draw, 5 – 5");
    assert.equal(line({ type: 'finish', mode: 'versus', scores: [300, 900], winner: 1, name: 'ANN' }), "🏁 ANN's Versus game: Player 1 wins, 300 – 900");
    assert.equal(
      line({ type: 'finish', mode: 'online', host: true, round: 1, you: 800, them: 200, name: 'ANN' }),
      '🏁 ANN won Online Versus round 1 as host: 800 – 200',
    );
    assert.equal(
      line({ type: 'finish', mode: 'online', host: false, round: 2, you: 800, them: 200, win: false, name: 'ANN' }),
      '🏁 ANN lost Online Versus round 2 as guest: 800 – 200',
    );
  });

  test('settings', () => {
    assert.equal(line({ type: 'theme', theme: 'retro', name: 'ANN' }), '🎨 ANN switched to the Retro theme');
    assert.equal(line({ type: 'sound', muted: true, name: 'ANN' }), '🔇 ANN muted the sound');
    assert.equal(line({ type: 'sound', muted: false, name: 'ANN' }), '🔊 ANN turned the sound on');
    assert.equal(line({ type: 'volume', sfx: 80, music: 0, name: 'ANN' }), '🎚 ANN set the volume: sound 80%, music 0%');
  });

  test('refuse anything else', () => {
    const cases: [string, unknown][] = [
      ['not an object', 'hi'],
      ['array', [1]],
      ['no player', { type: 'start', mode: 'cut' }],
      ['bad player', { type: 'start', mode: 'cut', player: 'nope' }],
      ['free text type', { type: 'say', text: 'hello', player: PLAYER }],
      ['unknown mode', { type: 'start', mode: 'stack', player: PLAYER }],
      ['online without round', { type: 'start', mode: 'online', host: true, player: PLAYER }],
      ['fractional score', { type: 'finish', mode: 'cut', score: 1.5, lines: 1, level: 0, durationMs: 1, player: PLAYER }],
      ['one versus score', { type: 'finish', mode: 'versus', scores: [1], player: PLAYER }],
      ['versus winner 3', { type: 'finish', mode: 'versus', scores: [1, 2], winner: 3, player: PLAYER }],
      ['unknown theme', { type: 'theme', theme: 'neon', player: PLAYER }],
      ['muted as a string', { type: 'sound', muted: 'yes', player: PLAYER }],
      ['volume over 100', { type: 'volume', sfx: 101, music: 0, player: PLAYER }],
    ];
    for (const [why, body] of cases) assert.equal(validateEvent(body).ok, false, why);
  });
});

describe('POST /api/events', () => {
  const db = new ScoreDb(':memory:');
  const sent: string[] = [];
  let base = '';
  let server: ReturnType<typeof createApp>;

  before(async () => {
    server = createApp({
      db,
      staticDir: null,
      addressHeader: 'x-forwarded-for',
      eventRateLimit: { max: 3, windowMs: 60_000 },
      notify: async (text) => void sent.push(text),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
    db.close();
  });

  const post = (body: unknown, ip = '10.0.0.1') =>
    fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify(body),
    });

  test('posts the message for a valid report', async () => {
    const r = await post({ type: 'start', mode: 'cut', name: 'ANN', player: PLAYER });
    assert.equal(r.status, 202);
    assert.deepEqual(sent, ['🎮 ANN started a Cut game']);
  });

  test('refuses a bad report and posts nothing', async () => {
    sent.length = 0;
    assert.equal((await post({ type: 'say', text: 'spam', player: PLAYER }, '10.0.0.2')).status, 400);
    assert.equal((await fetch(`${base}/api/events`)).status, 405);
    assert.deepEqual(sent, []);
  });

  test('is rate limited per IP', async () => {
    sent.length = 0;
    const ok = { type: 'sound', muted: true, player: PLAYER };
    for (let i = 0; i < 3; i++) assert.equal((await post(ok, '10.0.0.3')).status, 202);
    assert.equal((await post(ok, '10.0.0.3')).status, 429);
    assert.equal((await post(ok, '10.0.0.4')).status, 202);
    assert.equal(sent.length, 4);
  });
});

describe('notifier', () => {
  const got: { auth?: string; body: unknown }[] = [];
  let pigeon: Server;
  let url = '';

  before(async () => {
    pigeon = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        got.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(req.url === '/api/v1/messages' ? 200 : 404, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => pigeon.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(pigeon.address() as AddressInfo).port}`;
  });

  after(() => pigeon.close());

  test('posts plain text with the bearer token', async () => {
    await createNotifier({ url: `${url}/`, token: 'secret' })('hello');
    assert.deepEqual(got, [{ auth: 'Bearer secret', body: { text: 'hello', parseMode: 'none' } }]);
  });

  test('never throws when tg-pigeon is down', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      await createNotifier({ url: 'http://127.0.0.1:1', token: 'secret' })('lost');
    } finally {
      console.warn = warn;
    }
  });

  test('is off without url and token, and outside production', () => {
    assert.equal(createNotifier({ url: '', token: 'x' }), silent);
    assert.equal(notifierFromEnv({ TG_PIGEON_URL: url, NODE_ENV: 'production' }).notify, silent);
    assert.equal(notifierFromEnv({ TG_PIGEON_URL: url, TG_PIGEON_TOKEN: 'x' }).notify, silent);
    assert.equal(notifierFromEnv({ TG_PIGEON_URL: 'not a url', TG_PIGEON_TOKEN: 'x', NODE_ENV: 'production' }).notify, silent);
    assert.notEqual(notifierFromEnv({ TG_PIGEON_URL: url, TG_PIGEON_TOKEN: 'x', NODE_ENV: 'production' }).notify, silent);
  });
});
