#!/usr/bin/env node
// Audit a baked map's falls: where a human who falls / gets swept ends up. Run it on every new map: a fall must put a
// human where the map puts humans (back on the platform, the human side of a team split) or kill them where the map
// does (a hurt, a zombie cage).
//
//   node tools/teleports.mjs <map dir>                     every trigger_teleport: filter, destination, verdict
//   node tools/teleports.mjs <map dir> --runtime           ... plus who retargets / moves them
//   node tools/teleports.mjs <map dir> --scenario all      replay each stage (start, fast-forward, setup), then drop a
//                                                          player from 5 points around its spawn
//   node tools/teleports.mjs <map dir> --drop x,y,z [--fire "t.Input(p)@d"]...   one drop from a point
//
// A drop is simulated: the player hull falls tick by tick through the map's triggers with the engine running, so
// it catches what the map really does: a trigger_teleport, a hurt whose OnStartTouch moves !activator
// (ze_gris_p's stage 4 boss: KeyValues(origin ...) back onto the platform), damage on the way, a zombie cage.
import fs from 'node:fs';
import path from 'node:path';
import { EntityEngine } from '../web/src/world/entities/index.js';
import { readMapEntities } from './map-entities.mjs';
import { zombieCages, filterPasses } from '../web/src/world/entities/classes/triggers.js';
import { normaliseHulls } from '../web/src/world/hulls.js';

const [dir, ...rest] = process.argv.slice(2);
if (!dir) { console.error('usage: teleports.mjs <baked map dir> [--runtime | --scenario <id|all> | --drop x,y,z [--fire t.Input(p)@d]...]'); process.exit(2); }
const opt = (k) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : null);
const entities = readMapEntities(dir); // with GFL's stripper edits, as the game loads it
const hullsFile = path.join(dir, 'hulls.json');
const { hulls, bounds } = normaliseHulls(fs.existsSync(hullsFile) ? JSON.parse(fs.readFileSync(hullsFile, 'utf8')) : {});
const strip = (n) => String(n || '').replace(/^\[PR#\]/i, '');
const fmt = (v) => v.map(Math.round).join(' ');
const TICK = 1 / 64;

const freshEngine = () => {
  const en = new EntityEngine(entities, { hulls, bounds }, { seed: 1 });
  en.player = { setHealth() {}, setMaxHealth() {}, setGravity() {}, setSpeed() {}, setVelocity() {}, setDamageFilter() {} };
  en.spawnWorld();
  return en;
};
const fire = (en, list, extraDelay = 0) => { for (const s of list) en.fire(s.target, s.input, s.param || '', (s.delay || 0) + extraDelay, en.playerEnt, null); };
const parseFire = (f) => {
  const m = /^(.+?)\.([A-Za-z_0-9]+)(?:\((.*)\))?(?:@([\d.]+))?$/.exec(f);
  if (!m) throw new Error(`bad --fire ${f}`);
  return { target: m[1], input: m[2], param: m[3] || '', delay: Number(m[4] || 0) };
};

if (opt('--scenario')) scenarioAudit(opt('--scenario'));
else if (opt('--drop')) {
  const en = freshEngine();
  fire(en, rest.flatMap((a, i) => (a === '--fire' ? [parseFire(rest[i + 1])] : [])));
  for (let i = 0; i < 64; i++) en.tick(TICK);
  console.log(drop(en, opt('--drop').split(',').map(Number)));
} else listTeleports();

// Fall from `start` (a player's feet) at 2048 u/s until something moves you or you pass -16384. Returns a line.
function drop(en, start) {
  const pos = [...start];
  let moved = null, hurt = 0;
  en.onTeleportPlayer = (o) => { moved ??= { to: o, by: 'the map (!activator origin)' }; };
  en.playerMatrix = () => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, pos[0], pos[1], pos[2], 1] });
  const player = { centre: () => [pos[0], pos[1], pos[2] + 36], half: () => [16, 16, 36] };
  for (let step = 0; step < 4000 && !moved && pos[2] > -16384; step++) {
    en.tick(TICK);
    if (moved) break;
    for (const ev of en.updateTriggers(player)) {
      if (ev.type === 'hurt') hurt += ev.damage;
      if (ev.type === 'teleport' && !moved) moved = { to: ev.origin, by: strip(ev.trigger?.name) || 'trigger_teleport', dest: ev.dest, cage: ev.cage };
    }
    pos[2] -= 32;
  }
  // a map origin move is dispatched on the next engine tick: give it a few
  for (let i = 0; i < 4 && !moved; i++) en.tick(TICK);
  const dmg = hurt ? `, ${Math.round(hurt)} damage on the way` : '';
  if (!moved) return `no teleport below: the void${dmg}`;
  const dist = Math.round(Math.hypot(moved.to[0] - start[0], moved.to[1] - start[1], moved.to[2] - start[2]));
  const where = moved.cage ? 'DIES: zombie cage' : dist < 4000 ? `back near (${dist}u)` : `FAR: ${dist}u away`;
  return `${moved.by} -> ${moved.dest ? strip(moved.dest.name) + ' @ ' : ''}${fmt(moved.to)}  [${where}${dmg}]`;
}

// --scenario <id|all>: replay each stage the way world/run-engine.js does, then drop from 5 points around its spawn
function scenarioAudit(which) {
  const map = path.basename(path.resolve(dir));
  const file = path.resolve(dir, '../../scenarios', `${map}.json`);
  const list = JSON.parse(fs.readFileSync(file, 'utf8')).scenarios.filter((s) => which === 'all' || s.id === which);
  for (const sc of list) {
    const lines = [];
    let sp = null;
    for (const [dx, dy] of [[0, 0], [800, 0], [-800, 0], [0, 800], [0, -800]]) {
      const en = freshEngine();
      fire(en, sc.start || [], sc.fastForward ? 0 : 1);
      for (let i = 0; i < Math.round(((sc.fastForward || 0) + 6) / TICK); i++) en.tick(TICK);
      sp ??= spawnOf(en, sc.spawn);
      fire(en, sc.setup || []);
      if (sc.player?.name) en.playerEnt.name = sc.player.name;
      en.tick(TICK);
      lines.push(`    from +${dx},${dy}: ${drop(en, [sp[0] + dx, sp[1] + dy, sp[2] + 8])}`);
    }
    console.log(`${sc.id}  spawn ${fmt(sp)}`);
    for (const l of lines) console.log(l);
  }
}

// world/run-engine.js spawnPoint's rules (spawn.at / spawn.on + offset / origin)
function spawnOf(en, spawn) {
  if (spawn?.at || spawn?.on) {
    const e = en.findOne(spawn.at || spawn.on);
    if (e) {
      const o = e.worldOrigin(), off = spawn.offset || [0, 0, 0];
      let z = o[2];
      if (spawn.on) { const hs = e.hulls(); if (hs?.length) z = Math.max(...hs.map((h) => h.max[2])); }
      return [o[0] + off[0], o[1] + off[1], z + off[2]];
    }
  }
  return spawn?.origin || [0, 0, 0];
}

// default: every trigger_teleport (templates spawned once too), its filter, destination and verdict
function listTeleports() {
  const engine = freshEngine();
  for (const t of [...(engine.byClass.get('point_template') || [])]) engine.spawnTemplate(t, t.getWorld(), null);
  const cages = zombieCages(engine);
  const all = Object.values(engine.lumps).flat();
  const movers = (name) => all.flatMap((d) => (d.io || [])
    .filter((c) => strip(c.target).toLowerCase() === name.toLowerCase() && /^(keyvalues?|addoutput|setparent|enable|disable)$/i.test(c.input))
    .map((c) => `${strip(d.kv.targetname) || d.kv.classname}.${c.output} -> ${c.input}(${c.param})${c.delay ? ` @${c.delay}s` : ''}`));
  const rows = [...(engine.byClass.get('trigger_teleport') || [])];
  let human = 0, cageHits = 0;
  for (const e of rows) {
    const pass = filterPasses(engine, e.kv.filtername);
    const dest = engine.findOne(e.kv.target);
    const cage = !!dest && cages.has(dest.key);
    if (pass) human++;
    if (pass && cage) cageHits++;
    const verdict = !pass ? 'not for humans' : !dest ? 'NO DESTINATION' : cage ? 'HUMAN DIES (zombie cage)' : 'human teleported';
    console.log(`${strip(e.name) || '(unnamed)'}  filter=${strip(e.kv.filtername) || 'none'}  ${e.enabled ? 'on' : 'off'}  -> ${strip(e.kv.target)}${dest ? ` @ ${fmt(dest.worldOrigin())}` : ''}  [${verdict}]`);
    if (rest.includes('--runtime')) for (const m of [...movers(strip(e.name)), ...(dest ? movers(strip(dest.name)) : [])].slice(0, 6)) console.log(`      ${m}`);
  }
  console.log(`\n${rows.length} trigger_teleports, ${human} take humans, ${cageHits} of those end in a zombie cage`);
  console.log(`zombie cages: ${[...cages].join(', ') || '(none)'}`);
  console.log('(a cage verdict here is the teleport alone; whether a fall reaches it: --drop / --scenario)');
}
