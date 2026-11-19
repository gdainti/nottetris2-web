// Online Versus rooms. One player creates a room and gets a short code; the other joins with it.
// The server only pairs the two and passes messages between them: each browser runs its own field
// and streams what it looks like to the other, so nothing here knows about the game's physics.
//
// Client -> server (JSON text messages)
//   { t: 'create', player? }      first message: open a room (player: the browser's random id)
//   { t: 'join', code, player? }  first message: join a room
//   { t: 'state', ... }           passed on to the other player as is
//   { t: 'over', score }          this player topped out with this score
//   { t: 'rematch' }              after a result: play again
// Server -> client
//   { t: 'room', code }           the room is open, waiting for the other player
//   { t: 'start', seed, round }   both are in: start a round with this piece seed
//   { t: 'state', ... }           the other player's field
//   { t: 'result', you, them }    both have topped out: the two final scores
//   { t: 'rematch' }              the other player wants a rematch
//   { t: 'left' }                 the other player left; the room is gone
//   { t: 'error', error }         'not-found' | 'full' | 'busy' | 'limit', then the server hangs up

import { randomBytes, randomInt } from 'node:crypto';
import type { MatchRecord } from './db.ts';
import { PLAYER_ID } from './scores.ts';
import { CLOSE, type WsConnection } from './ws.ts';

/** No I, L, O, 0 or 1, which are easy to mix up when a code is read out or typed. */
export const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export interface MatchOptions {
  /** Rooms open at once; past this, creating one is refused as 'busy'. */
  maxRooms?: number;
  /** A room nobody joins is closed after this long. */
  waitMs?: number;
  /** A new connection must create or join within this long. */
  helloMs?: number;
  /** Messages one connection may send per second (the game sends 20). */
  maxRate?: number;
  /** Called when a round ends, finished or left early, to log it (server/db.ts) */
  onRound?: (r: MatchRecord) => void;
  /** Clock for round durations, unix ms */
  now?: () => number;
}

type MatchError = 'not-found' | 'full' | 'busy' | 'limit';

interface Player {
  conn: WsConnection;
  /** The browser's random player id, if it sent one */
  id: string | null;
  /** Final score of this round, once topped out */
  score: number | null;
  rematch: boolean;
}

interface Room {
  code: string;
  /** Unique for the match log, where the code (reused later) can't tell rooms apart */
  id: string;
  players: Player[];
  round: number;
  waitTimer: NodeJS.Timeout | null;
  /** When the current round started (unix ms), and whether it has been logged yet */
  startedAt: number;
  logged: boolean;
}

/** Normalises a typed code: upper case, without spaces or dashes. Null when it can't be one. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!CODE_CHARS.includes(c)) return null;
  return code;
}

export class Matches {
  private rooms = new Map<string, Room>();
  private conns = new Set<WsConnection>();
  private maxRooms: number;
  private waitMs: number;
  private helloMs: number;
  private maxRate: number;
  private onRound: (r: MatchRecord) => void;
  private now: () => number;
  /** Set by closeAll, so rounds cut short by a restart aren't logged as a player leaving */
  private closing = false;

  constructor(opts: MatchOptions = {}) {
    this.maxRooms = opts.maxRooms ?? 1000;
    this.waitMs = opts.waitMs ?? 30 * 60_000;
    this.helloMs = opts.helloMs ?? 10_000;
    this.maxRate = opts.maxRate ?? 100;
    this.onRound = opts.onRound ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** Rooms open right now */
  get size(): number {
    return this.rooms.size;
  }

  /**
   * Takes a new connection. `allow` is asked once, when it creates or joins a room, and says whether
   * its address is still within the limit (which keeps codes from being guessed by brute force).
   */
  add(conn: WsConnection, allow: () => boolean) {
    this.conns.add(conn);
    let room: Room | null = null;
    let me: Player | null = null;
    const hello = setTimeout(() => {
      if (!room) conn.close(CLOSE.policy, 'create or join');
    }, this.helloMs);
    hello.unref();

    let second = 0;
    let count = 0;

    const refuse = (error: MatchError) => {
      conn.send(JSON.stringify({ t: 'error', error }));
      conn.close(CLOSE.normal);
    };

    conn.onMessage = (text) => {
      const s = Math.floor(Date.now() / 1000);
      if (s !== second) {
        second = s;
        count = 0;
      }
      if (++count > this.maxRate) return conn.close(CLOSE.policy, 'too many messages');

      let msg: { t?: unknown; [k: string]: unknown };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return conn.close(CLOSE.protocol, 'bad message');
      }
      if (!msg || typeof msg !== 'object') return conn.close(CLOSE.protocol, 'bad message');

      if (!room) {
        if (msg.t !== 'create' && msg.t !== 'join') return conn.close(CLOSE.protocol, 'create or join first');
        if (!allow()) return refuse('limit');
        const id = typeof msg.player === 'string' && PLAYER_ID.test(msg.player) ? msg.player : null;
        if (msg.t === 'create') {
          if (this.rooms.size >= this.maxRooms) return refuse('busy');
          me = { conn, id, score: null, rematch: false };
          room = this.open(me);
          conn.send(JSON.stringify({ t: 'room', code: room.code }));
        } else {
          const code = normalizeCode(msg.code);
          const found = code ? this.rooms.get(code) : undefined;
          if (!found) return refuse('not-found');
          if (found.players.length >= 2) return refuse('full');
          me = { conn, id, score: null, rematch: false };
          room = found;
          room.players.push(me);
          if (room.waitTimer) clearTimeout(room.waitTimer);
          room.waitTimer = null;
          this.start(room);
        }
        return;
      }

      const other = room.players.find((p) => p !== me);
      switch (msg.t) {
        case 'state':
          other?.conn.send(text);
          break;
        case 'over': {
          const score = msg.score;
          if (!Number.isSafeInteger(score) || (score as number) < 0 || me!.score !== null || !other) break;
          me!.score = score as number;
          if (other.score !== null) {
            this.log(room, 'finished');
            for (const p of room.players) {
              const them = room.players.find((q) => q !== p)!;
              p.conn.send(JSON.stringify({ t: 'result', you: p.score, them: them.score }));
            }
          }
          break;
        }
        case 'rematch':
          // Only once both have finished the round
          if (!other || room.players.some((p) => p.score === null) || me!.rematch) break;
          me!.rematch = true;
          if (other.rematch) {
            room.round++;
            this.start(room);
          } else other.conn.send(JSON.stringify({ t: 'rematch' }));
          break;
        default:
          break;
      }
    };

    conn.onClose = () => {
      clearTimeout(hello);
      this.conns.delete(conn);
      if (room) this.leave(room, me!);
    };
  }

  /** Ends every connection, e.g. when the server shuts down. */
  closeAll() {
    this.closing = true;
    for (const conn of [...this.conns]) conn.close(CLOSE.goingAway, 'server restarting');
  }

  private open(host: Player): Room {
    let code = '';
    do {
      code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    } while (this.rooms.has(code));
    const room: Room = { code, id: randomBytes(6).toString('hex'), players: [host], round: 1, waitTimer: null, startedAt: 0, logged: false };
    room.waitTimer = setTimeout(() => host.conn.close(CLOSE.normal, 'nobody joined'), this.waitMs);
    room.waitTimer.unref();
    this.rooms.set(code, room);
    return room;
  }

  private start(room: Room) {
    room.startedAt = this.now();
    room.logged = false;
    const seed = randomInt(2 ** 31);
    for (const p of room.players) {
      p.score = null;
      p.rematch = false;
      p.conn.send(JSON.stringify({ t: 'start', seed, round: room.round }));
    }
  }

  /** Reports the current round to the match log, once. A failure to log never ends the game. */
  private log(room: Room, ended: MatchRecord['ended']) {
    if (room.logged || room.startedAt === 0) return;
    room.logged = true;
    const [host, guest] = room.players;
    try {
      this.onRound({
        room: room.id,
        round: room.round,
        host: host?.id ?? null,
        guest: guest?.id ?? null,
        hostScore: host?.score ?? null,
        guestScore: guest?.score ?? null,
        ended,
        durationMs: Math.max(0, this.now() - room.startedAt),
      });
    } catch (e) {
      console.error('[match] could not log a round', e);
    }
  }

  /**
   * A player is gone: the room closes, and the other player is told and let go. A round still being
   * played is logged as left by them.
   */
  private leave(room: Room, gone: Player) {
    if (this.rooms.get(room.code) !== room) return;
    this.log(room, this.closing ? 'restart' : room.players[0] === gone ? 'host-left' : 'guest-left');
    this.rooms.delete(room.code);
    if (room.waitTimer) clearTimeout(room.waitTimer);
    for (const p of room.players) {
      if (p === gone || !p.conn.open) continue;
      p.conn.send(JSON.stringify({ t: 'left' }));
      p.conn.close(CLOSE.normal);
    }
  }
}
