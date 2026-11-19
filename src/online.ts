// The two halves of showing a field to the other player of an online game. FieldEncoder turns the
// local Field into small state messages (only what changed since the last one); RemoteField rebuilds
// the other player's field from them and draws it a little in the past, moving smoothly between
// messages. Neither side runs the other's physics: each browser only simulates its own field.

import * as C from './config';
import type { Field, FieldState, Incoming, PieceView } from './field';
import type { Poly } from './geometry';
import { GARBAGE } from './pieces';
import type { DrawableField } from './render';

/** Play time between state messages: 20 a second. */
export const SEND_INTERVAL = 3 * C.STEP;
/** How far behind the newest message the other field is drawn, so there is always one to move towards. */
const DELAY = 0.12;

const PX = C.PX_PER_M;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export interface StateMsg {
  t: 'state';
  /** The sender's play time in seconds */
  tm: number;
  st: FieldState;
  /** Score and next piece */
  s: number;
  n: number;
  /** New bodies: id, piece kind, and each polygon as flat x,y pairs in body-local pixels */
  add?: [number, number, number[][]][];
  /** Bodies that are gone */
  del?: number[];
  /** Bodies that moved: id, x, y (pixels), angle */
  p?: [number, number, number, number][];
  /** Row fill meter, 0–100 per row, when it changed */
  r?: number[];
  /** Rows a cut has just taken out */
  c?: number[];
  /** Versus attacks waiting to drop, when that changed: column, armed (1) or not (0), for each */
  w?: number[];
}

export class FieldEncoder {
  private sent = new Map<number, [number, number, number]>();
  private rows = '';
  private cuts = 0;
  private waiting = '';

  encode(f: Field, time: number): StateMsg {
    const msg: StateMsg = { t: 'state', tm: r3(time), st: f.state, s: f.score, n: f.nextKind };

    const add: NonNullable<StateMsg['add']> = [];
    const moved: NonNullable<StateMsg['p']> = [];
    const seen = new Set<number>();
    for (const piece of f.active ? [...f.pieces, f.active] : f.pieces) {
      seen.add(piece.id);
      const pos = piece.body.getPosition();
      const pose: [number, number, number] = [r1(pos.x * PX), r1(pos.y * PX), r3(piece.body.getAngle())];
      const last = this.sent.get(piece.id);
      if (!last) add.push([piece.id, piece.kind, piece.shapes.map((s) => s.flatMap((pt) => [r1(pt.x), r1(pt.y)]))]);
      if (!last || last[0] !== pose[0] || last[1] !== pose[1] || last[2] !== pose[2]) {
        moved.push([piece.id, ...pose]);
        this.sent.set(piece.id, pose);
      }
    }
    const del: number[] = [];
    for (const id of this.sent.keys()) {
      if (!seen.has(id)) {
        del.push(id);
        this.sent.delete(id);
      }
    }
    if (add.length) msg.add = add;
    if (del.length) msg.del = del;
    if (moved.length) msg.p = moved;

    const rows = Array.from({ length: C.ROWS }, (_, r) => Math.round(f.rowFullness(r) * 100));
    const key = rows.join();
    if (key !== this.rows) {
      this.rows = key;
      msg.r = rows;
    }
    const waiting = f.incoming.flatMap((b) => [b.slot, b.armed ? 1 : 0]);
    const wkey = waiting.join();
    if (wkey !== this.waiting) {
      this.waiting = wkey;
      msg.w = waiting;
    }
    if (f.cuts !== this.cuts) {
      this.cuts = f.cuts;
      msg.c = f.removedRows.flatMap((on, r) => (on ? [r] : []));
    }
    return msg;
  }
}

interface Pose {
  x: number;
  y: number;
  a: number;
}

interface Frame {
  tm: number;
  st: FieldState;
  score: number;
  bodies: Map<number, Pose>;
  /** Rows cut at this moment */
  cut: number[] | null;
}

const STATES: FieldState[] = ['idle', 'playing', 'cutting', 'toppedOut', 'failing', 'over'];
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export class RemoteField implements DrawableField {
  /** The same well as Field's */
  readonly left = 56;
  readonly width = 328;
  snapshot: PieceView[] = [];
  removedRows: boolean[] = new Array(C.ROWS).fill(false);
  incoming: Incoming[] = [];
  nextKind = 0;
  nextSpin = 0;

  private pieces = new Map<number, { kind: number; shapes: Poly[] }>();
  /** Received states, oldest first; frames[0] is the one on show (at or before the clock) */
  private frames: Frame[] = [];
  private fullness: number[] = new Array(C.ROWS).fill(0);
  /** The sender's time being drawn */
  private clock = 0;
  private started = false;
  private cutStart = -1;

  /** Whether any state has arrived yet */
  get live(): boolean {
    return this.frames.length > 0;
  }

  get state(): FieldState {
    return this.frames[0]?.st ?? 'idle';
  }

  get score(): number {
    return this.frames[0]?.score ?? 0;
  }

  /** Takes one state message. It comes from the other browser, so anything malformed is skipped. */
  receive(m: StateMsg) {
    if (!num(m.tm) || !STATES.includes(m.st) || !num(m.s) || !num(m.n)) return;
    const prev = this.frames.at(-1);
    const bodies = new Map(prev?.bodies);
    if (Array.isArray(m.del)) for (const id of m.del) bodies.delete(id);
    if (Array.isArray(m.add)) {
      for (const entry of m.add) {
        const [id, kind, flat] = Array.isArray(entry) ? entry : [];
        if (!num(id) || !num(kind) || kind < 0 || kind > GARBAGE || !Array.isArray(flat)) continue;
        const shapes: Poly[] = [];
        for (const f of flat) {
          if (!Array.isArray(f) || f.length < 6 || !f.every(num)) continue;
          const poly: Poly = [];
          for (let i = 0; i + 1 < f.length; i += 2) poly.push({ x: f[i], y: f[i + 1] });
          shapes.push(poly);
        }
        this.pieces.set(id, { kind, shapes });
      }
    }
    if (Array.isArray(m.p)) {
      for (const entry of m.p) {
        if (Array.isArray(entry) && entry.length === 4 && entry.every(num)) bodies.set(entry[0], { x: entry[1], y: entry[2], a: entry[3] });
      }
    }
    if (Array.isArray(m.r) && m.r.length === C.ROWS && m.r.every(num)) this.fullness = m.r.map((v) => Math.min(1, Math.max(0, v / 100)));
    if (m.n >= 0 && m.n <= 6) this.nextKind = m.n;
    if (Array.isArray(m.w) && m.w.length <= 2 * C.GARBAGE_MAX_QUEUE && m.w.every(num)) {
      this.incoming = [];
      for (let i = 0; i + 1 < m.w.length; i += 2) {
        if (m.w[i] >= 0 && m.w[i] < C.GARBAGE_SLOTS) this.incoming.push({ slot: m.w[i], armed: m.w[i + 1] === 1 });
      }
    }

    const cut = Array.isArray(m.c) && m.c.every(num) ? m.c : null;
    const frame: Frame = { tm: m.tm, st: m.st, score: m.s, bodies, cut };
    // A state no later than the newest one (which a sender shouldn't send) replaces it in place
    if (prev && frame.tm <= prev.tm) {
      frame.tm = prev.tm;
      frame.cut ??= prev.cut;
      this.frames[this.frames.length - 1] = frame;
    } else this.frames.push(frame);
    // In a background tab nothing draws (or calls update) until it is shown again, then the clock
    // jumps to the newest state anyway: don't pile up what will never be drawn.
    if (this.frames.length > 120) this.frames.splice(0, this.frames.length - 60);
  }

  update(dt: number) {
    this.nextSpin = (this.nextSpin + C.NEXT_SPIN_SPEED * dt) % (Math.PI * 2);
    const last = this.frames.at(-1);
    if (!last) return;
    const target = last.tm - DELAY;
    if (!this.started) {
      this.started = true;
      this.clock = target;
    } else {
      // Run at our own pace, eased towards DELAY behind the newest state; jump if far off
      this.clock += dt;
      const err = target - this.clock;
      if (Math.abs(err) > 0.5) this.clock = target;
      else this.clock += err * 0.05;
    }
    // Never past the newest state: hold there while messages are late
    this.clock = Math.min(this.clock, last.tm);

    let i = 0;
    while (i + 1 < this.frames.length && this.frames[i + 1].tm <= this.clock) i++;
    for (let k = 1; k <= i; k++) {
      const cut = this.frames[k].cut;
      if (!cut) continue;
      // Show the field as it was just before the cut while the cut rows blink
      this.snapshot = this.poses(this.frames[k - 1].bodies);
      this.removedRows.fill(false);
      for (const r of cut) if (r >= 0 && r < C.ROWS) this.removedRows[r] = true;
      this.cutStart = this.frames[k].tm;
    }
    if (i > 0) this.frames.splice(0, i);
  }

  isCutting(): boolean {
    return this.state === 'cutting' && this.cutStart >= 0;
  }

  rowsLit(): boolean {
    const t = Math.min(C.CLEAR_DURATION, Math.max(0, this.clock - this.cutStart));
    const section = Math.ceil(t / (C.CLEAR_DURATION / C.CLEAR_BLINKS));
    return section % 2 === 1 || t === 0;
  }

  rowFullness(r: number): number {
    return this.fullness[r] ?? 0;
  }

  /** The field at the clock, `alpha` of a step on from the last update, between the two nearest states. */
  views(alpha = 1): PieceView[] {
    const [f0, f1] = this.frames;
    if (!f0) return [];
    if (!f1) return this.poses(f0.bodies);
    const t = this.clock - (1 - alpha) * C.STEP;
    const u = Math.min(1, Math.max(0, (t - f0.tm) / (f1.tm - f0.tm)));
    const out: PieceView[] = [];
    for (const [id, p1] of f1.bodies) {
      const info = this.pieces.get(id);
      if (!info) continue;
      const p0 = f0.bodies.get(id) ?? p1;
      out.push({
        x: p0.x + (p1.x - p0.x) * u,
        y: p0.y + (p1.y - p0.y) * u,
        angle: p0.a + (p1.a - p0.a) * u,
        shapes: info.shapes,
        kind: info.kind,
      });
    }
    return out;
  }

  private poses(bodies: Map<number, Pose>): PieceView[] {
    const out: PieceView[] = [];
    for (const [id, p] of bodies) {
      const info = this.pieces.get(id);
      if (info) out.push({ x: p.x, y: p.y, angle: p.a, shapes: info.shapes, kind: info.kind });
    }
    return out;
  }
}
