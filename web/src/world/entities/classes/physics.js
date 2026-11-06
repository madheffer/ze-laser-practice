// Physboxes and the physics entities that push them. With a physics world (engine.physics: CS2's vphysics2 and the
// server's physics entities, ported from the binaries into rubikon/ and run as WebAssembly, world/physics-world.js)
// physics-rubikon.js does it all. Without one (the runtime didn't load, a map baked before physics.bin, tools/sim.mjs)
// the old fallback below moves them: phys_thruster on a func_physbox (ze_deadcore's mini-boss cubes chase you this way),
// gravity and floor friction, sliding along the static world and the map's solid brushes and movers.
//
// FALLBACK, not CS2: no rotation, "ignore mass" honoured, force every tick, friction FLOOR_FRICTION x g (mu 0.8).
// CS2's own (rubikon/CS2_RUNTIME.md): a thruster adds force x 1000 x invMass per second of velocity and turns the body by
// its inertia; mass, inertia and damping come from the model's compiled physics.
import * as THREE from 'three';
import { register } from '../registry.js';
import { num } from '../math.js';
import { traceSolids, boxTouchesHull } from '../../collision.js';
import { thrusterInput, thrusterThink, keepUprightInput } from './physics-rubikon.js';

const GRAVITY = 800;
const FLOOR_FRICTION = 0.8;
const MAX_SPEED = 2000; // physics max velocity (Source's default VPhysics limit)

register('phys_thruster', {
  spawn(e) {
    const sf = num(e.kv.spawnflags);
    e.enabled = !!(sf & 1);
    e.state.scale = 1;
  },
  input(e, inp, p) {
    if (e.engine.physics) return thrusterInput(e, inp, p);
    switch (inp) {
      case 'activate': e.enabled = true; wake(e); return true;
      case 'deactivate': e.enabled = false; return true;
      case 'scale': e.state.scale = num(p, 1); return true;
    }
  },
  think(e) { if (e.engine.physics) thrusterThink(e); },
});
register('phys_keepupright', {
  input: (e, inp, p) => (e.engine.physics ? keepUprightInput(e, inp, p) : inp === 'turnon' || inp === 'turnoff'),
});

// the physbox a thruster pushes (attach1), woken when the thruster fires
function attached(e) {
  const t = e.engine.findOne(e.kv.attach1);
  return t && t.alive ? t : null;
}
function wake(thruster) {
  const t = attached(thruster);
  if (t) t.state.awake = true;
}

// World-space linear acceleration from the active thrusters on `box`.
const tmpQ = new THREE.Quaternion();
const FORWARD = new THREE.Vector3(1, 0, 0); // Source's +x, angleForward's axis
function thrust(box) {
  const acc = new THREE.Vector3();
  const set = box.engine.byClass.get('phys_thruster');
  if (!set) return acc;
  for (const t of set) {
    if (!t.alive || !t.enabled || attached(t) !== box) continue;
    const sf = num(t.kv.spawnflags);
    if (!(sf & 2)) continue; // torque-only thrusters don't move it
    const f = num(t.kv.force) * (t.state.scale ?? 1);
    // the thruster's facing as the engine placed it: its template angles turned by the maker that spawned it
    // (ze_tyranny2's spider aims each poison ball with its maker's KeyValues(angles -15 180 0) before ForceSpawn), any
    // KeyValues(angles) since (its tornadoes re-aim their thrusters that way), and a parent. UNSETTLED: CS2's
    // CPhysThruster (orient locally, torque, ignore position) is not decompiled yet (porter research Q10); the box
    // never turns here
    const dir = FORWARD.clone().applyQuaternion(tmpQ.setFromRotationMatrix(t.getWorld()));
    // without "ignore mass", force / mass; the cubes all ignore mass, and gamemass 0 means VPhysics' own (unknown)
    const mass = sf & 16 ? 1 : Math.max(1, num(box.kv.gamemass) || num(box.kv.massscale) || 1);
    acc.addScaledVector(dir, f / mass);
  }
  return acc;
}

// func_clip_vphysics (CS2 CFuncVPhysicsClip): a brush physics objects collide with and players walk through.
// ze_tyranny2 keeps its bosses in with them: a lid over the spider's arena, Gargantua's doorways, the box Diablo's mover
// slides around in. CFuncVPhysicsClip::CreateVPhysics (180ce6490): keyframed, group 3, interacts-with 0x200000 (the
// physics_prop layer only, which physboxes are and players are not), its solid layer cleared (BrushPhysics.cs)
register('func_clip_vphysics', { physSolid: (e) => e.enabled });

// The map's solid brushes and movers this tick (a lift, a door, another cube) and its physics clips, built once per
// tick for every physbox.
function solidsNow(engine) {
  const c = engine._physSolids;
  if (c && c.t === engine.time) return c.list;
  const list = engine.solids({ physics: true });
  engine._physSolids = { t: engine.time, list };
  return list;
}

// Called from func_physbox's think (brushes.js). Needs engine.traceBox (the session wires the collision world in);
// headless (tools/sim.mjs) there is none and physboxes stay put.
export function physboxThink(e, dt) {
  if (e.engine.physics && e.state.body != null) return; // physics-rubikon.js moves it, in the step after the thinks
  const s = e.state;
  if (!s.awake || s.frozen || e.parent || !e.engine.traceBox) return;
  const b = e.engine.assets.bounds[e.model];
  if (!b) return;
  const vel = (s.vel ||= new THREE.Vector3());
  vel.addScaledVector(thrust(e), dt);
  vel.z -= GRAVITY * dt;
  if (s.onGround) {
    const sp = Math.hypot(vel.x, vel.y);
    if (sp > 0) {
      const drop = Math.min(sp, FLOOR_FRICTION * GRAVITY * dt);
      vel.x *= (sp - drop) / sp; vel.y *= (sp - drop) / sp;
    }
  }
  if (vel.length() > MAX_SPEED) vel.setLength(MAX_SPEED);

  // slide the model's box along the world (up to 3 planes per tick, like a player move)
  const half = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2];
  const off = [(b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2];
  const c = [e.pos.x + off[0], e.pos.y + off[1], e.pos.z + off[2]];
  // itself, what rides on it, and any solid it already overlaps (packed platforms, a mover that came up into it):
  // VPhysics pushes those apart, a stuck trace would freeze it in place
  const inner = [half[0] - 1, half[1] - 1, half[2] - 1];
  const skip = (x, d) => e.wouldCycle(x) || d.hulls.some((h) => boxTouchesHull(c, inner, h));
  let left = dt;
  s.onGround = false;
  for (let i = 0; i < 3 && left > 0; i++) {
    const end = [c[0] + vel.x * left, c[1] + vel.y * left, c[2] + vel.z * left];
    const tr = traceSolids(e.engine.traceBox(c, end, half), solidsNow(e.engine), c, end, half, skip);
    if (tr.startSolid) break; // spawned overlapping the world: leave it where the map put it
    c[0] = tr.endPos[0]; c[1] = tr.endPos[1]; c[2] = tr.endPos[2];
    if (tr.fraction >= 1) break;
    left -= left * tr.fraction;
    const n = tr.normal;
    if (n[2] > 0.7) s.onGround = true;
    const into = vel.x * n[0] + vel.y * n[1] + vel.z * n[2];
    if (into < 0) { vel.x -= n[0] * into; vel.y -= n[1] * into; vel.z -= n[2] * into; }
  }
  const nx = c[0] - off[0], ny = c[1] - off[1], nz = c[2] - off[2];
  if (nx !== e.pos.x || ny !== e.pos.y || nz !== e.pos.z) {
    e.pos.set(nx, ny, nz);
    e.engine.moved(e);
  }
  // asleep again once it has settled on the floor with nothing pushing
  if (s.onGround && vel.lengthSq() < 1 && !thrust(e).lengthSq()) { s.awake = false; vel.set(0, 0, 0); }
}
