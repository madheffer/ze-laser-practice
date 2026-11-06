// The map's physics entities on CS2's own physics (world/physics-world.js, the WebAssembly build of rubikon/): what
// physics.js does when the run has a physics world (engine.physics). rubikon/CS2_RUNTIME.md has every address.
//   - the step (physicsStep) runs as CS2's CPhysicsGameSystem does, after the entities think and the I/O queue
//     (CSource2Server::GameFrame 180dd4970: think pass, ServiceEvents, then the post-think event -> OnSimulate):
//     PullKinematicTransforms (keyframed bodies to their entities), the world's tick, PushDynamicTransforms (each
//     unparented entity to its dynamic body)
//   - func_physbox: a body from the bake's physics.bin, spawned as CS2's CPhysBox spawns it (rubikon/src/Game/PhysBox.cs).
//     Its motion as the node's apply (FUN_180cb69b0) decides it: with a parent that has a skeleton instance (a model
//     entity) one body is keyframed and follows the hierarchy; otherwise its own motion type (1, or 3 after
//     DisableMotion). A parented entity is never moved by its body (PushDynamicTransforms skips m_nHierarchyType != 0)
//   - phys_thruster / phys_keepupright: motion controllers on the attach1 body (Thruster.cs, KeepUpright.cs), made once
//     the body exists (a template spawns them together); the thruster's inputs act when they fire, its forcetime stop
//     is a think at the tick SetNextThink rounds to
//   - brush and prop entities whose class makes physics (BrushPhysics.cs; not func_train): keyframed bodies driven to
//     the entity's transform every tick, so physboxes meet what the map moves
// NOT PORTED: the player as a physics obstacle (CS2's player shadow): physboxes do not feel players, players collide
// with physboxes as solids.
import * as THREE from 'three';
import { C } from '../registry.js';
import { num, parseVec, angleQuat, DEG } from '../math.js';
import { physicsTouches } from './physics-touch.js';

const POS = new THREE.Vector3(), QUAT = new THREE.Quaternion(), SCALE = new THREE.Vector3(), MAT = new THREE.Matrix4();
const ONE = new THREE.Vector3(1, 1, 1);

// the physics.bin key of an entity's model (bake/RubikonBake.cs: the model path, lowercased)
const modelKey = (e) => String(e.kv.model || '').toLowerCase().replace(/\\/g, '/');

function frame(e) {
  e.getWorld().decompose(POS, QUAT, SCALE);
  return { pos: [POS.x, POS.y, POS.z], quat: QUAT.clone() };
}

// QAngle (pitch, yaw, roll) of a rotation matrix: forward its x column, left y, up z
function angles(m) {
  const el = m.elements;
  const fx = el[0], fy = el[1], fz = el[2];
  const pitch = Math.atan2(-fz, Math.hypot(fx, fy)) / DEG;
  const yaw = Math.atan2(fy, fx) / DEG;
  const roll = Math.atan2(el[6], el[10]) / DEG;
  return [pitch, yaw, roll];
}
// the entity's local angles (m_angRotation: relative to its parent), what SetupForces reads
const localAngles = (e) => angles(MAT.compose(POS.set(0, 0, 0), e.quat, ONE));

const isPhysbox = (e) => /^func_physbox/.test(e.cls);
const tickOf = (t) => Math.trunc(Math.fround(Math.fround(t) * 64) + 0.5); // SetNextThink (1803e4db0): (int)(t x 64 + 0.5)

// func_physbox's body, at its spawn (brushes.js). The engine links parents before spawning (as CS2 applies the
// keyvalues, parentname included, before Spawn), so the parent seen here is the spawn's.
export function spawnBody(e) {
  const w = e.engine.physics;
  const key = modelKey(e);
  if (!w || !key || !w.hasModel(key)) return;
  const { pos, quat } = frame(e);
  const kv = e.kv;
  e.state.body = w.spawnPhysBox(key, pos, quat, {
    spawnflags: num(kv.spawnflags),
    massScale: num(kv.massscale),
    gameMass: num(kv.gamemass),
    massCenterOffset: parseVec(kv.masscenteroffset),
    damageToEnableMotion: num(kv.damagetoenablemotion),
    forceToEnableMotion: num(kv.forcetoenablemotion),
    collisionGroup: kv.collisiongroup || kv.collisionGroup || '',
    interactsAs: kv.interactsas || kv.interactsAs || '',
    interactsWith: kv.interactswith || kv.interactsWith || '',
    interactsExclude: kv.interactsexclude || kv.interactsExclude || '',
  });
  if (e.state.body < 0) { delete e.state.body; return; }
  // PhysBox.Spawn made it dynamic (motion 1), or keyframed for DisableMotion; then the aggregate's apply (180cb3350)
  e.state.own = (num(kv.spawnflags) & 0x8000) !== 0 || num(kv.damagetoenablemotion) > 0 || num(kv.forcetoenablemotion) > 0 ? 3 : 1;
  e.state.keyframed = e.state.own === 3;
  e.state.parented = !!e.parent;
  e.state.parent = e.parent;
  applyMotion(e);
}

// The physbox's motion (rubikon/CS2_RUNTIME.md "Physbox motion and the hierarchy"). s.own is the node's stored motion
// type (+0x282: FUN_180cb1900 sets it, re-applying only when it changes), s.parented the move type's input (parented
// MOVETYPE_NONE, else VPHYSICS). The apply (FUN_180cb69b0): a parent with a skeleton instance (here: a model entity) ->
// keyframed (one body; the dynamic-parent bone case is never used by a map here), else s.own.
const hasSkeleton = (p) => !!p && !!p.kv.model;
function applyMotion(e) {
  const s = e.state, w = e.engine.physics;
  const keyframed = hasSkeleton(e.parent) || s.own === 3;
  if (keyframed !== s.keyframed) { w.setMotionType(s.body, keyframed ? 3 : 1); s.keyframed = keyframed; }
}
function setOwn(e, motion) {
  if (e.state.own === motion) return;
  e.state.own = motion;
  applyMotion(e);
}

// func_physbox inputs that reach the physics; true when handled here
export function physboxInput(e, inp) {
  const w = e.engine.physics, b = e.state.body;
  if (!w || b == null) return false;
  switch (inp) {
    // EnableMotion / DisableMotion (180ea5630 / 180ea56c0 -> FUN_1803df550): the stored motion 1 or 3; DisableMotion
    // also zeroes every part's velocities
    case 'enablemotion': setOwn(e, 1); return true;
    case 'disablemotion': w.setMotion(b, false); e.state.own = 3; e.state.keyframed = true; return true; // keyframed either way
    case 'wake': w.setAwake(b, true); return true;
    case 'sleep': w.setAwake(b, false); return true;
  }
  return false;
}

function attachedBody(e) {
  const t = e.engine.findOne(e.kv.attach1);
  return t && t.alive && t.state.body != null ? t : null;
}

// a thruster's or keep-upright's controller, once its body exists
function ensureController(e, w) {
  const s = e.state;
  if (s.handle != null) return true;
  const box = attachedBody(e);
  if (!box) return false;
  if (e.cls === 'phys_thruster') {
    const { pos, quat } = frame(e);
    s.handle = w.addThruster(box.state.body, num(e.kv.spawnflags), num(e.kv.force), localAngles(e), pos, quat);
    s.running = false;
    // OnActivate with orient locally sets the entity's local angles to its rotation relative to the body (1803e4440)
    if (num(e.kv.spawnflags) & 8) { angleQuat(w.thrusterAngles(s.handle), e.quat); e.engine.moved(e); }
    // spawn (180e7bd70): OnActivate, then the start with spawnflag 1
    if (num(e.kv.spawnflags) & 1) thrusterStart(e, w);
  } else {
    // spawn (180e914c0): the goal axis the entity's own up, active unless spawnflag 1
    const el = e.getWorld().elements;
    s.handle = w.addKeepUpright(box.state.body, [el[8], el[9], el[10]], num(e.kv.angularlimit), !(num(e.kv.spawnflags) & 1), num(e.kv.dampallrotation) !== 0);
  }
  return true;
}

// the start (180e73b40), only when not running: SetupForces, the controller, and forcetime's stop think
function thrusterStart(e, w) {
  const s = e.state;
  if (s.running) return;
  s.running = w.thrusterStart(s.handle, num(e.kv.force), localAngles(e));
  const ft = num(e.kv.forcetime);
  if (s.running && ft !== 0) s.stopTick = tickOf(Math.fround(e.engine.time) + Math.fround(ft));
}
function thrusterStop(e, w) {
  const s = e.state;
  s.stopTick = null;
  if (!s.running) return;
  w.thrusterStop(s.handle);
  s.running = false;
}

// thruster inputs (CPhysForce_API Activate 180e3f260, Deactivate 180e3fa80, scale 180e3fc80), as they fire
export function thrusterInput(e, inp, p) {
  const w = e.engine.physics;
  if (inp !== 'activate' && inp !== 'deactivate' && inp !== 'scale') return false;
  if (!ensureController(e, w)) { e.state.pending = { inp, p }; return true; } // its body isn't there yet
  if (inp === 'activate') thrusterStart(e, w);
  else if (inp === 'deactivate') thrusterStop(e, w);
  else { thrusterStart(e, w); if (e.state.running) w.thrusterScale(e.state.handle, num(p)); }
  return true;
}

// the thruster's think: forcetime's stop (180e73a40) once its tick has come
export function thrusterThink(e) {
  const s = e.state, w = e.engine.physics;
  if (s.stopTick != null && Math.round(e.engine.time * 64) >= s.stopTick) thrusterStop(e, w);
}

export function keepUprightInput(e, inp, p) {
  const w = e.engine.physics;
  if (!w || !ensureController(e, w)) return inp === 'turnon' || inp === 'turnoff' || inp === 'setangularlimit';
  switch (inp) {
    case 'turnon': w.keepUprightOn(e.state.handle, true); return true;
    case 'turnoff': w.keepUprightOn(e.state.handle, false); return true;
    case 'setangularlimit': w.setAngularLimit(e.state.handle, num(p)); return true;
  }
  return false;
}

// a brush or prop entity's keyframed body (not physboxes, which are bodies of their own); -1 when its class makes none
function brushBody(e, w) {
  const s = e.state;
  if (s.kfBody !== undefined) return s.kfBody;
  const key = modelKey(e);
  s.kfBody = -1;
  if (!key || !w.hasModel(key)) return -1;
  const { pos, quat } = frame(e);
  s.kfBody = w.spawnKeyframed(key, pos, quat, e.cls);
  s.kfSolid = true;
  return s.kfBody;
}

// func_physbox: a parent change since the last step. SetParent (180be2670) re-applies the motion (node vfn 0xa8 ->
// 180caf840); either way the move type recompute (1803de760) sets the stored motion to 3 (parented, NONE) or 1
// (VPHYSICS) when the move type changes (FUN_1801a4a40 -> FUN_180cb1900, applied only if it changed). ClearParent
// does no apply of its own: a physbox parented since its spawn keeps keyframed (its stored motion is 1 already)
function physboxHierarchy(e) {
  const s = e.state;
  if (e.parent === s.parent) return;
  s.parent = e.parent;
  if (e.parent) applyMotion(e);
  const parented = !!e.parent;
  if (parented !== s.parented) { s.parented = parented; setOwn(e, parented ? 3 : 1); }
}

export function physicsStep(engine) {
  const w = engine.physics;
  // PullKinematicTransforms (1805a5ca0 -> FUN_1805836c0): every keyframed body to its entity's transform
  for (const e of engine.ents) {
    const s = e.state;
    if (!e.alive) {
      if (s.body != null && !s.removed) { w.remove(s.body); s.removed = true; }
      if (s.kfBody >= 0 && !s.removed) { w.remove(s.kfBody); s.removed = true; }
      continue;
    }
    if (isPhysbox(e)) {
      if (s.body == null) continue;
      physboxHierarchy(e);
      if (s.keyframed) { const { pos, quat } = frame(e); w.drive(s.body, pos, quat); }
      continue;
    }
    if (e.cls === 'phys_thruster' || e.cls === 'phys_keepupright') {
      if (s.handle == null && ensureController(e, w) && s.pending) {
        const q = s.pending; s.pending = null;
        if (e.cls === 'phys_thruster') thrusterInput(e, q.inp, q.p);
      }
      continue;
    }
    const h = C[e.cls];
    if (!h?.solid && !h?.physSolid) continue;
    const b = brushBody(e, w);
    if (b < 0) continue;
    const solid = !!(h.solid?.(e) || h.physSolid?.(e));
    if (solid !== s.kfSolid) { w.setBrushSolid(b, solid); s.kfSolid = solid; }
    const { pos, quat } = frame(e);
    w.drive(b, pos, quat);
  }
  w.tick();
  // PushDynamicTransforms (1805a7260 -> 1805c29c0): an entity with no parent (m_nHierarchyType 0) and a dynamic body
  for (const e of engine.ents) if (e.alive && isPhysbox(e) && e.state.body != null && !e.state.keyframed && !e.parent) followBody(e);
  // the touch events the step made (OnSimulate 18057ad70, physics-touch.js)
  physicsTouches(engine);
}

// the entity to its dynamic body
function followBody(e) {
  const s = e.state;
  const p = e.engine.physics.pose(s.body);
  if (!p) return;
  if (p[0] !== e.pos.x || p[1] !== e.pos.y || p[2] !== e.pos.z || p[3] !== e.quat.x || p[4] !== e.quat.y || p[5] !== e.quat.z || p[6] !== e.quat.w) {
    e.pos.set(p[0], p[1], p[2]);
    e.quat.set(p[3], p[4], p[5], p[6]);
    e.engine.moved(e);
  }
  s.awake = p[7] === 1;
}
