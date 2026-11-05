// JSON over HTTP under /api/, for the game and for anyone who wants this server's data. Runs come from the run store
// (db/store.js). The read-only part is here; sign-in is auth/routes.js, your runs and replays runs-http.js.
//
//   GET /api/leaderboard?map=<map>&stage=<stage id>&mode=normal|endless&kind=solo|coop|versus&limit=1..100
//       -> { map, stage, mode, kind, rows: [{ rank, name, time, hits, at, verified, steam }] }
//          each player's best ranked run (no cheat rules, not removed by the anti-cheat, normal = cleared),
//          best first: normal = fastest then fewest hits, endless = longest survived. A signed-in player counts
//          once by their SteamID (steam = true). verified = false: a solo run the player's page reported
//   GET /api/runs?limit=1..100
//       -> { runs: [...] } newest first, the feed's runs (db/store.js's shape; a private room's runs have no people)
//   /api/auth/*  auth/routes.js      /api/solo, /api/replays/*, /api/me/runs  runs-http.js
import { isMapName } from '../src/lib/paths.js';
import { BOARD_MAX } from './db/store.js';
import { json } from './http-util.js';
import { authRoutes } from './auth/routes.js';
import { runRoutes } from './runs-http.js';

const MODES = new Set(['normal', 'endless']);
const KINDS = new Set(['solo', 'coop', 'versus']);
const STAGE = /^[A-Za-z0-9_.-]{1,80}$/;

const limitOf = (q, fallback) => {
  const n = Number(q.get('limit') ?? fallback);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, BOARD_MAX) : fallback;
};

// a run as the public sees it: no SteamIDs
const publicRun = (r) => ({ ...r, people: r.people.map(({ steamId, ...p }) => ({ ...p, steam: !!steamId })) });

// store: db/store.js's, or a promise for one; auth: auth/index.js's; feed() -> the activity feed (coop-relay.js)
// Returns a (req, res, next) handler; next() for anything not /api/.
export function apiHandler(store, { auth, feed = () => null, ipHeader = '' } = {}) {
  const ready = Promise.resolve(store);
  let routes = null;
  const routesFor = (s) => (routes ||= [
    authRoutes({ ...auth, store: s, ipHeader }),
    runRoutes({ store: s, sessions: auth.sessions, feed, ipHeader }),
  ]);
  return async (req, res, next = () => json(res, 404, { error: 'not found' })) => {
    const url = new URL(req.url || '/', 'http://x');
    if (!url.pathname.startsWith('/api/')) return next();
    const q = url.searchParams;
    try {
      const s = await ready;
      if (auth) for (const r of routesFor(s)) if (await r(req, res, url)) return;
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
      if (url.pathname === '/api/leaderboard') {
        const map = q.get('map'), stage = q.get('stage'), mode = q.get('mode') || 'normal', kind = q.get('kind') || 'solo';
        if (!isMapName(map) || !STAGE.test(stage || '') || !MODES.has(mode) || !KINDS.has(kind)) {
          return json(res, 400, { error: 'need map, stage, mode (normal|endless), kind (solo|coop|versus)' });
        }
        const rows = await s.leaderboard({ map, stage, mode, kind, limit: limitOf(q, 25) });
        return json(res, 200, { map, stage, mode, kind, rows });
      }
      if (url.pathname === '/api/runs') return json(res, 200, { runs: (await s.recentRuns(limitOf(q, 40))).map(publicRun) });
      return json(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) json(res, 503, { error: 'the run store is unavailable' });
    }
  };
}
