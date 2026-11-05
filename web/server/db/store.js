// Where finished runs are kept: Postgres when DATABASE_URL is set (db/postgres.js), otherwise this process's memory
// (lost on restart, fine for `npm run dev`). Both answer the same calls:
//
//   addRun(run)                             a finished run (shape below), already cleaned by the caller
//   recentRuns(limit)                       newest first, for the home page's feed after a restart
//   leaderboard({ map, stage, mode, kind, limit })   each player's best ranked run (rules: migrations/001_runs.sql,
//                                           the ranked_runs view), best first
//   close()
//
// run: { kind: 'solo'|'coop'|'versus', verified, map, stageId, stageName, mode: 'normal'|'endless',
//        result: 'win'|'lose'|'over'|'draw', time, players, named, roomName, cheats, cause, finishedAt (ms),
//        people: [{ name, won, hits, survived, removed }] }   people is empty for a private room
export const BOARD_MAX = 100;
const MEMORY_KEEP = 5000; // runs kept by the memory store

// The ranked_runs view, for the memory store: which (run, player) pairs can be ranked, and with what time.
function ranked(run, p) {
  if (run.cheats || p.removed) return null;
  if (run.mode === 'endless') return p.survived;
  return run.result === 'win' && p.won ? run.time : null;
}

// best first: endless = longest survived; normal = fastest, then fewest hits; ties go to whoever did it first
export function better(mode, a, b) {
  if (a.time !== b.time) return mode === 'endless' ? b.time - a.time : a.time - b.time;
  if (mode !== 'endless' && (a.hits ?? Infinity) !== (b.hits ?? Infinity)) return (a.hits ?? Infinity) - (b.hits ?? Infinity);
  return a.at - b.at;
}

export function memoryStore() {
  const runs = []; // oldest first
  return {
    kind: 'memory',
    async addRun(run) {
      runs.push(run);
      if (runs.length > MEMORY_KEEP) runs.splice(0, runs.length - MEMORY_KEEP);
    },
    async recentRuns(limit) { return runs.slice(-limit).reverse(); },
    async leaderboard({ map, stage, mode, kind, limit }) {
      const best = new Map(); // lower(name) -> row
      for (const run of runs) {
        if (run.map !== map || run.stageId !== stage || run.mode !== mode || run.kind !== kind) continue;
        for (const p of run.people) {
          const time = ranked(run, p);
          if (time == null) continue;
          const row = { name: p.name, time, hits: p.hits, at: run.finishedAt, verified: run.verified };
          const key = p.name.toLowerCase();
          const prev = best.get(key);
          if (!prev || better(mode, row, prev) < 0) best.set(key, row);
        }
      }
      return [...best.values()].sort((a, b) => better(mode, a, b)).slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
    },
    async close() {},
  };
}

// url: DATABASE_URL. required: a database that can't be reached is fatal (the standalone server); otherwise the
// memory store takes over with a warning (the dev server should still start).
export async function openStore({ url = process.env.DATABASE_URL, required = false, log = console.log } = {}) {
  if (!url) {
    if (required) throw new Error('DATABASE_URL is not set');
    log('runs: no DATABASE_URL, keeping runs in memory (lost on restart)');
    return memoryStore();
  }
  try {
    const { postgresStore } = await import('./postgres.js');
    const store = await postgresStore(url, log);
    log('runs: stored in Postgres');
    return store;
  } catch (e) {
    if (required) throw e;
    log(`runs: Postgres unavailable (${e.message}), keeping runs in memory`);
    return memoryStore();
  }
}
