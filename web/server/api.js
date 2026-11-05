// JSON over HTTP under /api/, for the game and for anyone who wants this server's data. Runs come from the run store
// (db/store.js). The read-only part is here; sign-in is auth/routes.js, your runs and replays runs-http.js.
//
//   GET /api/leaderboard?map=<map>&stage=<stage id>&mode=normal|endless&kind=solo|coop|versus&limit=1..100
//                       &player=<SteamID64>?
//       -> { map, stage, mode, kind, total, rows: [{ rank, name, avatar, time, hits, at, verified, steam, steamId,
//            replay }], me: a row | null }
//          one stage's board: each Steam account's best ranked run (no cheat rules, not removed by the anti-cheat,
//          normal = cleared), best first: normal = fastest then fewest hits, endless = longest survived. steamId =
//          their public profile, name / avatar their Steam persona now, replay = that run's replay id when public.
//          verified = false: a solo run the server couldn't re-run. total = players on the board; me = player's
//          own row when it is below the top `limit` (the page asks for whoever is signed in, or a profile's player)
//   GET /api/maps/<map>/board?kind=solo|coop|versus&sort=cleared|records|wins&limit=1..100&player=<SteamID64>?
//       -> { map, kind, sort, total, stages: [{ stageId, stageName, mode, players, top }], players: [{ rank,
//            steamId, name, avatar, cleared, records, podiums, wins }], me }
//          a whole map (db/boards.js): every stage board's record holder, and its players ranked by stages cleared,
//          records held (#1s), podiums (top 3) and ranked clears (wins)
//   GET /api/runs?limit=1..100
//       -> { runs: [...] } newest first, the feed's runs (db/store.js's shape; a private room's runs have no people)
//   /api/auth/*  auth/routes.js      /api/solo, /api/replays/*, /api/me/runs  runs-http.js
//   /api/players/<SteamID64>  players-http.js (public profiles)
import { isMapName } from '../src/lib/paths.js';
import { isSteamId, isAvatarUrl } from '../src/lib/steam.js';
import { BOARD_MAX } from './db/store.js';
import { MAP_SORTS } from './db/boards.js';
import { json } from './http-util.js';
import { authRoutes } from './auth/routes.js';
import { runRoutes } from './runs-http.js';
import { playerRoutes } from './players-http.js';

const MODES = new Set(['normal', 'endless']);
const KINDS = new Set(['solo', 'coop', 'versus']);
const STAGE = /^[A-Za-z0-9_.-]{1,80}$/;

const limitOf = (q, fallback) => {
  const n = Number(q.get('limit') ?? fallback);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, BOARD_MAX) : fallback;
};

const MAP_BOARD = /^\/api\/maps\/([^/]{1,64})\/board$/;
const playerOf = (q) => (isSteamId(q.get('player')) ? q.get('player') : null);
// only a Steam CDN avatar ever leaves the server (lib/steam.js)
const withAvatar = (r) => ({ ...r, avatar: isAvatarUrl(r.avatar) ? r.avatar : '' });

// a run as the public sees it: a signed-in player's SteamID is their public profile's (players-http.js)
const publicRun = (r) => ({ ...r, people: r.people.map(({ steamId, ...p }) => ({ ...p, steam: !!steamId, steamId: steamId || null })) });

// store: db/store.js's, or a promise for one; auth: auth/index.js's; feed() -> the activity feed (coop-relay.js)
// Returns a (req, res, next) handler; next() for anything not /api/.
export function apiHandler(store, { auth, feed = () => null, ipHeader = '' } = {}) {
  const ready = Promise.resolve(store);
  let routes = null, players = null;
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
      if (await (players ||= playerRoutes({ store: s, ipHeader }))(req, res, url)) return;
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
      if (url.pathname === '/api/leaderboard') {
        const map = q.get('map'), stage = q.get('stage'), mode = q.get('mode') || 'normal', kind = q.get('kind') || 'solo';
        if (!isMapName(map) || !STAGE.test(stage || '') || !MODES.has(mode) || !KINDS.has(kind)) {
          return json(res, 400, { error: 'need map, stage, mode (normal|endless), kind (solo|coop|versus)' });
        }
        const b = await s.leaderboard({ map, stage, mode, kind, limit: limitOf(q, 25), player: playerOf(q) });
        return json(res, 200, { map, stage, mode, kind, total: b.total, rows: b.rows.map(withAvatar), me: b.me && withAvatar(b.me) });
      }
      const mb = MAP_BOARD.exec(url.pathname);
      if (mb) {
        const kind = q.get('kind') || 'solo', sort = q.get('sort') || 'cleared';
        if (!isMapName(mb[1]) || !KINDS.has(kind) || !MAP_SORTS.includes(sort)) {
          return json(res, 400, { error: 'need kind (solo|coop|versus), sort (cleared|records|wins)' });
        }
        const b = await s.mapBoard({ map: mb[1], kind, sort, limit: limitOf(q, 50), player: playerOf(q) });
        return json(res, 200, {
          map: mb[1], kind, sort, total: b.total,
          stages: b.stages.map((st) => ({ ...st, top: withAvatar(st.top) })), players: b.rows.map(withAvatar), me: b.me && withAvatar(b.me),
        });
      }
      if (url.pathname === '/api/runs') return json(res, 200, { runs: (await s.recentRuns(limitOf(q, 40))).map(publicRun) });
      return json(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) json(res, 503, { error: 'the run store is unavailable' });
    }
  };
}
