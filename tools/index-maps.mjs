#!/usr/bin/env node
// Rebuild web/public/maps/index.json from the baked map folders (run after lasers-bake, or after editing a
// scenario file). The map picker (web/src/ui/maps.js) reads it: per map its title, a line about it, and its
// parts (the scenario groups, in the stage list's order, with how many stages / bosses / endless runs each has), and which
// stages have a thumbnail.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMapName, isStageId } from '../web/src/lib/paths.js';
import { mapItems } from '../web/src/world/items.js';
import { groupStages } from '../web/src/lib/stage-groups.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public');
const mapsDir = path.join(root, 'maps');
const maps = [];
for (const name of fs.readdirSync(mapsDir).sort()) {
  if (!fs.statSync(path.join(mapsDir, name)).isDirectory()) continue;
  if (!isMapName(name)) { console.warn(`skipped ${JSON.stringify(name)}: not a map name (lib/paths.js)`); continue; }
  const mf = path.join(mapsDir, name, 'manifest.json');
  if (!fs.existsSync(mf)) continue;
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const sf = path.join(root, 'scenarios', `${name}.json`);
  const file = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : {};
  const list = Array.isArray(file.scenarios) ? file.scenarios : [];
  // a child drill (parent) belongs to its parent's group
  const groupOf = new Map(list.map((s) => [s.id, s.group]));
  const parts = [];
  for (const s of list) {
    const g = String((s.parent ? groupOf.get(s.parent) : s.group) || 'Stages');
    let p = parts.find((x) => x.name === g);
    if (!p) parts.push((p = { name: g, stages: 0, bosses: 0, endless: 0 }));
    p.stages++;
    if (s.bosses?.length) p.bosses++;
    if (s.endless) p.endless++;
  }
  // the stage list's order (lib/stage-groups.js): Main stages, the ending, special modes, Mini bosses
  const order = groupStages(list).map((p) => p.name);
  parts.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  // the map's own screenshots (lasers-bake writes shots/1.jpg, 2.jpg, ...): the home page hero
  const shotsDir = path.join(mapsDir, name, 'shots');
  const shots = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter((f) => /^\d{1,2}\.jpg$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b)) : [];
  // the stage thumbnails (web/src/dev/capture-stage-shots.js writes maps/<name>/stages/<id>.webp): only ids that are this
  // map's stages, so the stage list requests only files that exist; stageShotsVersion (the newest file's time) goes
  // on their URLs with the manifest version, so a recapture is fetched again
  const stagesDir = path.join(mapsDir, name, 'stages');
  const ids = new Set(list.map((s) => s.id).filter(isStageId));
  const shotFiles = fs.existsSync(stagesDir) ? fs.readdirSync(stagesDir).filter((f) => f.endsWith('.webp') && ids.has(f.slice(0, -5))) : [];
  const stageShots = shotFiles.map((f) => f.slice(0, -5)).sort();
  const stageShotsVersion = shotFiles.reduce((t, f) => Math.max(t, Math.floor(fs.statSync(path.join(stagesDir, f)).mtimeMs / 1000)), 0).toString(36);
  // the map's EntWatch items (world/items.js), so the stage list's heal option needs no entity data: picking a map
  // loads only its stage list, the rest waits for a stage (web/src/main.js)
  const read = (f) => { const q = path.join(mapsDir, name, f); return fs.existsSync(q) ? JSON.parse(fs.readFileSync(q, 'utf8')) : null; };
  const items = mapItems(read('entities.json'), read('entwatch.json'));
  maps.push({
    name, title: file.title || m.title || name, description: file.description || '', workshop: file.workshop || '',
    scenarios: list.length, parts, version: m.version, shots, items, stageShots, stageShotsVersion,
  });
}
fs.writeFileSync(path.join(mapsDir, 'index.json'), JSON.stringify({ maps }, null, 1));
console.log(`${maps.length} maps`);
