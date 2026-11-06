// The map's physics entities on CS2's own physics (world/physics-world.js, the WebAssembly build of rubikon/): what
// physics.js does when the run has a physics world (engine.physics). Each tick, before the entities think:
//   - func_physbox: a body from the bake's physics.bin, spawned as CS2's CPhysBox spawns it (rubikon/src/Game/PhysBox.cs);
//     its entity then follows the body (unparented), or keyframes it (parented: it moves with its parent)
//   - phys_thruster / phys_keepupright: motion controllers on the attach1 body (Thruster.cs, KeepUpright.cs), made once the
//     body exists (a template spawns them together), started and stopped by their inputs
//   - brush entities that are solid (movers, doors, trains, func_brush, func_clip_vphysics): keyframed bodies driven to
//     the entity's transform every tick (the server's keyframe, Keyframe.cs), so physboxes meet what the map moves
// UNSETTLED: the order of the physics step against the entities' thinks in CS2's server frame; a parented physbox
// keyframed (CS2's SetParent on a physics object is not decompiled); the player as a physics obstacle (CS2's player
// shadow is not ported: physboxes do not feel players, players collide with physboxes as solids).
import * as THREE from 'three';
import { C } from '../registry.js';
import { num, parseVec, DEG } from '../math.js';

const POS = new THREE.Vector3(), QUAT = new THREE.Quaternion(), SCALE = new THREE.Vector3();

// the physics.bin key of an entity's model (bake/RubikonBake.cs: the model path, lowercased)
const modelKey = (e) => String(e.kv.model || '').toLowerCase().replace(/\\/g, '/');

function frame(e) {
  e.getWorld().decompose(POS, QUAT, SCALE);
  return { pos: [POS.x, POS.y, POS.z], quat: QUAT.clone() };
}

// QAngle (pitch, yaw, roll) of a world matrix: forward its x column, left y, up z
function angles(m) {
  const el = m.elements;
  const fx = el[0], fy = el[1], fz = el[2];
  const pitch = Math.atan2(-fz, Math.hypot(fx, fy)) / DEG;
  const yaw = Math.atan2(fy, fx) / DEG;
  const roll = Math.atan2(el[6], el[10]) / DEG;
  return [pitch, yaw, roll];
}

const isPhysbox = (e) => /^func_physbox/.test(e.cls);

// func_physbox's body, at its spawn (brushes.js)
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
  if (e.state.body < 0) delete e.state.body;
  else e.state.keyframed = (num(kv.spawnflags) & 0x8000) !== 0 || num(kv.damagetoenablemotion) > 0 || num(kv.forcetoenablemotion) > 0;
}

// func_physbox inputs that reach the physics; true when handled here
export function physboxInput(e, inp) {
  const w = e.engine.physics, b = e.state.body;
  if (!w || b == null) return false;
  switch (inp) {
    case 'enablemotion': if (!e.parent) { w.setMotion(b, true); e.state.keyframed = false; } return true;
    case 'disablemotion': w.setMotion(b, false); e.state.keyframed = true; return true;
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
  const m = e.getWorld();
  if (e.cls === 'phys_thruster') {
    const { pos, quat } = frame(e);
    s.handle = w.addThruster(box.state.body, num(e.kv.spawnflags), num(e.kv.force), angles(m), pos, quat);
    s.running = false;
  } else {
    // spawn (180e914c0): the goal axis the entity's own up, active unless spawnflag 1
    const el = m.elements;
    s.handle = w.addKeepUpright(box.state.body, [el[8], el[9], el[10]], num(e.kv.angularlimit), !(num(e.kv.spawnflags) & 1), num(e.kv.dampallrotation) !== 0);
  }
  return true;
}

// thruster inputs: the wanted state, applied in the step
export function thrusterInput(e, inp, p) {
  switch (inp) {
    case 'activate': e.state.on = true; return true;
    case 'deactivate': e.state.on = false; return true;
    case 'scale': e.state.scale = num(p, 1); return true;
  }
  return false;
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

// a solid brush entity's keyframed body (not physboxes, which are bodies of their own)
function brushBody(e, w) {
  const s = e.state;
  if (s.kfBody !== undefined) return s.kfBody;
  const key = modelKey(e);
  s.kfBody = -1;
  if (!key || !w.hasModel(key)) return -1;
  const { pos, quat } = frame(e);
  s.kfBody = w.spawnKeyframed(key, pos, quat);
  s.kfSolid = true;
  return s.kfBody;
}

export function physicsStep(engine) {
  const w = engine.physics;
  for (const e of engine.ents) {
    const s = e.state;
    if (!e.alive) {
      if (s.body != null && !s.removed) { w.remove(s.body); s.removed = true; }
      if (s.kfBody >= 0 && !s.removed) { w.remove(s.kfBody); s.removed = true; }
      continue;
    }
    if (isPhysbox(e)) {
      if (s.body == null) continue;
      if (e.parent) {
        // follows its parent: keyframed to where the hierarchy puts it
        if (!s.keyframed) { w.setMotion(s.body, false); s.keyframed = true; }
        const { pos, quat } = frame(e);
        w.drive(s.body, pos, quat);
      }
      continue;
    }
    if (e.cls === 'phys_thruster') {
      if (!ensureController(e, w)) continue;
      const want = s.on ?? !!(num(e.kv.spawnflags) & 1);
      if (want !== s.running) {
        w.thrusterOn(s.handle, want, num(e.kv.force), s.scale ?? 1, angles(e.getWorld()));
        s.running = want;
      }
      continue;
    }
    if (e.cls === 'phys_keepupright') { ensureController(e, w); continue; }
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
}

// func_physbox's think: the entity follows its dynamic body
export function followBody(e) {
  const s = e.state;
  if (s.body == null || e.parent) return;
  const p = e.engine.physics.pose(s.body);
  if (!p) return;
  if (p[0] !== e.pos.x || p[1] !== e.pos.y || p[2] !== e.pos.z || p[3] !== e.quat.x || p[4] !== e.quat.y || p[5] !== e.quat.z || p[6] !== e.quat.w) {
    e.pos.set(p[0], p[1], p[2]);
    e.quat.set(p[3], p[4], p[5], p[6]);
    e.engine.moved(e);
  }
  s.awake = p[7] === 1;
}
