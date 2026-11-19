import { BLOCK } from './config';
import type { Poly } from './geometry';

export const PIECE_NAMES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'] as const;

// Centres of the four blocks of each piece, relative to the body origin (from newtetrishapes()).
const BLOCK_CENTRES: [number, number][][] = [
  [[-48, 0], [-16, 0], [16, 0], [48, 0]], // I
  [[-32, -16], [0, -16], [32, -16], [32, 16]], // J
  [[-32, -16], [0, -16], [32, -16], [-32, 16]], // L
  [[-16, -16], [-16, 16], [16, 16], [16, -16]], // O
  [[-32, 16], [0, -16], [32, -16], [0, 16]], // S
  [[-32, -16], [0, -16], [32, -16], [0, 16]], // T
  [[0, 16], [0, -16], [32, 16], [-32, -16]], // Z
  [[0, 0]], // GARBAGE: one block, sent by the other player in Versus
];

/** Kind of the single blocks a Versus attack drops (not one of PIECE_NAMES; never comes up as a piece) */
export const GARBAGE = 7;

function square(cx: number, cy: number): Poly {
  const h = BLOCK / 2;
  return [
    { x: cx - h, y: cy - h },
    { x: cx + h, y: cy - h },
    { x: cx + h, y: cy + h },
    { x: cx - h, y: cy + h },
  ];
}

export const PIECE_SHAPES: Poly[][] = BLOCK_CENTRES.map((blocks) => blocks.map(([x, y]) => square(x, y)));

/** Centre of mass of each piece in local coordinates (used to spin the preview nicely). */
export const PIECE_CENTRES = BLOCK_CENTRES.map((blocks) => ({
  x: blocks.reduce((s, b) => s + b[0], 0) / blocks.length,
  y: blocks.reduce((s, b) => s + b[1], 0) / blocks.length,
}));

/** Versus mode hands player 1 the mirror image of player 2's piece. */
export const MIRROR = [0, 2, 1, 3, 6, 5, 4];

/**
 * How the next piece is chosen. 'random': each piece on its own, so runs of the same one can be any
 * length. 'bag' (the 7-bag of modern Tetris): all seven pieces go in a bag in a shuffled order and
 * are dealt one by one, then a new bag is filled, so a kind never comes up more than twice in a row
 * and never waits more than 12 pieces.
 */
export type PieceOrder = 'bag' | 'random';
export const PIECE_ORDERS: PieceOrder[] = ['bag', 'random'];

/** A random number in [0, 1) */
type Rng = () => number;

/** Hands out piece kinds in the given order, drawing on `rng`. */
export function pieceSequence(order: PieceOrder, rng: Rng = Math.random): () => number {
  if (order === 'random') return () => Math.floor(rng() * 7);
  const bag: number[] = [];
  return () => {
    if (bag.length === 0) {
      bag.push(0, 1, 2, 3, 4, 5, 6);
      // Fisher–Yates
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop()!;
  };
}

/**
 * A piece sequence that comes out the same from the same seed in every browser (mulberry32: only
 * 32-bit integer maths, and the bag shuffle scales its exact k/2^32 numbers by small integers), so
 * both players of an online game get the same pieces. 'random' gives the same pieces as before the
 * bag existed.
 */
export function seededKinds(seed: number, order: PieceOrder): () => number {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return pieceSequence(order, rng);
}
