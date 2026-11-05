#!/usr/bin/env node
// Run a baked map's own entity logic headless (the browser's EntityEngine, no rendering, no player physics) and
// print what happens. The tool for checking a scenario's start inputs before trying it in the browser.
//
//   node tools/sim.mjs web/public/maps/ze_deadcore --scenario a_boss --for 60 --watch "boss|hurt"
//   node tools/sim.mjs web/public/maps/ze_deadcore --fire "stage_a_relay.Trigger" --fire "a_temp.ForceSpawn@0.5" --for 30
//
//   --scenario <id>   fire that scenario's `start` (web/public/scenarios/<map>.json)
//   --fire t.Input[(param)][@delay]   fire an input (repeatable)
//   --for <s>         seconds to run (default 30)
//   --watch <regex>   print spawns, kills and inputs of entities whose name or class matches
//   --track <regex>   print where matching entities are every 0.5 s
//   --player x,y,z    stand the player hull here (touch triggers, e.g. to wake a mini boss)
//   --humans <n>      simulated humans (boss HP adds), default 1
//   --seed <n>        logic_case random seed
// Prints the engine's log (unknown inputs / classes, once each), then a class census of what spawned.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EntityEngine } from '../web/src/world/entities/index.js';
import { normaliseHulls } from '../web/src/world/hulls.js';
import { CollisionWorld } from '../web/src/world/collision.js';

const argv = process.argv.slice(2);
const dir = argv[0];
if (!dir || dir.startsWith('--')) { console.error('usage: sim.mjs <baked map dir> [--scenario id] [--fire t.Input(p)@d]... [--for s] [--watch re]'); process.exit(2); }
const opt = (k, d) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
const fires = argv.flatMap((a, i) => (a === '--fire' ? [argv[i + 1]] : []));
const seconds = Number(opt('--for', 30));
const watch = opt('--watch') ? new RegExp(opt('--watch'), 'i') : null;

const map = path.basename(path.resolve(dir));
const entities = JSON.parse(fs.readFileSync(path.join(dir, 'entities.json'), 'utf8'));
const hullsFile = path.join(dir, 'hulls.json');
const { hulls, bounds } = normaliseHulls(fs.existsSync(hullsFile) ? JSON.parse(fs.readFileSync(hullsFile, 'utf8')) : {});
const engine = new EntityEngine(entities, { hulls, bounds }, { seed: Number(opt('--seed', 1)) });
engine.humans = Number(opt('--humans', 1));
// the static world, so physboxes (classes/physics.js) fall and slide as they do in the browser
const colFile = path.join(dir, 'collision.bin');
if (fs.existsSync(colFile)) {
  const b = fs.readFileSync(colFile);
  const world = new CollisionWorld(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
  engine.traceBox = (s, e, h) => world.traceBox(s, e, h, undefined, true);
}
engine.onTeleportPlayer = (o) => say(`teleport player -> ${o.map((v) => Math.round(v)).join(' ')}`);
engine.player = { setHealth() {}, setMaxHealth() {}, setGravity: (g) => say(`player gravity ${g}`), setSpeed() {}, setVelocity() {}, setDamageFilter() {} };

const say = (m) => console.log(`${engine.time.toFixed(2).padStart(7)}  ${m}`);
const label = (e) => `${e.cls} ${e.name || '(unnamed)'}`;
const census = new Map();
engine.on('log', (m) => say(`LOG ${m}`));
engine.on('spawn', (e) => {
  census.set(e.cls, (census.get(e.cls) || 0) + 1);
  if (watch && (watch.test(e.name || '') || watch.test(e.cls))) {
    const o = e.worldOrigin?.() || [];
    say(`spawn ${label(e)} @ ${[...o].map((v) => Math.round(v)).join(' ')}`);
  }
});
engine.on('kill', (e) => { if (watch && (watch.test(e.name || '') || watch.test(e.cls))) say(`kill  ${label(e)}`); });
if (watch) engine.hookInput((e, input) => { if (watch.test(e.name || '') || watch.test(e.cls)) say(`  -> ${label(e)}.${input}`); return false; });

engine.spawnWorld();
const start = [];
if (opt('--scenario')) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public/scenarios');
  const sc = JSON.parse(fs.readFileSync(path.join(root, `${map}.json`), 'utf8')).scenarios.find((s) => s.id === opt('--scenario'));
  if (!sc) { console.error(`no scenario ${opt('--scenario')}`); process.exit(2); }
  start.push(...(sc.start || []));
}
for (const f of fires) {
  const m = /^(.+?)\.([A-Za-z_0-9]+)(?:\((.*)\))?(?:@([\d.]+))?$/.exec(f);
  if (!m) { console.error(`bad --fire ${f}`); process.exit(2); }
  start.push({ target: m[1], input: m[2], param: m[3] || '', delay: Number(m[4] || 0) });
}
for (const s of start) engine.fire(s.target, s.input, s.param || '', s.delay || 0, engine.playerEnt, null);

const TICK = 1 / 64;
const track = opt('--track') ? new RegExp(opt('--track'), 'i') : null;
const at = opt('--player') ? opt('--player').split(',').map(Number) : null;
// a standing CS2 player hull (32 x 32 x 72) whose origin is at its feet
const player = at && { centre: () => [at[0], at[1], at[2] + 36], half: () => [16, 16, 36] };
// where "!player" / "!activator" is for spawns and SetParent (column-major, translation only)
if (at) engine.playerMatrix = () => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1] });
for (let i = 0; i < Math.round(seconds / TICK); i++) {
  engine.tick(TICK);
  if (player) for (const ev of engine.updateTriggers(player)) if (ev.type !== 'push') say(`player event ${ev.type}${ev.damage != null ? ' ' + ev.damage : ''}`);
  if (track && i % 32 === 0) {
    for (const e of engine.ents) if (e.alive && track.test(e.name || '')) say(`track ${e.name} @ ${e.worldOrigin().map((v) => Math.round(v)).join(' ')}`);
  }
}

const alive = new Map();
for (const e of engine.ents) if (e.alive) alive.set(e.cls, (alive.get(e.cls) || 0) + 1);
console.log(`\nspawned (alive at ${seconds}s):`);
for (const [k, v] of [...census].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v} (${alive.get(k) || 0})`);
