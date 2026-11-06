#!/usr/bin/env node
// A map's entity edits into its baked folder as stripper.json, applied by lib/stripper.js wherever the map's entities
// load (the client, the co-op server, the tools):
//   - GFL's StripperCS2 configs (github.com/gflze/CS2-ZE-Configs, stripper/<map>/[<world>/]<lump>.jsonc): the edits
//     GFL's servers make to the map, fetched
//   - ours (stripper/<map>/[<world>/]<lump>.jsonc in this repo, the same format): edits players asked for that no
//     server ships (ze_ffvii_cosmo_canyon_v5_p: Ifrit's 4 lasers), with the extension keys lib/stripper.js describes
// A map with neither gets no file (a stale one is removed). The configs are data: parsed as JSON(C), never run. Each
// file is kept as its named edits (the comments; the ids printed here are what a scenario file's "stripper" words
// describe), each one the player can turn off in the settings.
//
//   node tools/stripper.mjs ze_deadcore [ze_ffxii_westersand_v8 ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMapName } from '../web/src/lib/paths.js';
import { parseStripperJsonc } from '../web/src/lib/stripper.js';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapsDir = path.join(repoDir, 'web/public/maps');
const REPO = 'gflze/CS2-ZE-Configs';
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
const UA = { 'user-agent': 'ze-laser-practice-bake' };

// every .jsonc under GFL's stripper/<map>/ (one tree request for the whole repo, shared by all maps on the command line)
let tree = null;
async function gflFiles(map) {
  if (!tree) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`, { headers: UA });
    if (!res.ok) throw new Error(`GitHub tree: ${res.status}`);
    tree = ((await res.json()).tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
  }
  return tree.filter((p) => p.startsWith(`stripper/${map}/`) && p.endsWith('.jsonc'));
}

// ours: every .jsonc under this repo's stripper/<map>/ (the folder named by a checked map name: never leaves it)
function ownFiles(map) {
  const dir = path.join(repoDir, 'stripper', map);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map((f) => String(f).split(path.sep).join('/')).filter((f) => f.endsWith('.jsonc')).map((f) => `stripper/${map}/${f}`);
}

for (const map of process.argv.slice(2)) {
  if (!isMapName(map) || !fs.existsSync(path.join(mapsDir, map, 'manifest.json'))) { console.error(`${map}: not a baked map`); continue; }
  const out = path.join(mapsDir, map, 'stripper.json');
  const sources = [
    ...(await gflFiles(map)).map((p) => ({ p, source: 'gfl', read: async () => { const r = await fetch(RAW + p.split('/').map(encodeURIComponent).join('/'), { headers: UA }); if (!r.ok) throw new Error(String(r.status)); return r.text(); } })),
    ...ownFiles(map).map((p) => ({ p, source: 'ours', read: async () => fs.readFileSync(path.join(repoDir, p), 'utf8') })),
  ];
  if (!sources.length) {
    if (fs.existsSync(out)) fs.unlinkSync(out);
    console.log(`${map}: no stripper config`);
    continue;
  }
  const files = [];
  for (const { p, source, read } of sources) {
    const rel = p.slice(`stripper/${map}/`.length).split('/');
    const lump = rel.pop().replace(/\.jsonc$/, '');
    const world = rel.length ? rel.join('/') : map; // StripperCS2: no subfolder = the map's own world
    try {
      // the file's named edits (lib/stripper.js "Named edits"): each can be turned off in the settings
      const { edits } = parseStripperJsonc(await read());
      files.push({ path: p, source, world, lump, edits });
      console.log(`${map}: ${source === 'ours' ? 'ours' : 'GFL'} ${world}/${lump}${world.toLowerCase() !== map ? ' (another world: not baked, skipped when applied)' : ''}`);
      for (const e of edits) {
        const n = (k) => e.actions[k].length;
        console.log(`  ${e.id}: ${n('filter')} filter, ${n('add')} add, ${n('modify')} modify${e.meta?.count ? `, count ${e.meta.count.default} (${e.meta.count.min}-${e.meta.count.max})` : ''}  // ${e.note}`);
      }
    } catch (e) {
      console.error(`${map}: ${p}: ${e.message}`);
    }
  }
  fs.writeFileSync(out, JSON.stringify({ source: `https://github.com/${REPO}/tree/main/stripper/${map} + stripper/${map} (this repo)`, files }, null, 1));
}
