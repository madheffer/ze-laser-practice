// The Postgres side of db/store.js. Tables: migrations/*.sql, applied in name order on start (each once, in a
// transaction, under an advisory lock so two servers starting together don't race). `npm run db:migrate` does
// the same without starting the server.
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPLAYS_KEPT, GUEST_DAYS, GUEST_KEPT, PINNED_MAX } from './store.js';
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
  id: Number(r.id), kind: r.kind, verified: r.verified, map: r.map, stageId: r.stage_id, stageName: r.stage_name, mode: r.mode,
  result: r.result, time: r.time_s, players: r.players, named: r.named, roomName: r.room_name, cheats: r.cheats,
  cause: r.cause, finishedAt: r.finished_at.getTime(), listed: r.listed, people,
});

// a player, once: COALESCE(steam_id, name) for DISTINCT ON (store.js playerKey)
const PLAYER_KEY = "COALESCE('steam:' || steam_id, 'name:' || lower(name))";

export async function postgresStore(url, log) {
  const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  pool.on('error', (e) => log(`runs: Postgres connection error: ${e.message}`)); // an idle client dropped
  try {
    await migrate(pool, log);
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }

  // a replay's keep rules (store.js): a player's newest REPLAYS_KEPT + pinned; a guest's GUEST_DAYS days
  async function prune(client, owner) {
    if (owner) {
      await client.query(
        `DELETE FROM replays WHERE owner = $1 AND NOT pinned AND run_id NOT IN (
           SELECT run_id FROM replays WHERE owner = $1 AND NOT pinned ORDER BY run_id DESC LIMIT $2)`, [owner, REPLAYS_KEPT]);
    } else {
      await client.query(`DELETE FROM replays WHERE owner IS NULL AND created_at < now() - make_interval(days => $1)`, [GUEST_DAYS]);
      await client.query(
        `DELETE FROM replays WHERE owner IS NULL AND run_id NOT IN (
           SELECT run_id FROM replays WHERE owner IS NULL ORDER BY run_id DESC LIMIT $1)`, [GUEST_KEPT]);
    }
  }

  return {
    kind: 'postgres',
    async addRun(run) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [{ id }] } = await client.query(
          `INSERT INTO runs (finished_at, kind, verified, map, stage_id, stage_name, mode, result, time_s, players,
                             named, room_name, cheats, cause, listed)
           VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
          [run.finishedAt, run.kind, run.verified, run.map, run.stageId, run.stageName, run.mode, run.result, run.time,
            run.players, run.named, run.roomName, run.cheats, run.cause, run.listed !== false]);
        for (const [slot, p] of run.people.entries()) {
          // a session can outlive a database reset: make sure the player row is there
          if (p.steamId) await client.query('INSERT INTO players (steam_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p.steamId, p.name]);
          await client.query(
            'INSERT INTO run_players (run_id, slot, name, won, hits, survived_s, removed, steam_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [id, slot, p.name, p.won, p.hits, p.survived, p.removed, p.steamId || null]);
        }
        if (run.replay) {
          const rp = run.replay;
          await client.query('INSERT INTO replays (run_id, owner, public, meta, data) VALUES ($1, $2, $3, $4, $5)',
            [id, rp.owner || null, !!rp.public, JSON.stringify(rp.meta), rp.data]);
          await prune(client, rp.owner || null);
        }
        await client.query('COMMIT');
        return Number(id);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async recentRuns(limit) {
      const { rows } = await pool.query(
        `SELECT r.*, (rp.run_id IS NOT NULL) AS has_public_replay, rp.views AS replay_views FROM runs r
         LEFT JOIN replays rp ON rp.run_id = r.id AND rp.public
         WHERE r.listed ORDER BY r.finished_at DESC, r.id DESC LIMIT $1`, [limit]);
      if (!rows.length) return [];
      const { rows: people } = await pool.query(
        'SELECT run_id, name, won, hits, survived_s, removed, steam_id FROM run_players WHERE run_id = ANY($1) ORDER BY run_id, slot',
        [rows.map((r) => r.id)]);
      const byRun = new Map();
      for (const p of people) {
        if (!byRun.has(p.run_id)) byRun.set(p.run_id, []);
        byRun.get(p.run_id).push({ name: p.name, won: p.won, hits: p.hits, survived: p.survived_s, removed: p.removed, steamId: p.steam_id });
      }
      return rows.map((r) => ({ ...runOut(r, byRun.get(r.id) || []), replay: r.has_public_replay ? Number(r.id) : null, views: r.replay_views ?? 0 }));
    },

    async leaderboard({ map, stage, mode, kind, limit }) {
      const order = ORDER[mode]; // only ever one of the two constants above: never text from a request
      if (!order) return [];
      const { rows } = await pool.query(
        `SELECT name, time_s, hits, finished_at, verified, steam_id FROM (
           SELECT DISTINCT ON (${PLAYER_KEY}) name, time_s, hits, finished_at, verified, steam_id
           FROM ranked_runs WHERE map = $1 AND stage_id = $2 AND mode = $3 AND kind = $4
           ORDER BY ${PLAYER_KEY}, ${order}
         ) best ORDER BY ${order} LIMIT $5`,
        [map, stage, mode, kind, limit]);
      return rows.map((r, i) => ({ rank: i + 1, name: r.name, time: r.time_s, hits: r.hits, at: r.finished_at.getTime(), verified: r.verified, steam: !!r.steam_id }));
    },

    async upsertPlayer({ steamId, name, avatar = '' }) {
      await pool.query(
        `INSERT INTO players (steam_id, name, avatar) VALUES ($1, $2, $3)
         ON CONFLICT (steam_id) DO UPDATE SET name = EXCLUDED.name, avatar = EXCLUDED.avatar, seen_at = now()`,
        [steamId, name, avatar]);
    },

    async playerRuns(steamId, limit) {
      const { rows } = await pool.query(
        `SELECT r.id, r.kind, r.map, r.stage_id, r.stage_name, r.mode, r.result, r.time_s, r.finished_at, r.cheats,
                p.won, p.hits, p.survived_s, rp.run_id AS replay_id, rp.public AS replay_public, rp.pinned AS replay_pinned, rp.views AS replay_views
         FROM run_players p JOIN runs r ON r.id = p.run_id LEFT JOIN replays rp ON rp.run_id = r.id
         WHERE p.steam_id = $1 ORDER BY r.id DESC LIMIT $2`, [steamId, limit]);
      return rows.map((r) => ({
        id: Number(r.id), kind: r.kind, map: r.map, stageId: r.stage_id, stageName: r.stage_name, mode: r.mode, result: r.result,
        time: r.time_s, finishedAt: r.finished_at.getTime(), cheats: r.cheats, won: r.won, hits: r.hits, survived: r.survived_s,
        replay: r.replay_id != null ? { public: r.replay_public, pinned: r.replay_pinned, views: r.replay_views } : null,
      }));
    },

    async getReplay(id) {
      const { rows: [r] } = await pool.query(
        `SELECT rp.run_id, rp.owner, rp.public, rp.views, rp.meta, rp.data, x.map, x.stage_name, x.mode, x.time_s, x.result, x.finished_at,
                p.name, p.hits
         FROM replays rp JOIN runs x ON x.id = rp.run_id
         LEFT JOIN run_players p ON p.run_id = rp.run_id AND p.slot = 0
         WHERE rp.run_id = $1`, [id]);
      if (!r) return null;
      return {
        runId: Number(r.run_id), owner: r.owner, public: r.public, views: r.views, meta: r.meta, data: r.data,
        run: { name: r.name || '', map: r.map, stageName: r.stage_name, mode: r.mode, time: r.time_s, result: r.result, hits: r.hits, at: r.finished_at.getTime() },
      };
    },

    async addView(id) { await pool.query('UPDATE replays SET views = views + 1 WHERE run_id = $1', [id]); },

    // the server's replay check (replay-verify.js): a removed run's player rows leave the ranked_runs view
    async setVerdict(id, { verified = false, removed = '' }) {
      if (verified) await pool.query('UPDATE runs SET verified = true WHERE id = $1', [id]);
      if (removed) {
        await pool.query('UPDATE run_players SET removed = $2 WHERE run_id = $1', [id, String(removed).slice(0, 60)]);
        await pool.query('UPDATE runs SET listed = false WHERE id = $1', [id]); // off the feed too
      }
    },

    async shareReplay(id, owner, on) {
      if (!owner) return false;
      // at most PINNED_MAX shared for good per player (the count check and the update in one statement)
      const { rowCount } = await pool.query(
        `UPDATE replays SET public = $3, pinned = $3 WHERE run_id = $1 AND owner = $2
           AND (NOT $3 OR pinned OR (SELECT count(*) FROM replays WHERE owner = $2 AND pinned) < $4)`, [id, owner, !!on, PINNED_MAX]);
      return rowCount > 0;
    },

    close: () => pool.end(),
  };
}
