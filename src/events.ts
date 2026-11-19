// Reports what players do to the server, which posts it to the events chat through tg-pigeon
// (server/events.ts writes the messages). Fire-and-forget: a report that fails is simply lost.

import { normalizeName } from './api';
import { loadSettings, playerId, type ThemeName } from './storage';

/** The owner's leaderboard name: a browser that plays under it reports nothing. */
const OWNER = 'DEN';

export type GameEvent =
  | { type: 'start'; mode: 'cut' | 'versus' }
  | { type: 'start'; mode: 'online'; host: boolean; round: number }
  | { type: 'finish'; mode: 'cut'; score: number; lines: number; level: number; durationMs: number }
  /** winner: player 1 or 2, 0 for a draw */
  | { type: 'finish'; mode: 'versus'; scores: [number, number]; winner: 0 | 1 | 2 }
  | { type: 'finish'; mode: 'online'; host: boolean; round: number; you: number; them: number; win?: boolean }
  | { type: 'theme'; theme: ThemeName }
  | { type: 'sound'; muted: boolean }
  /** Volumes in percent */
  | { type: 'volume'; sfx: number; music: number };

export function report(event: GameEvent) {
  // The name as stored, not the page's copy of the settings, so it is always the current one.
  const name = normalizeName(loadSettings().name);
  if (name === OWNER) return;
  void fetch('api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...event, ...(name ? { name } : {}), player: playerId() }),
    // Still sent when the page closes right after (a game over, then the tab shut)
    keepalive: true,
  }).catch(() => {});
}

/** How long a setting has to stay put before its change is reported */
const SETTLE_MS = 2000;
const pending = new Map<string, { from: string; timer: number }>();

/**
 * Reports a setting's change once it has settled, so dragging a slider or flicking a choice back and
 * forth sends one message, or none when it ends up where it started.
 */
export function reportSetting(key: GameEvent['type'], from: string, to: string, event: GameEvent) {
  const p = pending.get(key);
  if (p) window.clearTimeout(p.timer);
  const start = p ? p.from : from;
  const timer = window.setTimeout(() => {
    pending.delete(key);
    if (to !== start) report(event);
  }, SETTLE_MS);
  pending.set(key, { from: start, timer });
}
