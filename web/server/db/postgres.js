// The Postgres side of db/store.js. Tables: migrations/*.sql, applied in name order on start (each once, in a
// transaction, under an advisory lock so two servers starting together don't race). `npm run db:migrate` does
// the same without starting the server.
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK = 58040001; // any constant: pg_advisory_xact_lock key for migrations

export async function migrate(pool, log = () => {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS)).filter((f) => /^\d+_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query(await readFile(path.join(MIGRATIONS, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      log(`runs: applied ${f}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const ORDER = {
  normal: 'time_s ASC, hits ASC NULLS LAST, finished_at ASC',
  endless: 'time_s DESC, finished_at ASC',
};

const runOut = (r, people) => ({
  kind: r.kind, verified: r.verified, map: r.map, stageId: r.stage_id, stageName: r.stage_name, mode: r.mode,
  result: r.result, time: r.time_s, players: r.players, named: r.named, roomName: r.room_name, cheats: r.cheats,
  cause: r.cause, finishedAt: r.finished_at.getTime(), people,
});

export async function postgresStore(url, log) {
  const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  pool.on('error', (e) => log(`runs: Postgres connection error: ${e.message}`)); // an idle client dropped
  try {
    await migrate(pool, log);
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }

  return {
    kind: 'postgres',
    async addRun(run) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [{ id }] } = await client.query(
          `INSERT INTO runs (finished_at, kind, verified, map, stage_id, stage_name, mode, result, time_s, players,
                             named, room_name, cheats, cause)
           VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
          [run.finishedAt, run.kind, run.verified, run.map, run.stageId, run.stageName, run.mode, run.result, run.time,
            run.players, run.named, run.roomName, run.cheats, run.cause]);
        for (const [slot, p] of run.people.entries()) {
          await client.query(
            'INSERT INTO run_players (run_id, slot, name, won, hits, survived_s, removed) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, slot, p.name, p.won, p.hits, p.survived, p.removed]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async recentRuns(limit) {
      const { rows } = await pool.query('SELECT * FROM runs ORDER BY finished_at DESC, id DESC LIMIT $1', [limit]);
      if (!rows.length) return [];
      const { rows: people } = await pool.query(
        'SELECT run_id, name, won, hits, survived_s, removed FROM run_players WHERE run_id = ANY($1) ORDER BY run_id, slot',
        [rows.map((r) => r.id)]);
      const byRun = new Map();
      for (const p of people) {
        if (!byRun.has(p.run_id)) byRun.set(p.run_id, []);
        byRun.get(p.run_id).push({ name: p.name, won: p.won, hits: p.hits, survived: p.survived_s, removed: p.removed });
      }
      return rows.map((r) => runOut(r, byRun.get(r.id) || []));
    },

    async leaderboard({ map, stage, mode, kind, limit }) {
      const order = ORDER[mode]; // only ever one of the two constants above: never text from a request
      if (!order) return [];
      const { rows } = await pool.query(
        `SELECT name, time_s, hits, finished_at, verified FROM (
           SELECT DISTINCT ON (lower(name)) name, time_s, hits, finished_at, verified
           FROM ranked_runs WHERE map = $1 AND stage_id = $2 AND mode = $3 AND kind = $4
           ORDER BY lower(name), ${order}
         ) best ORDER BY ${order} LIMIT $5`,
        [map, stage, mode, kind, limit]);
      return rows.map((r, i) => ({ rank: i + 1, name: r.name, time: r.time_s, hits: r.hits, at: r.finished_at.getTime(), verified: r.verified }));
    },

    close: () => pool.end(),
  };
}
