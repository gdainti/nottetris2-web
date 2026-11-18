import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ANON, type GameRecord, type Mode, type Submission } from './scores.ts';

export interface BoardEntry {
  rank: number;
  name: string;
  score: number;
  lines: number;
  level: number;
  pieces: number;
  /** When this best score was set, ISO 8601 */
  at: string;
}

/**
 * Schema changes, applied in order. PRAGMA user_version remembers how many have run, so add new
 * steps at the end and never edit one that has shipped.
 */
const MIGRATIONS = [
  `CREATE TABLE score (
     id          INTEGER PRIMARY KEY,
     mode        TEXT    NOT NULL CHECK (mode IN ('cut', 'stack')),
     name        TEXT    NOT NULL,
     score       INTEGER NOT NULL,
     lines       INTEGER NOT NULL,
     level       INTEGER NOT NULL,
     pieces      INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL,
     created_at  INTEGER NOT NULL -- unix ms
   );
   CREATE INDEX score_by_mode_score ON score (mode, score DESC);
   CREATE INDEX score_by_mode_time  ON score (mode, created_at);
   CREATE INDEX score_by_mode_name  ON score (mode, name, score DESC);`,

  // Stack mode was removed: drop its scores and only allow Cut. SQLite can't change a CHECK in
  // place, so the table is rebuilt (dropping it also drops its indexes, which are made again).
  `DELETE FROM score WHERE mode <> 'cut';
   CREATE TABLE score_new (
     id          INTEGER PRIMARY KEY,
     mode        TEXT    NOT NULL CHECK (mode IN ('cut')),
     name        TEXT    NOT NULL,
     score       INTEGER NOT NULL,
     lines       INTEGER NOT NULL,
     level       INTEGER NOT NULL,
     pieces      INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL,
     created_at  INTEGER NOT NULL -- unix ms
   );
   INSERT INTO score_new (id, mode, name, score, lines, level, pieces, duration_ms, created_at)
     SELECT id, mode, name, score, lines, level, pieces, duration_ms, created_at FROM score;
   DROP TABLE score;
   ALTER TABLE score_new RENAME TO score;
   CREATE INDEX score_by_mode_score ON score (mode, score DESC);
   CREATE INDEX score_by_mode_time  ON score (mode, created_at);
   CREATE INDEX score_by_mode_name  ON score (mode, name, score DESC);`,

  // Every finished game, scored or skipped, for play statistics. A game gets the player's name
  // (and its leaderboard row) only when they submit the score; NULL means they skipped or had none.
  `CREATE TABLE game (
     id          INTEGER PRIMARY KEY,
     mode        TEXT    NOT NULL CHECK (mode IN ('cut')),
     name        TEXT,
     score_id    INTEGER REFERENCES score (id) ON DELETE SET NULL,
     score       INTEGER NOT NULL,
     lines       INTEGER NOT NULL,
     level       INTEGER NOT NULL,
     pieces      INTEGER NOT NULL,
     cuts        INTEGER NOT NULL,
     best_cut    INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL,
     created_at  INTEGER NOT NULL -- unix ms
   );
   CREATE INDEX game_by_time  ON game (created_at);
   CREATE INDEX game_by_score ON game (score_id);`,

  // A random id the browser keeps, so one player's games and scores can be followed, named or not.
  // NULL for rows from before it existed, or sent by a client without it. player_name ties each id
  // to the names it has submitted scores under (not the shared ANON), and a name to its ids.
  `ALTER TABLE game ADD COLUMN player TEXT;
   CREATE INDEX game_by_player ON game (player, created_at);
   ALTER TABLE score ADD COLUMN player TEXT;
   CREATE INDEX score_by_player ON score (player);
   CREATE TABLE player_name (
     player   TEXT    NOT NULL,
     name     TEXT    NOT NULL,
     scores   INTEGER NOT NULL, -- scores submitted with this id and name
     first_at INTEGER NOT NULL, -- unix ms
     last_at  INTEGER NOT NULL, -- unix ms
     PRIMARY KEY (player, name)
   ) WITHOUT ROWID;
   CREATE INDEX player_name_by_name ON player_name (name);`,
];

export interface GameTotals {
  games: number;
  /** Games whose score was submitted with a name */
  named: number;
  /** Different names among those */
  players: number;
  /** Different player ids (browsers) among all the games */
  devices: number;
  lines: number;
  pieces: number;
  playMs: number;
  best: number;
  avgScore: number;
}

export class ScoreDb {
  readonly sql: DatabaseSync;

  /** `file` is a path, or `:memory:` for tests. */
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    const { user_version: done } = this.sql.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let i = done; i < MIGRATIONS.length; i++) {
      this.sql.exec('BEGIN');
      try {
        this.sql.exec(MIGRATIONS[i]);
        this.sql.exec(`PRAGMA user_version = ${i + 1}`);
        this.sql.exec('COMMIT');
      } catch (e) {
        this.sql.exec('ROLLBACK');
        throw e;
      }
    }
  }

  /**
   * Adds a leaderboard score. With a gameId, that game-log row gets the name too, but only if it is
   * still unnamed, from the same player id and its numbers match: a score can't rename someone
   * else's game. With a player id (and a name of their own, not ANON), the pair is recorded.
   */
  add(s: Submission, at: Date): number {
    const player = s.player ?? null;
    this.sql.exec('BEGIN');
    try {
      const r = this.sql
        .prepare(
          `INSERT INTO score (mode, name, player, score, lines, level, pieces, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(s.mode, s.name, player, s.score, s.lines, s.level, s.pieces, s.durationMs, at.getTime());
      const id = Number(r.lastInsertRowid);
      if (s.gameId !== undefined) {
        this.sql
          .prepare(
            `UPDATE game SET name = ?, score_id = ?
             WHERE id = ? AND name IS NULL AND player IS ?
               AND mode = ? AND score = ? AND lines = ? AND pieces = ? AND duration_ms = ?`,
          )
          .run(s.name, id, s.gameId, player, s.mode, s.score, s.lines, s.pieces, s.durationMs);
      }
      if (player !== null && s.name !== ANON) {
        this.sql
          .prepare(
            `INSERT INTO player_name (player, name, scores, first_at, last_at) VALUES (?, ?, 1, ?, ?)
             ON CONFLICT (player, name) DO UPDATE SET scores = scores + 1, last_at = excluded.last_at`,
          )
          .run(player, s.name, at.getTime(), at.getTime());
      }
      this.sql.exec('COMMIT');
      return id;
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  /** The names a player id has submitted scores under, most recent first (for the admin script). */
  namesOf(prefix: string) {
    return this.sql
      .prepare(
        `SELECT player, name, scores, first_at, last_at FROM player_name
         WHERE player >= ? AND player < ? ORDER BY last_at DESC`,
      )
      .all(prefix, `${prefix}g`);
  }

  /** The player ids a name has been submitted from, most recent first (for the admin script). */
  playersOf(name: string) {
    return this.sql
      .prepare(
        `SELECT player, name, scores, first_at, last_at FROM player_name
         WHERE name = ? ORDER BY last_at DESC`,
      )
      .all(name);
  }

  /** Logs a finished game, scored or not. */
  addGame(g: GameRecord, at: Date): number {
    const r = this.sql
      .prepare(
        `INSERT INTO game (mode, player, score, lines, level, pieces, cuts, best_cut, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(g.mode, g.player ?? null, g.score, g.lines, g.level, g.pieces, g.cuts, g.bestCut, g.durationMs, at.getTime());
    return Number(r.lastInsertRowid);
  }

  /** Totals over the game log since `since` (or ever). */
  gameTotals(since: Date | null): GameTotals {
    return this.sql
      .prepare(
        `SELECT COUNT(*) AS games, COUNT(name) AS named, COUNT(DISTINCT name) AS players,
                COUNT(DISTINCT player) AS devices,
                COALESCE(SUM(lines), 0) AS lines, COALESCE(SUM(pieces), 0) AS pieces,
                COALESCE(SUM(duration_ms), 0) AS playMs, COALESCE(MAX(score), 0) AS best,
                COALESCE(ROUND(AVG(score)), 0) AS avgScore
         FROM game WHERE created_at >= ?`,
      )
      .get(since?.getTime() ?? 0) as unknown as GameTotals;
  }

  /** Games per UTC day since `since`, newest day first. */
  gamesByDay(since: Date) {
    return this.sql
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS games, COUNT(name) AS named,
                SUM(lines) AS lines, MAX(score) AS best, ROUND(SUM(duration_ms) / 60000.0) AS minutes
         FROM game WHERE created_at >= ? GROUP BY day ORDER BY day DESC`,
      )
      .all(since.getTime());
  }

  /** The latest games, newest first (for the admin script). */
  recentGames(limit: number) {
    return this.sql
      .prepare(
        `SELECT id, mode, player, name, score, lines, level, pieces, cuts, best_cut, duration_ms, created_at
         FROM game ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** Every game of the player ids starting with `prefix`, newest first (for the admin script). */
  gamesByPlayer(prefix: string) {
    return this.sql
      .prepare(
        `SELECT id, mode, player, name, score, lines, level, pieces, cuts, best_cut, duration_ms, created_at
         FROM game WHERE player >= ? AND player < ? ORDER BY created_at DESC, id DESC`,
      )
      .all(prefix, `${prefix}g`);
  }

  /**
   * One row per player: their best score since `since` (or ever), highest first.
   * Equal scores: whoever got there first ranks higher.
   */
  board(mode: Mode, since: Date | null, limit: number): BoardEntry[] {
    const rows = this.sql
      .prepare(
        `SELECT name, score, lines, level, pieces, created_at FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY score DESC, created_at ASC, id ASC) AS n
           FROM score WHERE mode = ? AND created_at >= ?
         ) WHERE n = 1
         ORDER BY score DESC, created_at ASC, name ASC
         LIMIT ?`,
      )
      .all(mode, since?.getTime() ?? 0, limit) as {
      name: string;
      score: number;
      lines: number;
      level: number;
      pieces: number;
      created_at: number;
    }[];
    return rows.map((r, i) => ({
      rank: i + 1,
      name: r.name,
      score: r.score,
      lines: r.lines,
      level: r.level,
      pieces: r.pieces,
      at: new Date(r.created_at).toISOString(),
    }));
  }

  /** A player's place on a board: 1 + the players with a higher best. Null if they have no score there. */
  rank(mode: Mode, name: string, since: Date | null): number | null {
    const from = since?.getTime() ?? 0;
    const mine = this.sql
      .prepare('SELECT MAX(score) AS best FROM score WHERE mode = ? AND name = ? AND created_at >= ?')
      .get(mode, name, from) as { best: number | null };
    if (mine.best === null) return null;
    const above = this.sql
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT MAX(score) AS best FROM score WHERE mode = ? AND created_at >= ? GROUP BY name
         ) WHERE best > ?`,
      )
      .get(mode, from, mine.best) as { n: number };
    return above.n + 1;
  }

  /** Every score a name has, newest first (for the admin script). */
  byName(name: string) {
    return this.sql
      .prepare('SELECT id, mode, name, player, score, lines, created_at FROM score WHERE name = ? ORDER BY created_at DESC')
      .all(name);
  }

  recent(limit: number) {
    return this.sql
      .prepare('SELECT id, mode, name, score, lines, pieces, duration_ms, created_at FROM score ORDER BY id DESC LIMIT ?')
      .all(limit);
  }

  remove(id: number): boolean {
    return Number(this.sql.prepare('DELETE FROM score WHERE id = ?').run(id).changes) > 0;
  }

  /** Removes a player's scores and takes their name off their games and ids (the games still count). */
  removeName(name: string): number {
    this.sql.prepare('UPDATE game SET name = NULL WHERE name = ?').run(name);
    this.sql.prepare('DELETE FROM player_name WHERE name = ?').run(name);
    return Number(this.sql.prepare('DELETE FROM score WHERE name = ?').run(name).changes);
  }

  /** A consistent copy of the database while it is in use. */
  backup(to: string) {
    this.sql.prepare('VACUUM INTO ?').run(to);
  }

  ping(): boolean {
    return (this.sql.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  close() {
    this.sql.close();
  }
}
