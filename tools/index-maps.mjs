#!/usr/bin/env node
// Rebuild web/public/maps/index.json from the baked map folders (run after lasers-bake).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMapName } from '../web/src/lib/paths.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public');
const mapsDir = path.join(root, 'maps');
const maps = [];
for (const name of fs.readdirSync(mapsDir).sort()) {
  if (!fs.statSync(path.join(mapsDir, name)).isDirectory()) continue;
  if (!isMapName(name)) { console.warn(`skipped ${JSON.stringify(name)}: not a map name (lib/paths.js)`); continue; }
  const mf = path.join(mapsDir, name, 'manifest.json');
  if (!fs.existsSync(mf)) continue;
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  let scenarios = 0;
  const sf = path.join(root, 'scenarios', `${name}.json`);
  if (fs.existsSync(sf)) scenarios = (JSON.parse(fs.readFileSync(sf, 'utf8')).scenarios || []).length;
  maps.push({ name, title: m.title || name, scenarios, version: m.version });
}
fs.writeFileSync(path.join(mapsDir, 'index.json'), JSON.stringify({ maps }, null, 1));
console.log(`${maps.length} maps`);
