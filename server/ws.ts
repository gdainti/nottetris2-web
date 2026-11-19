// A small WebSocket server (RFC 6455) on top of node:http's 'upgrade' event, enough for the online
// Versus rooms: text messages of a few kB, ping/pong, close. Node has a WebSocket client built in but
// no server, and this keeps the server free of npm dependencies.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Close codes used here (RFC 6455 section 7.4.1). */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocol: 1002,
  unsupported: 1003,
  policy: 1008,
  tooBig: 1009,
} as const;

export interface WsOptions {
  /** Largest message accepted, in bytes; a bigger one closes the connection. */
  maxMessage: number;
  /** A ping goes out this often; a connection that sent nothing since the last one is dropped. */
  pingMs: number;
}

/**
 * Completes the handshake for a WebSocket upgrade request, or answers with an HTTP error and returns
 * null. `head` is whatever arrived after the request headers (usually nothing).
 */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, opts: WsOptions): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  const valid =
    req.method === 'GET' &&
    String(req.headers.upgrade ?? '').toLowerCase() === 'websocket' &&
    req.headers['sec-websocket-version'] === '13' &&
    typeof key === 'string' &&
    Buffer.from(key, 'base64').length === 16;
  if (!valid) {
    refuseUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WsConnection(socket, head, opts);
}

/** Answers an upgrade request with a plain HTTP error and hangs up. */
export function refuseUpgrade(socket: Duplex, status: number, text: string) {
  if (socket.writable) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Encodes one unmasked frame (servers never mask). */
function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

export class WsConnection {
  onMessage: (text: string) => void = () => {};
  /** Called once, however the connection ends. */
  onClose: (code: number) => void = () => {};

  private buf: Buffer = Buffer.alloc(0);
  /** Pieces of a fragmented message so far */
  private parts: Buffer[] = [];
  private partsSize = 0;
  private closed = false;
  private alive = true;
  private timer: NodeJS.Timeout;
  private socket: Duplex;
  private opts: WsOptions;

  constructor(socket: Duplex, head: Buffer, opts: WsOptions) {
    this.socket = socket;
    this.opts = opts;
    socket.on('data', (d: Buffer) => this.receive(d));
    socket.on('close', () => this.finish(CLOSE.goingAway));
    socket.on('error', () => this.finish(CLOSE.goingAway));
    this.timer = setInterval(() => {
      if (!this.alive) return this.destroy();
      this.alive = false;
      this.write(0x9, Buffer.alloc(0));
    }, opts.pingMs);
    this.timer.unref();
    if (head.length) this.receive(head);
  }

  get open(): boolean {
    return !this.closed;
  }

  send(text: string) {
    this.write(0x1, Buffer.from(text, 'utf8'));
  }

  /** Starts the closing handshake; the socket ends once it is sent. */
  close(code: number = CLOSE.normal, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.write(0x8, payload);
    this.socket.end();
    this.finish(code);
  }

  /** Drops the connection without a closing handshake (a dead or misbehaving peer). */
  destroy() {
    this.socket.destroy();
    this.finish(CLOSE.goingAway);
  }

  private write(opcode: number, payload: Buffer) {
    if (this.closed || !this.socket.writable) return;
    this.socket.write(frame(opcode, payload));
  }

  private finish(code: number) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.onClose(code);
  }

  private receive(data: Buffer) {
    if (this.closed) return;
    this.alive = true;
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    while (!this.closed) {
      const used = this.parse();
      if (used === 0) break;
      this.buf = this.buf.subarray(used);
    }
  }

  /** Handles one complete frame at the start of the buffer and returns its size, or 0 if it isn't all here yet. */
  private parse(): number {
    const b = this.buf;
    if (b.length < 2) return 0;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let at = 2;
    if (b[0] & 0x70) return this.fail(CLOSE.protocol, 'no extensions');
    // Clients must mask every frame
    if (!masked) return this.fail(CLOSE.protocol, 'unmasked frame');
    if (len === 126) {
      if (b.length < 4) return 0;
      len = b.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (b.length < 10) return 0;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.opts.maxMessage)) return this.fail(CLOSE.tooBig, 'message too big');
      len = Number(big);
      at = 10;
    }
    if (len > this.opts.maxMessage) return this.fail(CLOSE.tooBig, 'message too big');
    if (b.length < at + 4 + len) return 0;
    const mask = b.subarray(at, at + 4);
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = b[at + 4 + i] ^ mask[i & 3];
    const size = at + 4 + len;

    if (opcode >= 0x8) {
      // Control frames: never fragmented, at most 125 bytes
      if (!fin || len > 125) return this.fail(CLOSE.protocol, 'bad control frame');
      // The peer is closing: answer with a close frame of our own and hang up
      if (opcode === 0x8) this.close(CLOSE.normal);
      else if (opcode === 0x9) this.write(0xa, payload);
      // 0xA pong: `alive` is already set
      return size;
    }

    if (opcode === 0x2) return this.fail(CLOSE.unsupported, 'text only');
    if (opcode === 0x1) {
      if (this.parts.length) return this.fail(CLOSE.protocol, 'unfinished message');
    } else if (opcode !== 0x0 || !this.parts.length) {
      return this.fail(CLOSE.protocol, 'bad opcode');
    }
    this.partsSize += len;
    if (this.partsSize > this.opts.maxMessage) return this.fail(CLOSE.tooBig, 'message too big');
    this.parts.push(payload);
    if (fin) {
      const text = Buffer.concat(this.parts).toString('utf8');
      this.parts = [];
      this.partsSize = 0;
      this.onMessage(text);
    }
    return size;
  }

  private fail(code: number, reason: string): number {
    this.close(code, reason);
    return 0;
  }
}
