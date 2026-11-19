// What the game reports to the events chat (POST /api/events), and the message each one becomes.
//
// The browser sends facts, never text: every message is written here from checked fields, so the
// endpoint can't be used to post anything else to the chat. The owner's own play is filtered out
// in the browser (src/events.ts), which knows the name it plays under.

import { normalizeName, PLAYER_ID } from './scores.ts';

export const THEMES = ['modern', 'retro'] as const;
export type Theme = (typeof THEMES)[number];

export type GameEvent =
  | { type: 'start'; mode: 'cut' | 'versus' }
  | { type: 'start'; mode: 'online'; host: boolean; round: number }
  | { type: 'finish'; mode: 'cut'; score: number; lines: number; level: number; durationMs: number }
  | { type: 'finish'; mode: 'versus'; scores: [number, number] }
  | { type: 'finish'; mode: 'online'; host: boolean; round: number; you: number; them: number }
  | { type: 'theme'; theme: Theme }
  | { type: 'sound'; muted: boolean }
  /** Volumes in percent */
  | { type: 'volume'; sfx: number; music: number };

/** An event with who it came from: the leaderboard name the browser remembers, and its random id. */
export interface Reported {
  event: GameEvent;
  name: string | null;
  player: string;
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const SCORE_MAX = 100_000_000;
const ROUND_MAX = 10_000;

function checkEvent(b: Record<string, unknown>): GameEvent | string {
  switch (b.type) {
    case 'start':
      if (b.mode === 'cut' || b.mode === 'versus') return { type: 'start', mode: b.mode };
      if (b.mode === 'online') {
        if (typeof b.host !== 'boolean' || !isInt(b.round, 1, ROUND_MAX)) return 'online start needs host and round';
        return { type: 'start', mode: 'online', host: b.host, round: b.round };
      }
      return 'mode must be cut, versus or online';
    case 'finish':
      if (b.mode === 'cut') {
        const { score, lines, level, durationMs } = b;
        if (!isInt(score, 0, SCORE_MAX) || !isInt(lines, 0, 100_000) || !isInt(level, 0, 10_000) || !isInt(durationMs, 0, 24 * 3600_000)) {
          return 'cut finish needs score, lines, level and durationMs';
        }
        return { type: 'finish', mode: 'cut', score, lines, level, durationMs };
      }
      if (b.mode === 'versus') {
        const s = b.scores;
        if (!Array.isArray(s) || s.length !== 2 || !s.every((v) => isInt(v, 0, SCORE_MAX))) return 'versus finish needs two scores';
        return { type: 'finish', mode: 'versus', scores: [s[0], s[1]] };
      }
      if (b.mode === 'online') {
        const { host, round, you, them } = b;
        if (typeof host !== 'boolean' || !isInt(round, 1, ROUND_MAX) || !isInt(you, 0, SCORE_MAX) || !isInt(them, 0, SCORE_MAX)) {
          return 'online finish needs host, round, you and them';
        }
        return { type: 'finish', mode: 'online', host, round, you, them };
      }
      return 'mode must be cut, versus or online';
    case 'theme':
      if (!THEMES.includes(b.theme as Theme)) return 'theme must be modern or retro';
      return { type: 'theme', theme: b.theme as Theme };
    case 'sound':
      if (typeof b.muted !== 'boolean') return 'muted must be true or false';
      return { type: 'sound', muted: b.muted };
    case 'volume':
      if (!isInt(b.sfx, 0, 100) || !isInt(b.music, 0, 100)) return 'sfx and music must be 0–100';
      return { type: 'volume', sfx: b.sfx, music: b.music };
    default:
      return 'unknown event type';
  }
}

/** A report from the game. A name that isn't a valid leaderboard name is dropped, not refused. */
export function validateEvent(body: unknown): Checked<Reported> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'expected a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.player !== 'string' || !PLAYER_ID.test(b.player)) return { ok: false, error: 'player must be 32 lowercase hex digits' };
  const event = checkEvent(b);
  if (typeof event === 'string') return { ok: false, error: event };
  return { ok: true, value: { event, name: normalizeName(b.name), player: b.player } };
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const THEME_NAMES: Record<Theme, string> = { modern: 'Modern', retro: 'Retro' };

/** The events-chat line for a report. Guests show as the start of their browser's random id. */
export function eventMessage({ event: e, name, player }: Reported): string {
  const who = name ?? `guest ${player.slice(0, 6)}`;
  switch (e.type) {
    case 'start':
      if (e.mode === 'online') return `🌐 ${who} started Online Versus round ${e.round} as ${e.host ? 'host' : 'guest'}`;
      return e.mode === 'cut' ? `🎮 ${who} started a Cut game` : `⚔️ ${who} started a Versus game (two players, one device)`;
    case 'finish':
      if (e.mode === 'cut') {
        return `🏁 ${who} finished a Cut game: ${e.score} points, ${e.lines} lines, level ${e.level}, ${duration(e.durationMs)}`;
      }
      if (e.mode === 'versus') {
        const [a, b] = e.scores;
        const outcome = a === b ? 'draw' : `Player ${a > b ? 1 : 2} wins`;
        return `🏁 ${who}'s Versus game: ${outcome}, ${a} – ${b}`;
      }
      return `🏁 ${who} ${e.you > e.them ? 'won' : e.you < e.them ? 'lost' : 'drew'} Online Versus round ${e.round} as ${e.host ? 'host' : 'guest'}: ${e.you} – ${e.them}`;
    case 'theme':
      return `🎨 ${who} switched to the ${THEME_NAMES[e.theme]} theme`;
    case 'sound':
      return e.muted ? `🔇 ${who} muted the sound` : `🔊 ${who} turned the sound on`;
    case 'volume':
      return `🎚 ${who} set the volume: sound ${e.sfx}%, music ${e.music}%`;
  }
}
