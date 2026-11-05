#!/usr/bin/env node
// Run every stage of a baked map headless, with you standing still at its spawn, and report what would break it:
//   - inputs aimed at a name nothing answers to (an entity that lives in a template lump the stage never spawns,
//     like ze_deadcore's d_nuke in d_temp), and the template that would spawn it
//   - classes and inputs the engine doesn't handle (its own log)
//   - what can't be drawn: a prop / visible entity whose model wasn't baked, a particle system whose effect, child
//     effect or C_OP_RenderModels model wasn't baked (ze_deadcore's escape platforms are env_particle_glows)
//   - the win: when it came with you idle at the spawn, and what hurt you before it (a free win is a broken stage)
//
//   node tools/audit-stages.mjs web/public/maps/ze_deadcore [--stage id] [--for s] [--all-misses]
//
//   --stage id      only that stage
//   --for s         seconds to run a stage with no winAfter (default 240; stops at the win)
//   --all-misses    also list names the map aims at that exist nowhere in it (the map's own dead outputs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMapEntities } from './map-entities.mjs';
import { normaliseHulls } from '../web/src/world/hulls.js';
import { CollisionWorld } from '../web/src/world/collision.js';
import { createRunEngine, startIfDue, mapRuns, winDue, TICK } from '../web/src/world/run-engine.js';
import { isParticleSystem } from '../web/src/world/entities/index.js';
import { nameKey } from '../web/src/lib/names.js';
import { assetKey } from '../web/src/lib/paths.js';

const argv = process.argv.slice(2);
const dir = argv[0];
if (!dir || dir.startsWith('--')) { console.error('usage: audit-stages.mjs <baked map dir> [--stage id] [--for s] [--all-misses]'); process.exit(2); }
const opt = (k, d) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
const allMisses = argv.includes('--all-misses');
const maxFor = Number(opt('--for', 240));

const map = path.basename(path.resolve(dir));
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const entities = readMapEntities(dir);
const { hulls, bounds } = normaliseHulls(fs.existsSync(path.join(dir, 'hulls.json')) ? read('hulls.json') : {});
const manifest = read('manifest.json');
const baked = new Set((manifest.renderModels || []).map(assetKey)); // ze__hell_p's model keys use backslashes
const fxIndex = fs.existsSync(path.join(dir, 'fx/index.json')) ? read('fx/index.json').systems || {} : {};
const colFile = path.join(dir, 'collision.bin');
let world = null;
if (fs.existsSync(colFile)) {
  const b = fs.readFileSync(colFile);
  world = new CollisionWorld(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public/scenarios');
const stages = JSON.parse(fs.readFileSync(path.join(root, `${map}.json`), 'utf8')).scenarios.filter((s) => !opt('--stage') || s.id === opt('--stage'));

// every name in the map, and the lump it lives in
const lumpOf = new Map();
for (const [lump, ents] of Object.entries(entities.lumps)) for (const d of ents) if (d.kv.targetname) {
  const k = nameKey(d.kv.targetname);
  if (!lumpOf.has(k)) lumpOf.set(k, lump);
}
// lump -> the point_templates that spawn it
const spawners = new Map();
for (const ents of Object.values(entities.lumps)) for (const d of ents) {
  if (String(d.kv.classname).toLowerCase() === 'point_template' && d.kv.entitylumpname) {
    const k = String(d.kv.entitylumpname);
    if (!spawners.has(k)) spawners.set(k, []);
    spawners.get(k).push(d.kv.targetname || '(unnamed)');
  }
}
const lumpKey = (l) => [...spawners.keys()].find((k) => k.toLowerCase() === String(l).toLowerCase()) ?? l;

// what an effect needs baked: itself, its children, the models it draws (memoised; fx json is the bake's)
const fxNeeds = new Map();
function effectProblems(name, seen = new Set()) {
  const key = String(name || '').toLowerCase();
  if (!key || seen.has(key)) return [];
  seen.add(key);
  if (fxNeeds.has(key)) return fxNeeds.get(key);
  const out = [];
  const file = Object.entries(fxIndex).find(([k]) => k.toLowerCase() === key)?.[1];
  if (!file) out.push(`effect not baked: ${name}`);
  else {
    const sys = JSON.parse(fs.readFileSync(path.join(dir, 'fx', file), 'utf8'));
    for (const r of sys.m_Renderers || []) {
      if (r?._class === 'C_OP_RenderModels') for (const m of r.m_ModelList || []) {
        if (m?.m_model && !baked.has(assetKey(m.m_model))) out.push(`model it draws not baked: ${m.m_model} (${name})`);
      }
    }
    for (const c of sys.m_Children || []) if (c?.m_ChildRef) out.push(...effectProblems(c.m_ChildRef, seen));
  }
  fxNeeds.set(key, out);
  return out;
}

// what render.js draws for an entity (addEntity) and whether its pieces are baked
const INVISIBLE_RENDER = new Set(['kRenderNone', '10']);
function drawProblems(e) {
  const kv = e.kv;
  if (isParticleSystem(e.cls)) return effectProblems(kv.effect_name);
  if (!kv.model || e.cls.startsWith('trigger_') || INVISIBLE_RENDER.has(String(kv.rendermode)) || kv.renderamt === '0') return [];
  const m = assetKey(kv.model);
  if (baked.has(m)) return [];
  // a prop always has a mesh; a brush entity without one is invisible in CS2 too (the bake leaves it out)
  if (e.cls.startsWith('prop_')) return [`model not baked: ${kv.model} (${e.cls})`];
  if (!hulls[m]) return [`model neither drawn nor solid: ${kv.model} (${e.cls})`];
  return [];
}

let bad = 0;
for (const sc of stages) {
  const misses = new Map(); // target key -> { input, count, first t }
  const draw = new Set();
  const killed = new Set();
  let spawn = null, won = null, run = null;
  const winNow = () => { if (run?.started) won ??= run.engine.time - run.startTime; };
  run = createRunEngine({
    entities, hulls, bounds, animations: null,
    traceBox: world ? (s, e, h) => world.traceBox(s, e, h, undefined, true) : null,
    scenario: sc, mode: 'normal', seed: 1, humans: 1, bossHp: 100,
    hooks: {
      attach(engine) {
        engine.player = { setHealth() {}, setMaxHealth() {}, setGravity() {}, setSpeed() {}, setVelocity() {}, setDamageFilter() {} };
        engine.on('spawn', (e) => { for (const p of drawProblems(e)) draw.add(p); });
        engine.on('kill', (e) => { if (e.key) killed.add(e.key); });
        const dispatch = engine.dispatch.bind(engine);
        engine.dispatch = (q) => {
          if (!q.fn && typeof q.target === 'string' && !engine.find(q.target, q.caller, q.activator).length) {
            const k = nameKey(q.target).replace(/\*$/, '');
            if (k && !k.startsWith('!') && !killed.has(k)) {
              const m = misses.get(k) || { input: q.input, n: 0, t: engine.time };
              m.n++;
              misses.set(k, m);
            }
          }
          return dispatch(q);
        };
      },
      place(s) { spawn = s.origin; },
      win: winNow,
    },
  });
  const { engine } = run;
  const logs = [];
  engine.on('log', (m) => logs.push(m));
  const at = spawn || [0, 0, 0];
  const player = { centre: () => [at[0], at[1], at[2] + 36], half: () => [16, 16, 36] };
  engine.playerMatrix = () => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1] });
  // you stand still and keep taking hits (no god mode, no death: the audit wants the whole stage), 100 HP
  let damage = 0, firstHurt = null, dead = null;
  const limit = (sc.winAfter || maxFor) + 5;
  let t = 0;
  for (let i = 0; i < Math.round((limit + 5) / TICK) && won == null; i++) {
    t += TICK;
    startIfDue(run, t);
    if (mapRuns(run)) engine.tick(TICK);
    for (const ev of engine.updateTriggers(player)) {
      if (ev.type === 'hurt' && run.started) {
        damage += ev.damage;
        firstHurt ??= { t: engine.time - run.startTime, by: ev.ent?.name || ev.ent?.cls };
        if (damage >= 100 && !dead) dead = { t: engine.time - run.startTime, by: ev.ent?.name || ev.ent?.cls };
      }
    }
    if (winDue(run, sc.winAfter)) winNow();
  }
  // a drill that ends on the clock must outlast its own attack: hurts that turn on after the win (laser2's altar
  // lasers fire 9.2 s after each spawn, past its old 8 s) mean the drill ends before it hurts anyone
  const late = new Map();
  if (won != null && sc.winAfter) {
    const winT = engine.time;
    const note = (e) => { if (e.cls === 'trigger_hurt' && engine.time > winT + 0.05) late.set(e.name || e.kv.model, engine.time - run.startTime); };
    engine.hookInput((e, input) => { if (String(input).toLowerCase() === 'enable') note(e); return false; });
    engine.on('spawn', (e) => { if (e.cls === 'trigger_hurt' && String(e.kv.startdisabled) !== 'true' && String(e.kv.StartDisabled) !== '1') note(e); });
    for (let i = 0; i < Math.round(10 / TICK); i++) engine.tick(TICK);
  }

  const templateMisses = [], deadMisses = [];
  for (const [k, m] of misses) {
    const lump = lumpOf.get(k);
    if (lump && lump !== 'default_ents') templateMisses.push(`${k}.${m.input} x${m.n} (from +${m.t.toFixed(1)} s): lives in lump ${lump}, spawned by ${(spawners.get(lumpKey(lump)) || ['nothing']).join(', ')}`);
    else deadMisses.push(`${k}.${m.input} x${m.n}`);
  }
  // standing still should lose a stage: a win you'd still be alive for is a free win
  const freeWin = won != null && (!dead || dead.t > won);
  const winNote = won == null ? `no win in ${limit} s idle` : `win input at ${won.toFixed(1)} s${freeWin ? ' FREE WIN (idle and alive)' : ''}`;
  const hurtNote = dead ? `idle dies at +${dead.t.toFixed(1)} s (${dead.by})` : firstHurt ? `idle survives (${Math.round(damage)} damage, first +${firstHurt.t.toFixed(1)} s by ${firstHurt.by})` : 'idle never hurt';
  const lateNotes = [...late].map(([n, at]) => `${n} turns on at +${at.toFixed(1)} s, after the ${sc.winAfter} s win`);
  const problems = lateNotes.length + templateMisses.length + draw.size + logs.filter((l) => /^unhandled/.test(l)).length + (freeWin ? 1 : 0);
  if (problems) bad++;
  console.log(`\n== ${sc.id} (${sc.name})${problems ? `  [${problems} to check]` : ''}`);
  console.log(`   ${winNote}; ${hurtNote}`);
  for (const l of lateNotes) console.log(`   ENDS TOO SOON   ${l}`);
  for (const l of templateMisses) console.log(`   MISSING ENTITY  ${l}`);
  for (const l of draw) console.log(`   NOT DRAWN       ${l}`);
  for (const l of logs) console.log(`   ENGINE          ${l}`);
  if (allMisses) for (const l of deadMisses) console.log(`   dead output     ${l}`);
}
console.log(`\n${stages.length} stages, ${bad} with something to check`);
