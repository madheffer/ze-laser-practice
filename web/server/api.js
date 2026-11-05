// Read-only JSON over HTTP, for the game and for anyone who wants this server's data. Everything comes from the run
// store (db/store.js); nothing here writes.
//
//   GET /api/leaderboard?map=<map>&stage=<stage id>&mode=normal|endless&kind=solo|coop|versus&limit=1..100
//       -> { map, stage, mode, kind, rows: [{ rank, name, time, hits, at, verified }] }
//          each player's best ranked run (no cheat rules, not removed by the anti-cheat, normal = cleared),
//          best first: normal = fastest then fewest hits, endless = longest survived. verified = false: a solo run
//          the player's page reported (the server didn't watch it)
//   GET /api/runs?limit=1..100
//       -> { runs: [...] } newest first, db/store.js's run shape (a private room's runs have no people)
import { isMapName } from '../src/lib/paths.js';
import { BOARD_MAX } from './db/store.js';

const MODES = new Set(['normal', 'endless']);
const KINDS = new Set(['solo', 'coop', 'versus']);
const STAGE = /^[A-Za-z0-9_.-]{1,80}$/;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

const limitOf = (q, fallback) => {
  const n = Number(q.get('limit') ?? fallback);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, BOARD_MAX) : fallback;
};

// store: db/store.js's, or a promise for one. Returns a (req, res, next) handler; next() for anything not /api/.
export function apiHandler(store) {
  const ready = Promise.resolve(store);
  return async (req, res, next = () => json(res, 404, { error: 'not found' })) => {
    const url = new URL(req.url || '/', 'http://x');
    if (!url.pathname.startsWith('/api/')) return next();
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
    const q = url.searchParams;
    try {
      const s = await ready;
      if (url.pathname === '/api/leaderboard') {
        const map = q.get('map'), stage = q.get('stage'), mode = q.get('mode') || 'normal', kind = q.get('kind') || 'solo';
        if (!isMapName(map) || !STAGE.test(stage || '') || !MODES.has(mode) || !KINDS.has(kind)) {
          return json(res, 400, { error: 'need map, stage, mode (normal|endless), kind (solo|coop|versus)' });
        }
        const rows = await s.leaderboard({ map, stage, mode, kind, limit: limitOf(q, 25) });
        return json(res, 200, { map, stage, mode, kind, rows });
      }
      if (url.pathname === '/api/runs') return json(res, 200, { runs: await s.recentRuns(limitOf(q, 40)) });
      return json(res, 404, { error: 'not found' });
    } catch {
      return json(res, 503, { error: 'the run store is unavailable' });
    }
  };
}
