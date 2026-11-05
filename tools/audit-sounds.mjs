#!/usr/bin/env node
// Run every stage of a baked map headless (you standing at its spawn, as audit-stages.mjs) and report what its
// sounds would do, so a map's audio problems show up at bake time:
//   - requests no table defines (silent in CS2 too: worth checking the name), events with no playable file
//   - stacks: the most voices of one event started on one tick after CS2's block / instance-limit rules
//     (audio/limits.js). ze__hell_p's spikes start 8-12 Rod.crystal at once; audio/mixglue.js (CS2's final-mix
//     compressor) keeps such stacks from clipping, so a stack is only a note unless it is very large
//   - the music it plays (csgo_music events) and when, from the stage's start
//   - peak live voices (a voice lives its event's duration, a loop until stopped), and each event's mixer level
//
//   node tools/audit-sounds.mjs web/public/maps/ze_mist_p [--stage id] [--for 240]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMapEntities } from './map-entities.mjs';
import { normaliseHulls } from '../web/src/world/hulls.js';
import { CollisionWorld } from '../web/src/world/collision.js';
import { createRunEngine, startIfDue, mapRuns, winDue, TICK } from '../web/src/world/run-engine.js';
import { VoiceLimits } from '../web/src/audio/limits.js';
import { mixVolume } from '../web/src/audio/mix.js';

const argv = process.argv.slice(2);
const dir = argv[0];
if (!dir || dir.startsWith('--')) { console.error('usage: audit-sounds.mjs <baked map dir> [--stage id] [--for s]'); process.exit(2); }
const opt = (k, d) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
const map = path.basename(path.resolve(dir));
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const here = path.dirname(fileURLToPath(import.meta.url));
const table = (f) => new Map(Object.entries(fs.existsSync(f) ? read(f) : {}).map(([n, d]) => [n.toLowerCase(), { ...d, name: n }]));
const mapTable = table(path.join(dir, 'soundevents.json'));
const stockTable = table(path.join(here, '../web/public/sounds/soundevents.json'));
const lookup = (name) => mapTable.get(String(name).toLowerCase()) || stockTable.get(String(name).toLowerCase()) || null;

const entities = readMapEntities(dir);
const { hulls, bounds } = normaliseHulls(fs.existsSync(path.join(dir, 'hulls.json')) ? read(path.join(dir, 'hulls.json')) : {});
const colFile = path.join(dir, 'collision.bin');
let world = null;
if (fs.existsSync(colFile)) {
  const b = fs.readFileSync(colFile);
  world = new CollisionWorld(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}
const stages = read(path.join(here, '../web/public/scenarios', `${map}.json`)).scenarios.filter((s) => !opt('--stage') || s.id === opt('--stage'));
const maxFor = Number(opt('--for', 240));

const noFiles = [...mapTable.values()].filter((d) => !(d.files || []).length && !(d.children || []).length).map((d) => d.name);
console.log(`${map}: ${mapTable.size} map events${noFiles.length ? `, ${noFiles.length} with no playable file: ${noFiles.join(', ')}` : ''}`);

for (const sc of stages) {
  const unknown = new Map(), stacks = new Map(), used = new Map(), music = [];
  const limits = new VoiceLimits();
  const live = []; // { def, ent, slot, until }
  let peak = 0, peakAt = 0, tickStarts = new Map(), tickAt = -1, spawn = null, won = null, run = null;
  run = createRunEngine({
    entities, hulls, bounds, animations: null,
    traceBox: world ? (s, e, h) => world.traceBox(s, e, h, undefined, true) : null,
    scenario: sc, mode: 'normal', seed: 1, humans: 1, bossHp: 100,
    hooks: {
      attach(engine) {
        engine.player = { setHealth() {}, setMaxHealth() {}, setGravity() {}, setSpeed() {}, setVelocity() {}, setDamageFilter() {} };
        engine.on('sound', (ev) => {
          const now = engine.time;
          if (ev.type === 'stop') {
            for (const v of live) if (v.ent === ev.ent && (ev.slot == null || v.slot === ev.slot)) v.until = Math.min(v.until, now);
            return;
          }
          if (ev.type !== 'start' || !ev.name) return;
          const def = lookup(ev.name);
          if (!def) { unknown.set(ev.name, (unknown.get(ev.name) || 0) + 1); return; }
          const pos = ev.ent?.worldOrigin?.();
          if (!limits.allow({ ...def, name: def.name }, { entId: ev.ent?.id, pos }, now)) return;
          const same = live.filter((v) => v.def === def && v.ent === ev.ent && v.until > now);
          const lim = def.instanceLimit | 0;
          if (lim > 0) for (const v of same.slice(0, Math.max(0, same.length - lim + 1))) v.until = now;
          used.set(def.name, def);
          if (/music/.test(def.type || '') && music.length < 12) music.push(`${def.name} +${(now - (run?.startTime ?? 0)).toFixed(1)}`);
          live.push({ def, ent: ev.ent, slot: ev.slot ?? null, until: def.loop || ev.repeat ? Infinity : now + (def.duration || 1) });
          if (tickAt !== now) { tickAt = now; tickStarts = new Map(); }
          const n = (tickStarts.get(def.name) || 0) + 1;
          tickStarts.set(def.name, n);
          const s = stacks.get(def.name);
          if (!s || n > s.n) stacks.set(def.name, { n, t: now - (run?.startTime ?? 0) });
        });
      },
      place(s) { spawn = s.origin; },
      win() { if (run?.started) won ??= run.engine.time - run.startTime; },
    },
  });
  const { engine } = run;
  const at = spawn || [0, 0, 0];
  engine.playerMatrix = () => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1] });
  const player = { centre: () => [at[0], at[1], at[2] + 36], half: () => [16, 16, 36] };
  const limit = (sc.winAfter || maxFor) + 5;
  let t = 0;
  for (let i = 0; i < Math.round(limit / TICK) && won == null; i++) {
    t += TICK;
    startIfDue(run, t);
    if (mapRuns(run)) engine.tick(TICK);
    engine.updateTriggers(player);
    if (winDue(run, sc.winAfter)) won ??= engine.time;
    const now = engine.time;
    for (let k = live.length - 1; k >= 0; k--) if (live[k].until <= now || live[k].ent?.alive === false && !live[k].def.loop) live.splice(k, 1);
    if (live.length > peak) { peak = live.length; peakAt = now - (run.startTime ?? 0); }
  }
  const big = [...stacks].filter(([, s]) => s.n >= 4).sort((a, b) => b[1].n - a[1].n);
  console.log(`\n== ${sc.id}: ${used.size} events played, peak ${peak} live voices (+${peakAt.toFixed(1)} s)`);
  console.log(`   music      ${music.length ? music.join(', ') : 'none'}`);
  for (const [n, s] of big) console.log(`   STACK      ${n} x${s.n} on one tick (+${s.t.toFixed(1)} s), mixer ${mixVolume(used.get(n)).toFixed(2)}`);
  for (const [n, c] of unknown) console.log(`   UNKNOWN    ${n} (requested ${c}x): no table defines it, silent`);
}
