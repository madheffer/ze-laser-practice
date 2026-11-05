// A little rigid-body motion, enough for physboxes the map pushes around: phys_thruster on a func_physbox (ze_deadcore's
// mini-boss cubes chase you this way), gravity and floor friction, sliding along the static world and the map's solid
// brushes and movers (deadcore's Stage B arena: 4 of its 12 cube spawns stand on the escape lift, b_escape_move_1).
//
// ze_deadcore's cube: four trigger_multiple bands 900 u out (left/right/up/down, parented to the physbox, filtered to
// the player who woke it) Activate the thruster on that side, Deactivate 1 s later; trigger_multiple re-fires every
// `wait` while you stay in a band, so the cube keeps accelerating towards you. phys_keepupright keeps it from
// tipping, so the physbox never rotates here.
//
// Truth: phys_thruster spawnflags (Source SDK phys_controller / CS2 FGD): 1 start active, 2 apply force, 4 apply
// torque, 8 orient locally, 16 ignore mass (force is then an acceleration, u/s²), 32 ignore position. Gravity is
// sv_gravity 800. Friction is an approximation: VPhysics/Rubikon contact friction isn't in the entity data, so a
// physbox on the floor loses FLOOR_FRICTION × g of horizontal speed per second (μ 0.8, Source's "default" surface).
import * as THREE from 'three';
import { register } from '../registry.js';
import { num, parseVec, angleForward } from '../math.js';
import { traceSolids, boxTouchesHull } from '../../collision.js';

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
    switch (inp) {
      case 'activate': e.enabled = true; wake(e); return true;
      case 'deactivate': e.enabled = false; return true;
      case 'scale': e.state.scale = num(p, 1); return true;
    }
  },
});
register('phys_keepupright', { input: (e, inp) => inp === 'turnon' || inp === 'turnoff' });

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
function thrust(box) {
  const acc = new THREE.Vector3();
  const set = box.engine.byClass.get('phys_thruster');
  if (!set) return acc;
  for (const t of set) {
    if (!t.alive || !t.enabled || attached(t) !== box) continue;
    const sf = num(t.kv.spawnflags);
    if (!(sf & 2)) continue; // torque-only thrusters don't move it
    const f = num(t.kv.force) * (t.state.scale ?? 1);
    // the thruster's own facing; "orient locally" means it turns with the box (which stays upright here)
    const dir = new THREE.Vector3(...angleForward(parseVec(t.kv.angles)));
    if (t.parent) dir.applyQuaternion(tmpQ.setFromRotationMatrix(t.parent.getWorld()));
    // without "ignore mass", force / mass; the cubes all ignore mass, and gamemass 0 means VPhysics' own (unknown)
    const mass = sf & 16 ? 1 : Math.max(1, num(box.kv.gamemass) || num(box.kv.massscale) || 1);
    acc.addScaledVector(dir, f / mass);
  }
  return acc;
}

// The map's solid brushes and movers this tick (a lift, a door, another cube), built once per tick for every physbox.
function solidsNow(engine) {
  const c = engine._physSolids;
  if (c && c.t === engine.time) return c.list;
  const list = engine.solids();
  engine._physSolids = { t: engine.time, list };
  return list;
}

// Called from func_physbox's think (brushes.js). Needs engine.traceBox (the session wires the collision world in);
// headless (tools/sim.mjs) there is none and physboxes stay put.
export function physboxThink(e, dt) {
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
