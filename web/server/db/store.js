// Where finished runs are kept: Postgres when DATABASE_URL is set (db/postgres.js), otherwise this process's memory
// (lost on restart, fine for `npm run dev`). Both answer the same calls:
//
//   addRun(run) -> id                       a finished run (shape below), already cleaned by the caller
//   recentRuns(limit)                       the feed's runs (listed), newest first, for the home page after a restart
//   leaderboard({ map, stage, mode, kind, limit })   each player's best ranked run (rules: migrations/001_runs.sql,
//                                           the ranked_runs view), best first; a player is their SteamID when
//                                           signed in, else their name
//   upsertPlayer({ steamId, name, avatar }) on every Steam sign-in
//   playerRuns(steamId, limit)              a signed-in player's run history, newest first
//   getReplay(id)                           a run's replay: { runId, owner, public, meta, data (gzip), run } or null
//   shareReplay(id, owner, on) -> bool      the owner shares (keeps) or unshares one of their replays
//   addView(id)                             someone other than its owner watched it (runs-http.js dedupes)
//   close()
//
// run: { kind: 'solo'|'coop'|'versus', verified, map, stageId, stageName, mode: 'normal'|'endless',
//        result: 'win'|'lose'|'over'|'draw', time, players, named, roomName, cheats, cause, finishedAt (ms),
//        listed (false: not on the feed), people: [{ name, steamId, won, hits, survived, removed }],
//        replay?: { data (gzip Buffer), meta, public, owner (steamId | null) } }
//        people is empty for a private room
//
// Replays (migrations/002_players_replays.sql): a signed-in player keeps their newest REPLAYS_KEPT plus every one
// they shared from their history (pinned); a guest's (shared to the feed) last GUEST_DAYS days.
export const BOARD_MAX = 100;
export const REPLAYS_KEPT = 200;
export const GUEST_DAYS = 14;
const MEMORY_KEEP = 5000; // runs kept by the memory store
const MEMORY_REPLAYS = 300; // replays kept by the memory store

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

export const playerKey = (p) => (p.steamId ? `steam:${p.steamId}` : `name:${p.name.toLowerCase()}`);

const replayOf = (rp) => (rp ? { public: rp.public, pinned: rp.pinned, views: rp.views } : null);
export const runSummary = (run) => ({ name: run.people[0]?.name || '', map: run.map, stageName: run.stageName, mode: run.mode, time: run.time, result: run.result, hits: run.people[0]?.hits ?? null, at: run.finishedAt });

export function memoryStore() {
  const runs = []; // oldest first
  const replays = new Map(); // run id -> { owner, public, pinned, meta, data, at }
  const players = new Map();
  let nextId = 1;
  const byId = (id) => runs.find((r) => r.id === id);

  function prune(owner) {
    const mine = [...replays.entries()].filter(([, r]) => r.owner === owner);
    if (owner) {
      const loose = mine.filter(([, r]) => !r.pinned).sort((a, b) => b[0] - a[0]);
      for (const [id] of loose.slice(REPLAYS_KEPT)) replays.delete(id);
    } else {
      const cutoff = Date.now() - GUEST_DAYS * 86400000;
      for (const [id, r] of mine) if (r.at < cutoff) replays.delete(id);
    }
    if (replays.size > MEMORY_REPLAYS) for (const id of [...replays.keys()].slice(0, replays.size - MEMORY_REPLAYS)) replays.delete(id);
  }

  return {
    kind: 'memory',
    async addRun({ replay, ...run }) {
      const id = nextId++;
      runs.push({ id, listed: true, ...run });
      if (runs.length > MEMORY_KEEP) {
        for (const old of runs.splice(0, runs.length - MEMORY_KEEP)) replays.delete(old.id);
      }
      if (replay) {
        replays.set(id, { owner: replay.owner || null, public: !!replay.public, pinned: false, views: 0, meta: replay.meta, data: replay.data, at: run.finishedAt });
        prune(replay.owner || null);
      }
      return id;
    },
    async recentRuns(limit) {
      return runs.filter((r) => r.listed).slice(-limit).reverse()
        .map((r) => ({ ...r, replay: replays.get(r.id)?.public ? r.id : null, views: replays.get(r.id)?.views ?? 0 }));
    },
    async leaderboard({ map, stage, mode, kind, limit }) {
      const best = new Map(); // player key -> row
      for (const run of runs) {
        if (run.map !== map || run.stageId !== stage || run.mode !== mode || run.kind !== kind) continue;
        for (const p of run.people) {
          const time = ranked(run, p);
          if (time == null) continue;
          const row = { name: p.name, time, hits: p.hits, at: run.finishedAt, verified: run.verified, steam: !!p.steamId };
          const key = playerKey(p);
          const prev = best.get(key);
          if (!prev || better(mode, row, prev) < 0) best.set(key, row);
        }
      }
      return [...best.values()].sort((a, b) => better(mode, a, b)).slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
    },
    async upsertPlayer({ steamId, name, avatar = '' }) { players.set(steamId, { steamId, name, avatar, seenAt: Date.now() }); },
    async playerRuns(steamId, limit) {
      const out = [];
      for (let i = runs.length - 1; i >= 0 && out.length < limit; i--) {
        const run = runs[i];
        const p = run.people.find((x) => x.steamId === steamId);
        if (!p) continue;
        out.push({ id: run.id, kind: run.kind, map: run.map, stageId: run.stageId, stageName: run.stageName, mode: run.mode, result: run.result,
          time: run.time, finishedAt: run.finishedAt, cheats: run.cheats, won: p.won, hits: p.hits, survived: p.survived, replay: replayOf(replays.get(run.id)) });
      }
      return out;
    },
    async getReplay(id) {
      const rp = replays.get(id), run = byId(id);
      return rp && run ? { runId: id, owner: rp.owner, public: rp.public, views: rp.views, meta: rp.meta, data: rp.data, run: runSummary(run) } : null;
    },
    async addView(id) { const rp = replays.get(id); if (rp) rp.views++; },
    async shareReplay(id, owner, on) {
      const rp = replays.get(id);
      if (!rp || !owner || rp.owner !== owner) return false;
      rp.public = rp.pinned = !!on;
      return true;
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
