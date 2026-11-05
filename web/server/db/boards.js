// How runs become rankings: pure functions over plain rows, shared by both stores (db/store.js's memory store uses
// them on its runs; db/postgres.js does the same in SQL and orders its answers with these).
//
//   a board     one map + stage + mode + kind: each player's best ranked run, best first (better() below)
//   a map board every board of one map and kind: the record (place 1) of each stage / mode, and each player's
//               standing on the map: stages cleared, records held (#1s), podiums (top 3), ranked clears (wins)
//
// "Ranked" is the ranked_runs view (migrations/001-003): no cheat rules, not removed, a Steam account, normal runs
// only when cleared. Only Steam accounts are ever on a board.

export const MAP_SORTS = ['cleared', 'records', 'wins'];

// best first: endless = longest survived; normal = fastest, then fewest hits; ties go to whoever did it first
export function better(mode, a, b) {
  if (a.time !== b.time) return mode === 'endless' ? b.time - a.time : a.time - b.time;
  if (mode !== 'endless' && (a.hits ?? Infinity) !== (b.hits ?? Infinity)) return (a.hits ?? Infinity) - (b.hits ?? Infinity);
  return a.at - b.at;
}

// a map's players, best first, by one of MAP_SORTS; the rest of the columns break ties, then the name
const SORT_KEYS = {
  cleared: ['cleared', 'records', 'podiums', 'wins'],
  records: ['records', 'podiums', 'cleared', 'wins'],
  wins: ['wins', 'cleared', 'records', 'podiums'],
};
export function byStanding(sort) {
  const keys = SORT_KEYS[sort] || SORT_KEYS.cleared;
  return (a, b) => {
    for (const k of keys) if (a[k] !== b[k]) return b[k] - a[k];
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.steamId.localeCompare(b.steamId);
  };
}

export const boardKey = (map, stageId, mode, kind) => `${map}\n${stageId}\n${mode}\n${kind}`;

// rows: ranked rows { map, stageId, stageName, mode, kind, steamId, name, time, hits, at, verified, runId }
// -> Map boardKey -> [best row per player, best first, each with place (1-based)]
export function boardsOf(rows) {
  const best = new Map(); // boardKey -> Map steamId -> row
  for (const r of rows) {
    const k = boardKey(r.map, r.stageId, r.mode, r.kind);
    let b = best.get(k);
    if (!b) best.set(k, (b = new Map()));
    const prev = b.get(r.steamId);
    if (!prev || better(r.mode, r, prev) < 0) b.set(r.steamId, r);
  }
  const out = new Map();
  for (const [k, b] of best) {
    const list = [...b.values()];
    if (!list.length) continue;
    const mode = list[0].mode;
    list.sort((x, y) => better(mode, x, y));
    out.set(k, list.map((r, i) => ({ ...r, place: i + 1 })));
  }
  return out;
}

// one map and kind: boards (boardsOf's, for that map + kind only) and ranked rows (for the wins count)
// -> { stages: [{ stageId, stageName, mode, players, top }], players: [{ steamId, name, cleared, records, podiums, wins }] }
export function mapStanding(boards, rows) {
  const stages = [], people = new Map();
  const person = (r) => {
    let p = people.get(r.steamId);
    if (!p) people.set(r.steamId, (p = { steamId: r.steamId, name: r.name, cleared: 0, records: 0, podiums: 0, wins: 0 }));
    return p;
  };
  for (const list of boards.values()) {
    const top = list[0];
    stages.push({ stageId: top.stageId, stageName: top.stageName, mode: top.mode, players: list.length, top });
    for (const r of list) {
      const p = person(r);
      if (r.mode === 'normal') p.cleared++;
      if (r.place === 1) p.records++;
      if (r.place <= 3) p.podiums++;
    }
  }
  for (const r of rows) if (r.mode === 'normal' && people.has(r.steamId)) people.get(r.steamId).wins++;
  return { stages, players: [...people.values()] };
}

// a profile's maps: perMap [{ map, runs, wins, cleared }] (their listed runs) and placements [{ map, place }] (where
// they stand on every board they're on) -> [{ map, runs, wins, cleared, records, podiums, bestPlace }], most wins first
export function profileMaps(perMap, placements) {
  const maps = new Map(perMap.map((m) => [m.map, { ...m, records: 0, podiums: 0, bestPlace: null }]));
  for (const { map, place } of placements) {
    let m = maps.get(map);
    if (!m) maps.set(map, (m = { map, runs: 0, wins: 0, cleared: 0, records: 0, podiums: 0, bestPlace: null }));
    if (place === 1) m.records++;
    if (place <= 3) m.podiums++;
    if (m.bestPlace == null || place < m.bestPlace) m.bestPlace = place;
  }
  return [...maps.values()].sort((a, b) => b.wins - a.wins || b.cleared - a.cleared || b.runs - a.runs || a.map.localeCompare(b.map));
}
