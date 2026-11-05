// Public player profiles: a Steam account as anyone may see it (ui/profile.js draws it).
//
//   GET /api/players/<SteamID64>
//       -> { player: { steamId, name, avatar, since }, totals: { runs, wins, cleared, solo, coop, versus, records, podiums },
//            best: [{ map, stageId, stageName, mode, kind, time, hits, at, verified, place, of }],
//            maps: [{ map, runs, wins, cleared, records, podiums, bestPlace }] (most wins first),
//            recent: [{ id, kind, map, stageName, mode, result, time, won, hits, survived, at, replay, views }] }
//          404 for an account that never signed in here. Read-only; one request per address per PROFILE_MS.
//
// Only public things: the name and avatar Steam shows anyway, when they first signed in, and their listed runs
// (db/store.js profile(): a private room's players are never stored; a run kept only for its player's history,
// "Share my runs" off, or one the anti-cheat removed, is not listed and never counted here). A replay's id only
// when it is public. Never their last sign-in, an address or anything from the session.
import { json, clientAddress, rateGate } from './http-util.js';
import { isSteamId, isAvatarUrl } from '../src/lib/steam.js';

const PROFILE_PATH = /^\/api\/players\/(\d{17})$/;
const PROFILE_MS = 250;

// { store, ipHeader } -> (req, res, url) => true when it answered
export function playerRoutes({ store, ipHeader = '' }) {
  const gate = rateGate(PROFILE_MS);
  return async (req, res, url) => {
    const m = PROFILE_PATH.exec(url.pathname);
    if (!m) return false;
    if (req.method !== 'GET') { json(res, 405, { error: 'GET only' }); return true; }
    if (!gate(clientAddress(req, ipHeader))) { json(res, 429, { error: 'slow down' }); return true; }
    const steamId = m[1];
    if (!isSteamId(steamId)) { json(res, 400, { error: 'not a SteamID64' }); return true; }
    const acc = await store.player(steamId);
    if (!acc) { json(res, 404, { error: 'no such player' }); return true; }
    const { totals, best, maps, recent } = await store.profile(steamId);
    json(res, 200, {
      player: { steamId, name: acc.name, avatar: isAvatarUrl(acc.avatar) ? acc.avatar : '', since: acc.createdAt ?? null },
      totals, best, maps, recent,
    });
    return true;
  };
}
