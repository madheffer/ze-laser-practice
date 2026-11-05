// Runs over HTTP: your solo run (with its replay), watching a replay, sharing one, your run history.
//
//   POST /api/solo                 a finished solo run from this page: { map, stage, mode, result, time, hits, cause,
//                                  name, share, replay?: { meta, data: base64 gzip } } -> { id, replay: id | null }
//                                  Signed in: always stored (your history); share = also on the live feed, replay
//                                  public. Signed out: only sent with share on (the page doesn't send it otherwise).
//   GET  /api/replays/<id>         -> { run, meta, data: base64 gzip, views }   public replays, or your own;
//                                  counts a view when it isn't yours (once per viewer per replay per 30 minutes)
//   POST /api/replays/<id>/share   { on } -> { ok }   your own: shared (anyone with the link, kept) or not
//   GET  /api/me/runs?limit=1..100 -> { runs: [...] }   your history (signed in)
//
// A replay is checked by decoding it (lib/replay-codec.js): sizes, ranges, the header's seed / stage / mode against
// the run it came with, and its length against the run's time. It is still the page's word (solo runs are unchecked,
// verified = false); the server doesn't re-run it.
import zlib from 'node:zlib';
import { json, readBody, sameOriginWrite, clientAddress, rateGate } from './http-util.js';
import { decodeReplay, cleanMeta, MAX_BYTES } from '../src/lib/replay-codec.js';
import { BOARD_MAX } from './db/store.js';

const BODY_MAX = 1536 * 1024; // the JSON body (base64 of <= 1 MB gzip)
const GZIP_MAX = 1024 * 1024;
const SOLO_MS = 4000; // one solo run per address per this long
const SHARE_MS = 300;
const VIEW_MS = 30 * 60 * 1000; // one view per viewer per replay per this long
const REPLAY_PATH = /^\/api\/replays\/(\d{1,15})(\/share)?$/;
const TICK = 1 / 64;

// upload: { meta, data }; run: the cleaned run it came with -> { data (gzip Buffer), meta } or null
export function checkReplay(upload, { map, stageId, mode, time }) {
  if (!upload || typeof upload !== 'object' || typeof upload.data !== 'string' || upload.data.length > BODY_MAX) return null;
  const meta = cleanMeta(upload.meta);
  if (!meta || meta.map !== map || meta.stage !== stageId || meta.mode !== mode) return null;
  try {
    const gz = Buffer.from(upload.data, 'base64');
    if (!gz.length || gz.length > GZIP_MAX) return null;
    const raw = zlib.gunzipSync(gz, { maxOutputLength: MAX_BYTES });
    const d = decodeReplay(new Uint8Array(raw.buffer, raw.byteOffset, raw.length));
    // the recording covers the run: the stage time, plus its countdown (meta.countdown: 3 s, world/run-engine.js
    // COUNTDOWN; older replays 1 s, none mid-map)
    if (d.n * TICK < time - 1 || d.n * TICK > time + 4) return null;
    meta.ticks = d.n;
    return { data: gz, meta, decoded: d }; // decoded: for the server's own check (replay-verify.js)
  } catch {
    return null;
  }
}

// { store, sessions (auth/session.js), feed: () => activity feed | undefined, ipHeader }
export function runRoutes({ store, sessions, feed, ipHeader = '' }) {
  const soloGate = rateGate(SOLO_MS);
  const shareGate = rateGate(SHARE_MS);
  const viewGate = rateGate(VIEW_MS, 50000);

  async function solo(req, res) {
    if (!sameOriginWrite(req)) return json(res, 403, { error: 'cross-site' });
    if (!soloGate(clientAddress(req, ipHeader))) return json(res, 429, { error: 'slow down' });
    let m;
    try { m = JSON.parse((await readBody(req, BODY_MAX)).toString('utf8')); } catch (e) { return json(res, e.status || 400, { error: 'bad body' }); }
    if (!m || typeof m !== 'object') return json(res, 400, { error: 'bad body' });
    const user = sessions.user(req);
    const share = m.share === true;
    if (!user && !share) return json(res, 200, { id: null, replay: null }); // nothing to keep it for
    const f = feed();
    if (!f) return json(res, 503, { error: 'starting' });
    const out = await f.solo(m, { user, share, checkReplay });
    return json(res, out ? 200 : 400, out || { error: 'not a run on this server' });
  }

  async function replay(req, res, id, share) {
    const user = sessions.user(req);
    if (share) {
      if (req.method !== 'POST' || !sameOriginWrite(req)) return json(res, 403, { error: 'cross-site' });
      if (!user) return json(res, 401, { error: 'sign in first' });
      if (!shareGate(user.steamId)) return json(res, 429, { error: 'slow down' });
      let on;
      try { on = JSON.parse((await readBody(req, 256)).toString('utf8'))?.on === true; } catch { return json(res, 400, { error: 'bad body' }); }
      return json(res, 200, { ok: await store.shareReplay(id, user.steamId, on) });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
    const r = await store.getReplay(id);
    const mine = !!(user && r && r.owner === user.steamId);
    if (!r || !(r.public || mine)) return json(res, 404, { error: 'no such replay' });
    // a view: someone else watching it, once per viewer (their SteamID, else their address) per replay per 30 minutes
    let views = r.views || 0;
    if (!mine && viewGate(`${user ? user.steamId : clientAddress(req, ipHeader)}:${id}`)) { views++; store.addView(id).catch(() => {}); }
    return json(res, 200, { id, run: r.run, meta: r.meta, data: Buffer.from(r.data).toString('base64'), mine, public: r.public, views });
  }

  async function history(req, res, q) {
    const user = sessions.user(req);
    if (!user) return json(res, 401, { error: 'sign in first' });
    const n = Number(q.get('limit') ?? 50);
    const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, BOARD_MAX) : 50;
    return json(res, 200, { runs: await store.playerRuns(user.steamId, limit) });
  }

  // -> true when it answered
  return async (req, res, url) => {
    const p = url.pathname;
    if (p === '/api/solo') { if (req.method !== 'POST') json(res, 405, { error: 'POST only' }); else await solo(req, res); return true; }
    if (p === '/api/me/runs' && req.method === 'GET') { await history(req, res, url.searchParams); return true; }
    const m = REPLAY_PATH.exec(p);
    if (m) { await replay(req, res, Number(m[1]), !!m[2]); return true; }
    return false;
  };
}
