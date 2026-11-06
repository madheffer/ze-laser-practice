#!/usr/bin/env node
// Fetch GFL's StripperCS2 configs for a map (github.com/gflze/CS2-ZE-Configs, stripper/<map>/[<world>/]<lump>.jsonc)
// into the baked map folder as stripper.json: the entity edits GFL's servers make to that map (lib/stripper.js
// applies them wherever the map's entities load: the client, the co-op server, the tools). A map GFL doesn't strip
// gets no file (a stale one is removed). The configs are data: parsed as JSON(C), never run. Each file is kept as its
// named edits (GFL's comments; the ids printed here are what a scenario file's "stripper" list describes).
//
//   node tools/stripper.mjs ze_deadcore [ze_ffxii_westersand_v8 ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMapName } from '../web/src/lib/paths.js';
import { parseStripperJsonc } from '../web/src/lib/stripper.js';

const mapsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public/maps');
const REPO = 'gflze/CS2-ZE-Configs';
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
const UA = { 'user-agent': 'ze-laser-practice-bake' };

// every .jsonc under stripper/<map>/ (one tree request for the whole repo, shared by all maps on the command line)
let tree = null;
async function filesFor(map) {
  if (!tree) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`, { headers: UA });
    if (!res.ok) throw new Error(`GitHub tree: ${res.status}`);
    tree = ((await res.json()).tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
  }
  return tree.filter((p) => p.startsWith(`stripper/${map}/`) && p.endsWith('.jsonc'));
}

for (const map of process.argv.slice(2)) {
  if (!isMapName(map) || !fs.existsSync(path.join(mapsDir, map, 'manifest.json'))) { console.error(`${map}: not a baked map`); continue; }
  const out = path.join(mapsDir, map, 'stripper.json');
  const paths = await filesFor(map);
  if (!paths.length) {
    if (fs.existsSync(out)) fs.unlinkSync(out);
    console.log(`${map}: no stripper config`);
    continue;
  }
  const files = [];
  for (const p of paths) {
    const rel = p.slice(`stripper/${map}/`.length).split('/');
    const lump = rel.pop().replace(/\.jsonc$/, '');
    const world = rel.length ? rel.join('/') : map; // StripperCS2: no subfolder = the map's own world
    const res = await fetch(RAW + p.split('/').map(encodeURIComponent).join('/'), { headers: UA });
    if (!res.ok) { console.error(`${map}: ${p}: ${res.status}`); continue; }
    try {
      // the file's named edits (lib/stripper.js "Named edits"): each can be turned off in the settings
      const { edits } = parseStripperJsonc(await res.text());
      files.push({ path: p, world, lump, edits });
      console.log(`${map}: ${world}/${lump}${world.toLowerCase() !== map ? ' (another world: not baked, skipped when applied)' : ''}`);
      for (const e of edits) {
        const n = (k) => e.actions[k].length;
        console.log(`  ${e.id}: ${n('filter')} filter, ${n('add')} add, ${n('modify')} modify  // ${e.note}`);
      }
    } catch (e) {
      console.error(`${map}: ${p}: ${e.message}`);
    }
  }
  fs.writeFileSync(out, JSON.stringify({ source: `https://github.com/${REPO}/tree/main/stripper/${map}`, files }, null, 1));
}
