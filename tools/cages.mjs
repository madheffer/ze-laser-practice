#!/usr/bin/env node
// Zombie-cage audit: every teleport destination of a baked map, who the map sends there (by team), and the verdict
// of world/entities/cages.js (cage = a human sent there dies) with its evidence. Run it on every new map, and add a
// scenario "cages" override only where the evidence is wrong (README "Falls").
//
//   node tools/cages.mjs web/public/maps/ze_mist_p            one map
//   node tools/cages.mjs web/public/maps                      every baked map
//   node tools/cages.mjs web/public/maps/ze_mist_p --all      also destinations no zombie-only teleport aims at
import fs from 'node:fs';
import path from 'node:path';
import { EntityEngine } from '../web/src/world/entities/index.js';
import { readMapEntities } from './map-entities.mjs';
import { mapView, cageEvidence, zombieCages } from '../web/src/world/entities/cages.js';
import { normaliseHulls } from '../web/src/world/hulls.js';

const [target, ...rest] = process.argv.slice(2);
if (!target) { console.error('usage: cages.mjs <baked map dir | maps dir> [--all]'); process.exit(2); }
const root = path.resolve(target);
const dirs = fs.existsSync(path.join(root, 'entities.json')) ? [root]
  : fs.readdirSync(root).map((d) => path.join(root, d)).filter((d) => fs.existsSync(path.join(d, 'entities.json')));
const team = (t) => (t === 'H' ? 'humans' : t === 'Z' ? 'zombies' : t);

for (const dir of dirs) {
  const hf = path.join(dir, 'hulls.json');
  const { hulls, bounds } = normaliseHulls(fs.existsSync(hf) ? JSON.parse(fs.readFileSync(hf, 'utf8')) : {});
  const engine = new EntityEngine(readMapEntities(dir), { hulls, bounds }, { seed: 1 });
  const view = mapView(engine);
  const cages = zombieCages(engine);
  const dests = [...new Set(view.teleports.flatMap((t) => [...t.targets]))].filter((d) => rest.includes('--all') || view.zombieDestinations.has(d)).sort();
  console.log(`\n== ${path.basename(dir)}: ${cages.size} cage(s): ${[...cages].join(', ') || '(none)'}`);
  for (const d of dests) {
    const ev = cageEvidence(view, d);
    const from = ev.into.map((t) => `${t.name || '(unnamed)'}[${team(t.team)}${t.kv.startdisabled === '1' || t.kv.startdisabled === 'true' ? ', off' : ''}]`);
    console.log(`  ${cages.has(d) ? 'CAGE    ' : 'not cage'}  ${d}  <- ${from.join(' ')}`);
    for (const w of new Set(ev.why)) console.log(`              ${w}`);
  }
}
