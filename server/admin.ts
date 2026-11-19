// Leaderboard housekeeping and play statistics from the command line. In Docker:
//
//   docker exec slicefall node server/admin.ts stats [days]      games played: totals, then per day; online rounds
//   docker exec slicefall node server/admin.ts games [n]         latest games, named or skipped
//   docker exec slicefall node server/admin.ts matches [n]       latest online Versus rounds
//   docker exec slicefall node server/admin.ts player <id>       names, games and online rounds of one player id (a prefix will do)
//   docker exec slicefall node server/admin.ts recent [n]        latest scores, with ids
//   docker exec slicefall node server/admin.ts name <NAME>       every score of one player, and their player ids
//   docker exec slicefall node server/admin.ts delete <id>       remove one score
//   docker exec slicefall node server/admin.ts delete-name <NAME> remove all of a player's scores
//   docker exec slicefall node server/admin.ts backup <file>     consistent copy, e.g. /data/backup.db

import { ScoreDb } from './db.ts';
import { normalizeName, weekStart } from './scores.ts';

const [cmd, arg] = process.argv.slice(2);
const db = new ScoreDb(process.env.DATABASE_URL || 'data/slicefall.db');

/** Prints rows as a table, with the unix-ms *_at columns as ISO times. */
const fmt = (rows: unknown[]) =>
  console.table(
    (rows as Record<string, unknown>[]).map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, k.endsWith('_at') && typeof v === 'number' ? new Date(v).toISOString() : v]),
      ),
    ),
  );

const name = () => {
  const n = normalizeName(arg);
  if (!n) throw new Error('give a player name');
  return n;
};

/** A game for the tables: the player id cut to 8 digits (enough to tell players apart and look one up). */
const gameRow = (g: Record<string, unknown>) => ({
  ...g,
  player: typeof g.player === 'string' ? g.player.slice(0, 8) : '-',
  name: g.name ?? '(no name)',
});

/** An online round for the tables: ids cut to 8 digits, the room to 6, the duration in seconds. */
const matchRow = (m: Record<string, unknown>) => {
  const { duration_ms, ...rest } = m;
  const short = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '-');
  return {
    ...rest,
    room: short(m.room, 6),
    host: short(m.host, 8),
    guest: short(m.guest, 8),
    host_score: m.host_score ?? '-',
    guest_score: m.guest_score ?? '-',
    host_t_spins: m.host_t_spins ?? '-',
    guest_t_spins: m.guest_t_spins ?? '-',
    winner: m.winner ?? '-',
    secs: Math.round(Number(duration_ms) / 1000),
  };
};

const playTime = (ms: number) => (ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

function stats(days: number) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const periods = { today, 'this week': weekStart(now), 'all time': null };
  console.table(
    Object.fromEntries(
      Object.entries(periods).map(([label, since]) => {
        const t = db.gameTotals(since);
        return [
          label,
          {
            games: t.games,
            submitted: t.named,
            unnamed: t.games - t.named,
            players: t.players,
            devices: t.devices,
            lines: t.lines,
            pieces: t.pieces,
            played: playTime(t.playMs),
            'avg score': t.avgScore,
            best: t.best,
          },
        ];
      }),
    ),
  );
  console.log(`Per day, last ${days} days (UTC):`);
  console.table(db.gamesByDay(new Date(today.getTime() - (days - 1) * 86_400_000)));
  console.log('Online Versus rounds:');
  console.table(
    Object.fromEntries(
      Object.entries(periods).map(([label, since]) => {
        const t = db.matchTotals(since);
        return [
          label,
          {
            rounds: t.rounds,
            finished: t.finished,
            'left early': t.left,
            rooms: t.rooms,
            rematches: t.rematches,
            devices: t.devices,
            played: playTime(t.playMs),
          },
        ];
      }),
    ),
  );
}

switch (cmd) {
  case 'stats':
    stats(Number(arg) || 14);
    break;
  case 'games':
    fmt(db.recentGames(Number(arg) || 20).map(gameRow));
    break;
  case 'matches':
    fmt(db.recentMatches(Number(arg) || 20).map(matchRow));
    break;
  case 'player':
    if (!arg || !/^[0-9a-f]{1,32}$/.test(arg)) throw new Error('give a player id, or the start of one');
    fmt(db.namesOf(arg));
    fmt(db.gamesByPlayer(arg).map(gameRow));
    fmt(db.matchesByPlayer(arg).map(matchRow));
    break;
  case 'recent':
    fmt(db.recent(Number(arg) || 20));
    break;
  case 'name':
    fmt(db.byName(name()));
    fmt(db.playersOf(name()));
    break;
  case 'delete':
    console.log(db.remove(Number(arg)) ? `deleted score ${arg}` : `no score with id ${arg}`);
    break;
  case 'delete-name':
    console.log(`deleted ${db.removeName(name())} scores of ${name()}`);
    break;
  case 'backup':
    if (!arg) throw new Error('give a target file');
    db.backup(arg);
    console.log(`backed up to ${arg}`);
    break;
  default:
    console.log('usage: node server/admin.ts stats [days] | games [n] | matches [n] | player <id> | recent [n] | name <NAME> | delete <id> | delete-name <NAME> | backup <file>');
    process.exitCode = 1;
}
db.close();
