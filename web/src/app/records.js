// Personal bests, per map + stage + mode, kept in this browser (works offline). Online, every run also goes to
// the server's database (server/db/, README "Database") and /api/leaderboard ranks them.
//
// normal  run: best = fastest clear, also fewest hits
// endless run: best = longest survived
import { loadJson, saveJson, own } from '../lib/storage.js';

const KEY = 'lasers.records.v1';

const load = () => loadJson(KEY);
const save = (all) => saveJson(KEY, all);

const id = (map, stage, mode) => `${map}/${stage}/${mode}`;

// one record out of the (untrusted) stored table: an object, or null
function recordIn(all, k) {
  const r = own(all, k);
  return r && typeof r === 'object' ? r : null;
}

export function getRecord(map, stage, mode) {
  return recordIn(load(), id(map, stage, mode));
}

// How many stages of a map have a record (normal clears, endless runs), for the map picker.
export function mapRecordCounts(map) {
  const out = { cleared: 0, endless: 0 };
  const prefix = `${map}/`;
  for (const k of Object.keys(load())) {
    if (!k.startsWith(prefix)) continue;
    if (k.endsWith('/normal')) out.cleared++;
    else if (k.endsWith('/endless')) out.endless++;
  }
  return out;
}

// Returns { record, improved: { time?, hits? } }.
export function submitRun(map, stage, mode, { time, hits, humans, bossHp }) {
  const all = load();
  const k = id(map, stage, mode);
  const prev = recordIn(all, k);
  const improved = {};
  const r = prev ? { ...prev } : { runs: 0 };
  r.runs = (r.runs || 0) + 1;
  if (mode === 'endless') {
    if (!(r.time >= time)) { r.time = time; r.hits = hits; improved.time = true; }
  } else {
    if (!(r.time <= time)) { r.time = time; improved.time = true; }
    if (!(r.hits <= hits)) { r.hits = hits; improved.hits = true; }
  }
  if (improved.time) { r.date = new Date().toISOString(); r.humans = humans; r.bossHp = bossHp; }
  all[k] = r;
  save(all);
  return { record: r, previous: prev || null, improved };
}
