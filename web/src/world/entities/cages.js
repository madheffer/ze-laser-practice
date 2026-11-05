// Zombie cages: teleport destinations where the map keeps zombies and a human has nothing left to do. A human the
// map sends into one (a straggler sweep, an AFK teleport, a fall catch) is infected there on a server: the session
// counts it as a death (classes/triggers.js puts `cage` on the teleport event; app/loop.js and server/coop-check.js
// end the human's run; the killfeed shows it as the map's kill).
//
// Read from the map's own wiring, once per engine, from the entity lumps (templates placed where their point_template
// is), so it is the same whenever it is first asked and identical on the co-op server. A destination D is a cage when
//   1. the map sends zombies there: a zombie-only trigger_teleport aims at D (its target, or a runtime
//      "KeyValue/AddOutput target D", wildcards too: westersand's Map_Teleport retargets Teleport_*), and
//   2. it is a place, not a checkpoint the map moves with the stage (KeyValue origin / SetParent on it: deadcore's
//      des1-des5 follow every part, both teams use them), and the map never sends humans there itself: no
//      human-only trigger_teleport aims at D, and
//   3. D is the zombies' side, by one of
//      split  the map sorts players by team there: a teleport into D shares its volume with a human-only trigger
//             that moves humans elsewhere (mist tp_dragonfall_t / _ct, dreamin rtv_zteleport_2 / rtv_teleport_1 and
//             defense_back, visualizer p2_s6_teleport_zm_attack_end / p2_s6_teleport_bossroom)
//      logic  the map's own logic where you land is for a holding room: a zombie-only trigger (westersand's
//             Boss_ZM_Immunity), or a hurt for humans (the airship's Guard_Boss_Hurt_ZmJail), no wider than a room
//      held   you land against bars or a floor the map takes away later (a func_wall_toggle / breakable / brush it
//             kills, breaks, toggles or disables: mist br_zombiecage, westersand Boss_Cage_Floor), unless the map
//             also keeps humans there (a human-only trigger that isn't a hurt where you land, or an unfiltered fall
//             catch under D that puts everyone back on it: visualizer's stage 4 ending platform)
// At the teleport (strandsHuman) a cage only strands you if nothing takes you on from it right then (an enabled
// teleport for players covering where you land: a spawn room's exit) and the map isn't already moving you.
// A scenario can override a destination the data can't decide: "cages": { "<destination>": true | false }.
import * as THREE from 'three';
import { assetKey } from '../../lib/paths.js';
import { nameKey, nameMatches } from '../../lib/names.js';
import { parseVec, angleQuat, poseMatrix, num } from './math.js';
import { filterPasses } from './classes/triggers.js';

const SHARE_OF_SMALLER = 0.5; // split: the overlap is at least half of the smaller volume...
const SHARE_OF_LARGER = 0.05; // ...and not a speck of a map-wide sweep
const HELD_GAP = 64; // held: the bars / floor are within this of the player standing at D
const ROOM = 1024; // logic: a holding room's own trigger is at most this wide (x and y)
const HULL = { half: 16, height: 72 };
const CHECKPOINT = 1024; // a destination the map moves further than this follows the stage
const REMOVES = /^(kill|killhierarchy|break|toggle|disable)$/i;
const BARRIER = /^func_(wall_toggle|breakable|brush)$/;
const ROUTERS = /^trigger_(teleport|multiple|once)$/;

export function zombieCages(engine) {
  if (engine._cages) return engine._cages;
  const view = mapView(engine);
  const cages = new Set();
  for (const d of view.zombieDestinations) if (cageEvidence(view, d).cage) cages.add(d);
  const over = engine.cageOverrides;
  if (over && typeof over === 'object') {
    for (const [name, on] of Object.entries(over)) if (on === true) cages.add(nameKey(name)); else if (on === false) cages.delete(nameKey(name));
  }
  engine._cages = cages;
  return cages;
}

// Does this teleport strand a human? D is a cage and, right now, nothing takes a human on from it: no enabled
// trigger_teleport that lets the player through covers where you land and sends you elsewhere (westersand's spawn:
// Teleport_Airport forwards whoever is in it to the current checkpoint while the map has it on). A cage whose way out
// the map only opens later is a softlock: you wait there with the zombies.
export function strandsHuman(engine, dest) {
  if (!dest || !zombieCages(engine).has(dest.key) || mapMovesPlayer(engine)) return false;
  const o = dest.worldOrigin();
  const land = { mn: [o[0] - HULL.half, o[1] - HULL.half, o[2]], mx: [o[0] + HULL.half, o[1] + HULL.half, o[2] + HULL.height] };
  for (const t of engine.byClass.get('trigger_teleport') || []) {
    if (!t.enabled || !(num(t.kv.spawnflags) & 1) || !t.kv.target || nameKey(t.kv.target) === dest.key || !engine.passesFilter(t)) continue;
    if ((t.hulls() || []).some((h) => overlaps({ mn: h.min, mx: h.max }, land))) return false;
  }
  return true;
}

// Is the map already putting you somewhere else? A fall hurt that rescues humans (dreamin's arena: 200 and
// rtv_teleport_case puts you back in a corner; gris's stage 4 boss: KeyValues origin) fires as you pass it, often on
// the same tick as the catch-all teleport under it: a move of you queued in the I/O (directly, or one relay / case
// away) wins over the cage, as it does a tick later in the game.
const RESCUE_WINDOW = 0.5;
const movesYou = (c) => (/^!(activator|player)$/i.test(c.target) && /^keyvalues?$/i.test(c.input) && /\borigin\b/i.test(c.param || '')) || /^teleport$/i.test(c.input);
function mapMovesPlayer(engine) {
  const you = engine.playerEnt;
  return engine.queue.some((q) => {
    if (q.fn || q.t > engine.time + RESCUE_WINDOW || (q.activator !== you && !/^!player$/i.test(String(q.target)))) return false;
    if (movesYou(q)) return true;
    const hop = (pattern, depth) => typeof pattern === 'string' && !pattern.startsWith('!')
      && engine.find(pattern, q.caller, q.activator).some((e) => e.io.some((c) => movesYou(c) || (depth > 0 && hop(c.target, depth - 1))));
    return hop(q.target, 1);
  });
}

// The verdict for one destination with its evidence (tools/cages.mjs prints these).
export function cageEvidence(view, dest) {
  const into = view.teleports.filter((t) => t.targets.has(dest));
  const out = { dest, into, cage: false, why: [] };
  if (!into.some((t) => t.team === 'Z')) return out;
  const at = view.place(dest);
  if (!at) { out.why.push('no destination entity'); return out; }
  // moved somewhere else (a nudge of a few units is the same place: gris's ring relay lifts its spot 36 u)
  const moved = (view.movers.get(dest) || []).find((m) => !m.to || Math.hypot(m.to[0] - at[0], m.to[1] - at[1], m.to[2] - at[2]) > CHECKPOINT);
  if (moved) { out.why.push(`checkpoint: the map moves D with the stage (${moved.by}), so it is wherever the stage is`); return out; }
  const humanSent = into.filter((t) => t.team === 'H');
  if (humanSent.length) { out.why.push(`humans sent by ${humanSent.map(label).join(', ')}`); return out; }
  const land = { mn: [at[0] - HULL.half, at[1] - HULL.half, at[2]], mx: [at[0] + HULL.half, at[1] + HULL.half, at[2] + HULL.height] };
  const landing = view.triggers.filter((t) => t.box && overlaps(t.box, land));

  // a sort is a fixed pair: the teleport's own target is D (not a checkpoint sweep the map retargets everywhere), and
  // the humans' trigger doesn't also cover D (then D is where the humans are: visualizer's boss room)
  for (const t of into) {
    if (t.team === 'H' || !t.box || nameKey(t.kv.target) !== dest) continue;
    for (const r of view.humanRouters) {
      if (r === t || !r.box || r.targets?.has(dest) || overlaps(r.box, land) || !shares(r.box, t.box)) continue;
      out.why.push(`split: ${label(t)} into D shares its volume with ${label(r)}, which moves humans elsewhere`);
    }
  }
  for (const t of landing) {
    const roomSized = t.box.mx[0] - t.box.mn[0] <= ROOM && t.box.mx[1] - t.box.mn[1] <= ROOM;
    if (roomSized && t.cls !== 'trigger_teleport' && (t.team === 'Z' || (t.team === 'H' && t.cls === 'trigger_hurt'))) out.why.push(`logic: ${label(t)} where you land`);
  }
  const bars = view.barriers.filter((b) => gap(b.box, land) <= HELD_GAP);
  if (bars.length) {
    const humanLogic = landing.find((t) => t.team === 'H' && t.cls !== 'trigger_hurt' && t.cls !== 'trigger_teleport');
    const catchBack = into.find((t) => t.team === 'any' && t.box && under(t.box, at));
    if (humanLogic) out.why.push(`(not held: humans' ${label(humanLogic)} is where you land)`);
    else if (catchBack) out.why.push(`(not held: ${label(catchBack)} catches anyone falling off D and puts them back)`);
    else out.why.push(`held: ${bars.map((b) => `${b.name} [${b.cls}] ${Math.round(gap(b.box, land))} u`).join(', ')}, removed later by the map`);
  }
  out.cage = out.why.some((w) => /^(split|logic|held):/.test(w));
  return out;
}

const label = (t) => `${t.name || '(unnamed)'} (${t.cls}, ${t.team === 'H' ? 'humans' : t.team === 'Z' ? 'zombies' : t.team})`;

// The lumps as static boxes and teams, built once per engine.
export function mapView(engine) {
  if (engine._mapView) return engine._mapView;
  const ents = [];
  const tplPose = new Map(); // template lump -> its point_template's pose
  for (const ds of Object.values(engine.lumps)) for (const d of ds) {
    if (String(d.kv.classname).toLowerCase() === 'point_template' && d.kv.entitylumpname) {
      const k = String(d.kv.entitylumpname).toLowerCase();
      if (!tplPose.has(k)) tplPose.set(k, pose(d.kv));
    }
  }
  for (const [lump, ds] of Object.entries(engine.lumps)) {
    const tpl = engine.templateLumps.has(lump) ? tplPose.get(lump.toLowerCase()) : null;
    if (engine.templateLumps.has(lump) && !tpl) continue; // a template nothing spawns
    for (const d of ds) {
      const m = pose(d.kv);
      if (tpl) m.premultiply(tpl);
      ents.push({ kv: d.kv, io: d.io || [], cls: String(d.kv.classname || '').toLowerCase(), name: String(d.kv.targetname || ''), key: nameKey(d.kv.targetname), m, box: worldBox(engine.assets, d.kv.model, m) });
    }
  }
  const filters = ents.filter((e) => e.cls.startsWith('filter_'));
  const teamOf = (fname) => {
    if (!fname) return 'any';
    const pass = (team) => filterPasses({ findOne: (n) => filters.find((f) => nameMatches(n, f.name)) || null, playerEnt: { team, name: '', contexts: new Set() } }, fname);
    const h = pass(3), z = pass(2);
    return h && z ? 'any' : h ? 'H' : z ? 'Z' : 'none';
  };
  const retargets = []; // KeyValue/AddOutput "target X": [pattern, X]
  const removed = []; // names the map kills / breaks / toggles / disables
  const movers = new Map(); // destination -> who moves it (KeyValue origin / SetParent)
  for (const e of ents) for (const c of e.io) {
    if ((/^(keyvalue|keyvalues|addoutput)$/i.test(c.input) && /^\s*origin\b/i.test(c.param || '')) || /^setparent$/i.test(c.input)) {
      const k = nameKey(c.target);
      if (!movers.has(k)) movers.set(k, []);
      const to = /^setparent$/i.test(c.input) ? null : parseVec(String(c.param).replace(/^\s*origin/i, ''));
      movers.get(k).push({ to, by: `${e.name || e.cls}.${c.output} -> ${c.input}(${c.param || ''})` });
    }
    const t = /^\s*target\s+(\S+)/i.exec(c.param || '');
    if (t && /^(keyvalue|addoutput)$/i.test(c.input)) retargets.push([c.target, nameKey(t[1])]);
    if (REMOVES.test(c.input)) removed.push(c.target);
  }
  const triggers = ents.filter((e) => e.cls.startsWith('trigger_')).map((e) => Object.assign(e, { team: teamOf(e.kv.filtername) }));
  const teleports = triggers.filter((e) => e.cls === 'trigger_teleport');
  for (const t of teleports) t.targets = new Set([nameKey(t.kv.target), ...retargets.filter(([p]) => nameMatches(p, t.name)).map(([, x]) => x)].filter(Boolean));
  const outputsOf = (pattern) => ents.filter((e) => e.name && nameMatches(pattern, e.name)).flatMap((e) => e.io);
  const movesHumans = (e) => e.cls === 'trigger_teleport' ? e.targets.size > 0 : e.io.some((c) => movesYou(c) || (!/^!/.test(c.target) && outputsOf(c.target).some(movesYou)));
  const view = {
    triggers, teleports, movers,
    humanRouters: triggers.filter((e) => e.team === 'H' && ROUTERS.test(e.cls) && movesHumans(e)),
    barriers: ents.filter((e) => BARRIER.test(e.cls) && e.box && e.name && removed.some((p) => nameMatches(p, e.name))),
    zombieDestinations: new Set(teleports.filter((t) => t.team === 'Z').flatMap((t) => [...t.targets])),
    place: (key) => { const d = ents.find((e) => e.key === key && !e.cls.startsWith('trigger_')); return d ? [d.m.elements[12], d.m.elements[13], d.m.elements[14]] : null; },
  };
  engine._mapView = view;
  return view;
}

const pose = (kv) => poseMatrix(parseVec(kv.origin), angleQuat(parseVec(kv.angles)));

function worldBox(assets, model, m) {
  const k = assetKey(model || '');
  const b = k && assets?.bounds?.[k];
  if (!b) return null;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]).applyMatrix4(m);
    for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], v.getComponent(a)); mx[a] = Math.max(mx[a], v.getComponent(a)); }
  }
  return { mn, mx };
}

const volume = (b) => b.mx.reduce((p, v, i) => p * Math.max(0, v - b.mn[i]), 1);
const intersect = (a, b) => ({ mn: a.mn.map((v, i) => Math.max(v, b.mn[i])), mx: a.mx.map((v, i) => Math.min(v, b.mx[i])) });
const overlaps = (a, b) => [0, 1, 2].every((i) => a.mn[i] <= b.mx[i] && b.mn[i] <= a.mx[i]);
const gap = (a, b) => Math.hypot(...[0, 1, 2].map((i) => Math.max(a.mn[i] - b.mx[i], 0, b.mn[i] - a.mx[i])));
// a fall catch: D stands over the volume's footprint, above its top
const under = (b, p) => p[0] >= b.mn[0] && p[0] <= b.mx[0] && p[1] >= b.mn[1] && p[1] <= b.mx[1] && b.mx[2] <= p[2] + 8;
function shares(a, b) {
  const i = volume(intersect(a, b)), va = volume(a), vb = volume(b);
  return i > 0 && i >= SHARE_OF_SMALLER * Math.min(va, vb) && i >= SHARE_OF_LARGER * Math.max(va, vb);
}
