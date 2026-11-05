// The stage files the server reads to check a round start (a real stage, endless only where the stage has it),
// to name it in the public room list, and (`full`) for the anti-cheat's own copy of the run. The same files the
// game loads (web/public/scenarios/<map>.json).
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isMapName } from '../src/lib/paths.js';

export function scenarioStore(dir) {
  const cache = new Map(); // map -> { mtime, list }
  return async function find(map, stageId) {
    if (!isMapName(map)) return null;
    const file = path.join(dir, `${map}.json`); // the name is [a-z0-9_-] only: never leaves dir
    let st;
    try { st = await stat(file); } catch { return null; }
    let hit = cache.get(map);
    if (!hit || hit.mtime !== st.mtimeMs) {
      try {
        const json = JSON.parse(await readFile(file, 'utf8'));
        hit = { mtime: st.mtimeMs, list: Array.isArray(json?.scenarios) ? json.scenarios : [] };
        cache.set(map, hit);
      } catch { return null; }
    }
    if (stageId == null) return { id: null, name: 'Free roam', endless: false, fastForward: 0, full: null };
    const s = hit.list.find((x) => x && x.id === stageId);
    if (!s) return null;
    return { id: s.id, name: String(s.name || s.id).slice(0, 60), endless: !!s.endless, fastForward: Number(s.fastForward) || 0, full: s };
  };
}
