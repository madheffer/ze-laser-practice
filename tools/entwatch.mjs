#!/usr/bin/env node
// Fetch GFL's EntWatch config for a map (github.com/gflze/CS2-ZE-Configs, entwatch/<map>.jsonc) into the baked map
// folder as entwatch.json: the map's items as a GFL server shows them (name, short name, colour, the weapon and
// button by hammer id, cooldown mode / seconds / max uses). The player's item HUD and the heal option read it
// (world/items.js). Only the fields we use are kept, typed; the file is data, never code.
//
//   node tools/entwatch.mjs ze_mist_p [ze_deadcore ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMapName } from '../web/src/lib/paths.js';

const mapsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public/maps');
const BASE = 'https://raw.githubusercontent.com/gflze/CS2-ZE-Configs/main/entwatch/';
const str = (v, max = 64) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);

for (const map of process.argv.slice(2)) {
  if (!isMapName(map) || !fs.existsSync(path.join(mapsDir, map, 'manifest.json'))) { console.error(`${map}: not a baked map`); continue; }
  const res = await fetch(BASE + `${map}.jsonc`);
  if (!res.ok) { console.log(`${map}: no EntWatch config (${res.status})`); continue; }
  // jsonc: drop // comments and trailing commas
  const text = (await res.text()).replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[\]}])/g, '$1');
  const items = (JSON.parse(text) || []).filter((it) => it && typeof it === 'object').map((it) => ({
    name: str(it.name), shortname: str(it.shortname || it.name, 24), color: str(it.color, 16).toLowerCase(),
    weapon: int(it.hammerid),
    handlers: (Array.isArray(it.handlers) ? it.handlers : []).map((h) => ({
      type: str(h.type, 16), hammerid: int(h.hammerid), event: str(h.event, 32),
      mode: int(h.mode) ?? 0, cooldown: int(h.cooldown) ?? 0, maxuses: int(h.maxuses) ?? 0,
    })),
  })).filter((it) => it.name && it.weapon != null);
  fs.writeFileSync(path.join(mapsDir, map, 'entwatch.json'), JSON.stringify({ source: BASE + `${map}.jsonc`, items }, null, 1));
  console.log(`${map}: ${items.length} items (${items.map((i) => i.shortname).join(', ')})`);
}
