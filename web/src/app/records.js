// Personal bests, per map + stage + mode, kept in this browser. (Online leaderboards are on the roadmap:
// FEATURES.md, "ZE Laser Practice". Same shape, so a server can take these over.)
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
