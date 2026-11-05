// What the leaderboards and profiles read: the server's boards (server/api.js /api/maps/<map>/board,
// /api/leaderboard), a profile (/api/players/<id>) and a map's stage list (its scenario file), cleaned here. Answers
// are kept for CACHE_MS, so flipping between tabs, maps and Back is instant; a newer request for the same URL
// replaces an older one.
//
// Everything here came from the server (names from Steam, stage names from scenario files): it leaves as plain
// values that the views put in the DOM as text only.
import { fetchJson } from '../lib/fetch.js';
import { cleanText } from '../lib/room-rules.js';
import { isMapName } from '../lib/paths.js';
import { isSteamId, isAvatarUrl } from '../lib/steam.js';
import { groupStages } from '../lib/stage-groups.js';
import { loadScenarios } from '../world/assets.js';

const CACHE_MS = 20000;
const cache = new Map(); // url -> { at, p }
const KINDS = new Set(['solo', 'coop', 'versus']);

function cached(url) {
  const hit = cache.get(url);
  if (hit && performance.now() - hit.at < CACHE_MS) return hit.p;
  const p = fetchJson(url, { cache: 'no-store' });
  cache.set(url, { at: performance.now(), p });
  p.catch(() => cache.delete(url));
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return p;
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
const rank = (v) => (Number.isInteger(v) && v >= 1 ? v : null);
export const kindOf = (v) => (KINDS.has(v) ? v : 'solo');

// a player as a board shows them, or null
function person(x) {
  if (!x || !isSteamId(x.steamId)) return null;
  return { steamId: x.steamId, name: cleanText(x.name, 32) || 'Steam player', avatar: isAvatarUrl(x.avatar) ? x.avatar : '' };
}

const standing = (x) => {
  const p = person(x);
  return p && rank(x.rank) ? { ...p, rank: x.rank, cleared: count(x.cleared), records: count(x.records), podiums: count(x.podiums), wins: count(x.wins) } : null;
};

const timeRow = (x) => {
  const p = person(x);
  return p && rank(x.rank) && num(x.time) != null ? {
    ...p, rank: x.rank, time: x.time, hits: Number.isInteger(x.hits) ? x.hits : null, at: num(x.at),
    verified: x.verified === true, replay: Number.isInteger(x.replay) && x.replay > 0 ? x.replay : null,
  } : null;
};

const query = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

// a whole map: { total, stages: Map `${stageId}\n${mode}` -> { players, top }, players: [...], me }
export async function mapBoard(map, { kind, sort, player }) {
  if (!isMapName(map)) throw new Error('bad map');
  const j = await cached(`/api/maps/${map}/board?${query({ kind, sort, limit: 100, player })}`);
  const stages = new Map();
  for (const s of Array.isArray(j?.stages) ? j.stages.slice(0, 2000) : []) {
    const top = person(s?.top);
    if (!top || typeof s.stageId !== 'string' || num(s.top.time) == null) continue;
    stages.set(`${s.stageId}\n${s.mode === 'endless' ? 'endless' : 'normal'}`, {
      players: count(s.players), top: { ...top, time: s.top.time, hits: Number.isInteger(s.top.hits) ? s.top.hits : null },
    });
  }
  return { total: count(j?.total), stages, players: (Array.isArray(j?.players) ? j.players : []).slice(0, 100).map(standing).filter(Boolean), me: standing(j?.me) };
}

// one stage: { total, rows, me }
export async function stageBoard(map, stage, { mode, kind, player }) {
  if (!isMapName(map)) throw new Error('bad map');
  const j = await cached(`/api/leaderboard?${query({ map, stage, mode, kind, limit: 100, player })}`);
  return { total: count(j?.total), rows: (Array.isArray(j?.rows) ? j.rows : []).slice(0, 100).map(timeRow).filter(Boolean), me: timeRow(j?.me) };
}

// a profile -> { player, totals, best, maps, recent } or null (a 404 throws with ': 404' at the end of its message)
export async function profile(steamId) {
  const j = await fetchJson(`/api/players/${steamId}`, { cache: 'no-store' });
  const p = j?.player;
  if (!p || p.steamId !== steamId) return null;
  const t = j.totals || {};
  return {
    player: { steamId, name: cleanText(p.name, 32) || 'Steam player', avatar: isAvatarUrl(p.avatar) ? p.avatar : '', since: num(p.since) },
    totals: Object.fromEntries(['runs', 'wins', 'cleared', 'solo', 'coop', 'versus', 'records', 'podiums'].map((k) => [k, count(t[k])])),
    best: (Array.isArray(j.best) ? j.best : []).slice(0, 200).filter((b) => b && isMapName(b.map) && typeof b.stageId === 'string' && num(b.time) != null).map((b) => ({
      map: b.map, stageId: b.stageId.slice(0, 80), stage: cleanText(b.stageName, 60) || 'a stage', mode: b.mode === 'endless' ? 'endless' : 'normal',
      kind: kindOf(b.kind), time: b.time, hits: Number.isInteger(b.hits) ? b.hits : null, at: num(b.at), place: rank(b.place), of: count(b.of),
    })),
    maps: (Array.isArray(j.maps) ? j.maps : []).slice(0, 200).filter((m) => m && isMapName(m.map)).map((m) => ({
      map: m.map, runs: count(m.runs), wins: count(m.wins), cleared: count(m.cleared), records: count(m.records), podiums: count(m.podiums), bestPlace: rank(m.bestPlace),
    })),
    recent: (Array.isArray(j.recent) ? j.recent : []).slice(0, 50).filter((r) => r && Number.isInteger(r.id)).map((r) => ({
      map: isMapName(r.map) ? r.map : '', stage: cleanText(r.stageName, 60) || 'a stage', kind: kindOf(r.kind),
      result: ['win', 'lose', 'over', 'draw'].includes(r.result) ? r.result : 'lose', time: num(r.time), hits: Number.isInteger(r.hits) ? r.hits : null,
      at: num(r.at), replay: Number.isInteger(r.replay) && r.replay > 0 ? r.replay : null, views: count(r.views),
    })),
  };
}

// a map's stages as the stage list groups them (lib/stage-groups.js), boss attacks under their boss:
// [{ name, stages: [{ id, name, endless, part }] }]; the file is the map's own scenario file
const stageCache = new Map();
export function mapStages(map) {
  if (!stageCache.has(map)) {
    stageCache.set(map, loadScenarios(map).then((f) => {
      const list = Array.isArray(f?.scenarios) ? f.scenarios : [];
      const kids = new Map();
      for (const s of list) if (s?.parent) { if (!kids.has(s.parent)) kids.set(s.parent, []); kids.get(s.parent).push(s); }
      const one = (s, part) => ({ id: String(s.id).slice(0, 80), name: cleanText(s.name, 60) || String(s.id), endless: !!s.endless, part });
      return groupStages(list).map((g) => ({
        name: cleanText(g.name, 40) || 'Stages',
        stages: g.items.flatMap((i) => [one(list[i], false), ...(kids.get(list[i].id) || []).map((k) => one(k, true))]),
      }));
    }));
  }
  return stageCache.get(map);
}
