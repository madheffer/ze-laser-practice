// func_tracktrain (and func_tanktrain, its CS2 subclass CFuncTankTrain: ze_dreamin's line lasers ride one): a train
// riding a chain of path_tracks (classes/paths.js). Ported from CS2's server.dll (2026-09-23 build, Ghidra project
// D:\tools\ghidra_projects; CFuncTrackTrain addresses below), with Source's trains.cpp (CS2Fixes sdk/game/server)
// where CS2 kept the same code. What CS2 does differently from Source, all read from the binary:
//  - Next() runs every tick: it looks 0.1 s of travel ahead along the path from the train, aims the velocity at that
//    point (so corners are cut) and takes the node the look-ahead point is past as the current one, so a node's
//    OnPass fires 0.1 s before the train reaches it. A dead end is driven to exactly, then the last node passes.
//  - Turning sets an angular velocity of (target - current) DEGREES PER SECOND (no / interval as in Source), so the
//    train eases toward its target angles, ~63% of the way per second, instead of snapping within a tick.
//  - "Near path_tracks" (orientationtype 1) faces the current node's GetOrientation: the segment leaving it, or the
//    node's own angles when the node is orientationtype 2. Blends (2 / 3) go from the train's own angles as it
//    passed the last node to the orientation at the node after next; ease in/out is (1 - cos(p pi)) / 2.
//  - At spawn the train takes its first path_track's angles (pitch zeroed with No Pitch), not the direction to the
//    next node; a path_track's speed only applies to a train with "No User Control" (spawnflag 2).
// Not modelled: move sounds (as before), blocking / dmg (the engine has no mover pushing), local-space motion of a
// parented train (positions and angles here are world space).
import { register } from '../registry.js';
import { num, bool, angleQuat, poseMatrix, rotationOf, quatAngles, angleDistance, approachAngle, fixupAngles } from '../math.js';
import { clamp } from '../../../lib/math.js';
import * as P from './paths.js';

// spawnflags (FGD BaseTrain; Source trains.h)
const SF = { NOPITCH: 1, NOCONTROL: 2, PASSABLE: 8, FIXED: 16 };
const LOOKAHEAD = 0.1; // seconds of travel Next() looks ahead (DAT_181790f84)
const DEAD_ZONE = 0.1; // degrees: smaller turns are dropped (DoUpdateOrientation, the same constant)

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const fwd = (s) => s.dir === 1;

// The train's angles (GetLocalAngles). Kept as a QAngle so turning works in degrees like the engine; re-read from
// the entity when something else turned it (SetAbsAngles, a parent).
function angles(e) {
  const s = e.state;
  const q = rotationOf(e.getWorld());
  if (!s.quat || q.angleTo(s.quat) > 1e-5) s.ang = quatAngles(q);
  return s.ang;
}
function place(e, origin, ang) {
  const s = e.state;
  s.ang = [...ang];
  const q = angleQuat(ang);
  e.setWorldTransform(poseMatrix(origin, q));
  s.quat = rotationOf(e.getWorld());
}

const T = register('func_tracktrain', {
  solid: (e) => !(num(e.kv.spawnflags) & SF.PASSABLE),
  spawn(e) {
    const s = e.state, kv = e.kv;
    s.flags = num(kv.spawnflags) | 0;
    s.speed = num(kv.speed, 0); // m_flSpeed, signed with the direction
    s.max = num(kv.startspeed, 0); // m_maxSpeed
    if (!s.max) s.max = s.speed || 100; // Source Spawn (CS2's Spawn not read: UNSETTLED)
    s.oldSpeed = 0;
    s.dir = 1;
    s.length = num(kv.wheels, 0); // m_length
    s.height = num(kv.height, 0);
    s.bank = num(kv.bank, 0);
    s.orient = num(kv.orientationtype, 1); // TrainOrientationType_t: 0 fixed, 1 near path_tracks, 2 linear, 3 ease
    s.velType = num(kv.velocitytype, 0); // TrainVelocityType_t: 0 instant, 1 linear, 2 ease
    s.manual = bool(kv.manualspeedchanges);
    s.accel = num(kv.manualaccelspeed, 0);
    s.decel = num(kv.manualdecelspeed, 0);
    s.accelTo = false;
    s.desired = 0;
    s.vel = [0, 0, 0];
    s.avel = [0, 0, 0]; // [pitch, yaw, roll] degrees / s
    s.path = null; // m_ppath: the node last passed
    s.target = null; // MoveToPathNode / TeleportToPathNode destination name
    s.thinkAt = null; // Next() pending at this engine time
    s.dt = 1 / 64;
    s.doneAt = null; // dead end: arrive here at this time, then DeadEnd()
    angles(e);
    s.lastOrigin = e.worldOrigin();
    s.lastAng = [...s.ang];
    // CS2 Activate (FUN_180fb6f90) thinks Find on the next frame, after the path_tracks exist
    e.engine.fire(e, '__trainfind', '', 0, null, e);
  },

  // Find (FUN_180fc1e20): onto the first path_track, + height
  find(e) {
    const s = e.state;
    const first = e.engine.findOne(e.kv.target);
    if (!first || first.cls !== 'path_track') {
      e.engine.warnOnce(`train:${e.key}`, `func_tracktrain ${e.name} must be on a path of path_track`);
      s.path = null;
      return;
    }
    const o = first.worldOrigin();
    let ang;
    if (s.flags & SF.FIXED) ang = angles(e);
    else { ang = P.nodeAngles(first); if (s.flags & SF.NOPITCH) ang[0] = 0; }
    place(e, [o[0], o[1], o[2] + s.height], ang);
    s.path = first;
    T.arrive(e, first);
    if (s.speed) s.thinkAt = e.engine.time + LOOKAHEAD; // SetNextThink(curtime + 0.1)
    s.lastOrigin = e.worldOrigin();
    s.lastAng = [...angles(e)];
  },

  // Next (FUN_180fd3310)
  next(e, dt) {
    const s = e.state;
    if (!s.speed) return;
    if (!s.path || !s.path.alive) { s.speed = 0; return; } // "Lost path"
    const o = e.worldOrigin();
    const np = [o[0], o[1], o[2] - s.height];
    let { node, nextNext } = P.lookAhead(s.path, np, s.speed * LOOKAHEAD, true);
    // ManualSpeedChanges: heading for a dead end but asked to go the other way, so don't stall
    if (s.manual && (s.speed < 0) !== (s.desired < 0) && !node) node = s.path;
    np[2] += s.height;
    if (!node) { T.toDeadEnd(e, o, np); return; }
    if (node !== s.path) {
      s.path = node;
      s.lastOrigin = o;
      s.lastAng = [...angles(e)];
      // a teleport node: forward, the node after this one; backward, this one (FUN_180fd3310 as read)
      let at = node;
      if (nextNext && P.flags(fwd(s) ? nextNext : node) & P.SF_PATH.TELEPORT) { T.teleportTo(e, nextNext); at = nextNext; }
      T.arrive(e, at);
      e.fireOutput('OnNext', node); // UNSETTLED: the output's name (CS2 FGD "OnNext"; Source's datamap "OnNextPoint")
    }
    T.updateVelocity(e, node, nextNext, np, dt);
    if (!(s.flags & SF.FIXED)) {
      if (s.orient === 1) T.facePathTracks(e);
      else if (s.orient === 2 || s.orient === 3) T.blend(e, s.orient, nextNext);
    }
    s.thinkAt = e.engine.time; // SetNextThink(curtime): every tick
    s.doneAt = null; // SetMoveDone(NULL)
  },

  // the end of the path: drive onto the last point at the old speed, then DeadEnd
  toDeadEnd(e, o, np) {
    const s = e.state;
    s.avel = [0, 0, 0];
    s.oldSpeed = s.speed;
    s.speed = 0;
    const d = sub(np, o);
    const l = Math.hypot(...d);
    if (l > 0 && s.oldSpeed) {
      const t = l / Math.abs(s.oldSpeed);
      s.vel = d.map((x) => x / t);
      s.doneAt = e.engine.time + t;
      s.thinkAt = null; // SetNextThink(TICK_NEVER_THINK)
    } else T.deadEnd(e);
  },

  // DeadEnd (FUN_180fbf030): stop, and pass the last enabled node in the direction of travel
  deadEnd(e) {
    const s = e.state;
    let t = s.path && s.path.alive ? s.path : null;
    for (let guard = 0; t && guard < 10000; guard++) {
      const n = P.validPath(s.oldSpeed >= 0 ? P.next(t) : P.previous(t), true);
      if (!n) break;
      t = n;
    }
    s.vel = [0, 0, 0];
    s.avel = [0, 0, 0];
    if (!t) return;
    P.pass(t, e);
    if (s.target && e.engine.findOne(s.target) === t) { s.target = null; e.fireOutput('OnArrivedAtDestinationNode', t); }
  },

  // ArriveAtNode (FUN_180fb8ef0)
  arrive(e, node) {
    const s = e.state;
    P.pass(node, e); // FirePassInputs(node, node.GetNext()): this node only
    if (P.flags(node) & P.SF_PATH.DISABLE_TRAIN) s.flags |= SF.NOCONTROL;
    if (s.target && e.engine.findOne(s.target) === node) {
      s.target = null;
      e.fireOutput('OnArrivedAtDestinationNode', node);
      s.oldSpeed = s.speed;
      s.speed = 0;
      return;
    }
    // the node's speed, only for a train the player can't drive
    const ns = num(node.kv.speed, 0);
    if (s.flags & SF.NOCONTROL && ns) T.setSpeed(e, ns);
  },

  // SetSpeed (FUN_180fdaee0)
  setSpeed(e, v, accel = false) {
    const s = e.state;
    const old = s.speed;
    const ns = Math.abs(v) * s.dir;
    s.accelTo = accel;
    if (accel) {
      s.desired = ns;
      if (s.speed === 0 && Math.abs(s.desired) > 0) s.speed = 0.1; // a little push to get going
      T.start(e);
      return;
    }
    s.speed = ns;
    if (ns === old) return;
    if (ns === 0) T.stop(e);
    else if (old === 0) T.start(e);
    else T.next(e, e.state.dt);
  },
  start(e) { e.fireOutput('OnStart', e); T.next(e, e.state.dt); },
  // Stop (FUN_180fe0780; the Stop input does the same)
  stop(e) {
    const s = e.state;
    s.vel = [0, 0, 0];
    s.avel = [0, 0, 0];
    s.oldSpeed = s.speed;
    s.speed = 0;
    s.thinkAt = null;
  },
  // SetDirForward (FUN_180fdaa20): turning round steps the current node across the train
  setDir(e, forward) {
    const s = e.state;
    if (forward && s.dir !== 1) { const p = s.path && P.previous(s.path); if (p) s.path = p; s.dir = 1; }
    else if (!forward && s.dir !== -1) { const n = s.path && P.next(s.path); if (n) s.path = n; s.dir = -1; }
  },

  // UpdateTrainVelocity (FUN_180fe9ac0): instant, or blend the speed between the two nodes' speeds (or approach the
  // SetSpeedDirAccel target), then aim at the look-ahead point
  updateVelocity(e, prev, nxt, np, dt) {
    const s = e.state;
    const o = e.worldOrigin();
    if (s.velType === 1 || s.velType === 2) {
      if (s.accelTo) {
        if (s.speed !== s.desired) {
          const step = (Math.abs(s.desired) <= Math.abs(s.speed) ? s.decel : s.accel) * dt;
          const d = s.desired - s.speed;
          s.speed = d > step ? s.speed + step : d < -step ? s.speed - step : s.desired;
        }
      } else if (prev && nxt) {
        const sp = num(prev.kv.speed, 0), sn = num(nxt.kv.speed, 0);
        const ps = sp ? Math.abs(sp) * s.dir : s.speed;
        const ns = sn ? Math.abs(sn) * s.dir : ps;
        if (ps === ns) s.speed = ps;
        else {
          const a = prev.worldOrigin();
          const seg = dist(nxt.worldOrigin(), a);
          if (seg) {
            let p = dist(o, a) / seg;
            if (s.velType === 2) p = (3 - 2 * p) * p * p; // SimpleSpline (DAT_181782e08 = 3)
            s.speed = (1 - p) * ps + p * ns;
          }
        }
      }
    } else if (s.velType !== 0) return;
    const d = sub(np, o);
    const l = Math.hypot(...d);
    const k = l ? Math.abs(s.speed) / l : 0;
    s.vel = [d[0] * k, d[1] * k, d[2] * k];
  },

  // UpdateOrientationAtPathTracks (FUN_180fe8800)
  facePathTracks(e) {
    const s = e.state;
    if (!s.path) return;
    const o = e.worldOrigin();
    const front = [o[0], o[1], o[2] - s.height];
    const ahead = s.length > 0 ? s.length : 100;
    const { nextNext } = P.lookAhead(s.path, front, fwd(s) ? ahead : -ahead, false);
    let ang = P.orientation(s.path, fwd(s));
    if (!ang) return;
    fixupAngles(ang);
    if (s.manual && nextNext && P.orientType(nextNext) === 2) ang = P.orientation(nextNext, fwd(s));
    T.turn(e, fixupAngles([...angles(e)]), ang);
  },

  // UpdateOrientationBlend (FUN_180fe8b20)
  blend(e, type, nn) {
    const s = e.state;
    const prev = fixupAngles([...s.lastAng]);
    const to = nn && P.orientation(nn, fwd(s));
    const nxt = to ? fixupAngles(to) : [...prev];
    if (s.flags & SF.NOPITCH) nxt[0] = prev[0];
    let p = 0;
    if (!same(prev, nxt)) {
      const seg = dist(nn.worldOrigin(), s.lastOrigin);
      if (seg) p = dist(e.worldOrigin(), s.lastOrigin) / seg;
    }
    if (type === 3) p = (1 - Math.cos(p * Math.PI)) * 0.5; // FUN_181470b80
    // UNSETTLED (tiny): CS2 slerps with a polynomial fit of the slerp weights; three.js slerps exactly
    const out = quatAngles(angleQuat(prev).slerp(angleQuat(nxt), p));
    if (s.flags & SF.NOPITCH) out[0] = prev[0];
    T.turn(e, angles(e), out);
  },

  // DoUpdateOrientation (FUN_180fbf6e0): angular velocity = the angle still to turn, per second
  turn(e, cur, ang) {
    const s = e.state;
    let vx = s.flags & SF.NOPITCH ? 0 : angleDistance(ang[0], cur[0]);
    let vy = angleDistance(ang[1], cur[1]);
    if (Math.abs(vx) < DEAD_ZONE) vx = 0;
    if (Math.abs(vy) < DEAD_ZONE) vy = 0;
    let vr = s.avel[2];
    const b = s.bank;
    if (b) {
      if (vy < -5) vr = angleDistance(approachAngle(-b, cur[2], b * 2), cur[2]);
      else if (vy > 5) vr = angleDistance(approachAngle(b, cur[2], b * 2), cur[2]);
      else vr = angleDistance(approachAngle(0, cur[2], b * 4), cur[2]) * 4;
    }
    s.avel = [vx, vy, vr];
  },

  // TeleportToPathTrack (FUN_180fe0a70): onto the node (no height), facing its orientation when it has a way on
  teleportTo(e, node) {
    const s = e.state;
    const cur = angles(e);
    const np = node.worldOrigin();
    const look = [...np];
    P.lookAhead(node, look, fwd(s) ? s.length : -s.length, false);
    let ang = [...cur];
    if (!(s.flags & SF.FIXED) && !same(look, np)) {
      ang = P.orientation(node, fwd(s)) || [...cur];
      if (s.flags & SF.NOPITCH) ang[0] = cur[0];
    }
    place(e, np, ang);
    s.avel = [0, 0, 0];
  },

  input(e, inp, p) {
    const s = e.state;
    const f = num(p);
    switch (inp) {
      case '__trainfind': T.find(e); return true;
      case 'stop': T.stop(e); return true;
      case 'startforward': T.setDir(e, true); T.setSpeed(e, s.max); return true;
      case 'startbackward': T.setDir(e, false); T.setSpeed(e, s.max); return true;
      case 'toggle': T.setSpeed(e, s.speed === 0 ? s.max : 0); return true;
      case 'resume': s.speed = s.oldSpeed; T.start(e); return true;
      case 'reverse': T.setDir(e, s.dir !== 1); T.setSpeed(e, s.speed); return true;
      case 'setspeed': T.setSpeed(e, s.max * clamp(f, 0, 1)); return true;
      case 'setspeedreal': T.setSpeed(e, clamp(f, 0, s.max)); return true;
      case 'setspeeddir': T.setDir(e, f >= 0); T.setSpeed(e, s.max * clamp(Math.abs(f), 0, 1)); return true;
      case 'setspeeddiraccel': T.setDir(e, f >= 0); T.setSpeed(e, s.max * clamp(Math.abs(f), 0, 1), true); return true;
      case 'setmaxspeed': s.max = f; return true; // FUN_180f9b820: the max only
      case 'lockorientation': s.flags |= SF.FIXED; s.avel = [0, 0, 0]; return true;
      case 'unlockorientation': s.flags &= ~SF.FIXED; return true;
      case 'movetopathnode': T.moveTo(e, p); return true;
      case 'teleporttopathnode': {
        // FUN_180fce040: the node becomes current and arrives (so OnArrivedAtDestinationNode fires and the train
        // stops), then the train jumps onto it
        s.target = p || null;
        const n = e.engine.findOne(p);
        if (n && n.cls === 'path_track') {
          s.path = n;
          T.arrive(e, n);
          T.teleportTo(e, n);
          s.vel = [0, 0, 0]; // UNSETTLED: CS2 leaves the velocity as it was (Next stops at speed 0 without clearing it)
        }
        return true;
      }
    }
  },

  // MoveToPathNode (FUN_180fcda30): head for the named node (searching 1000 nodes ahead, then behind) at the current
  // node's speed or the max, and stop when it passes
  moveTo(e, name) {
    const s = e.state;
    s.target = name || null;
    const dest = e.engine.findOne(name);
    const cur = s.path;
    if (!cur || !dest) return;
    const spd = num(cur.kv.speed, 0) || s.max;
    let forward;
    if (dest === cur) {
      // already past it: turn round
      if (s.dir !== 1) { if (!P.previous(cur)) { T.stop(e); return; } forward = true; }
      else { if (!P.next(cur)) { T.stop(e); return; } forward = false; }
    } else {
      let n = cur;
      for (let i = 0; i < 1000 && n; i++) { n = P.next(n); if (n === dest) { forward = true; break; } }
      if (!forward) {
        n = cur;
        for (let i = 0; i < 1000; i++) { n = P.previous(n); if (!n) return; if (n === dest) { forward = false; break; } }
        if (forward == null) return;
      }
    }
    T.setDir(e, forward);
    T.setSpeed(e, spd);
  },

  // A tick: the push physics moves the train by its velocities (stopping at a dead end's arrival time), then Next()
  // runs if due. UNSETTLED: CS2's push integration itself was not read; this is Source's PhysicsPusher order.
  think(e, dt) {
    const s = e.state;
    const now = e.engine.time;
    s.dt = dt; // gpGlobals->frametime, for Next() run from an input
    const done = s.doneAt != null && s.doneAt <= now + 1e-9;
    const mt = done ? Math.max(0, Math.min(dt, s.doneAt - (now - dt))) : dt;
    if (mt > 0 && (s.vel.some(Boolean) || s.avel.some(Boolean))) {
      const o = e.worldOrigin();
      const a = angles(e);
      place(e, [o[0] + s.vel[0] * mt, o[1] + s.vel[1] * mt, o[2] + s.vel[2] * mt],
        [a[0] + s.avel[0] * mt, a[1] + s.avel[1] * mt, a[2] + s.avel[2] * mt]);
    }
    if (done) { s.doneAt = null; T.deadEnd(e); }
    if (s.thinkAt != null && now >= s.thinkAt - 1e-9) { s.thinkAt = null; T.next(e, dt); }
  },
});
register('func_train', T); // as before: the same path_track rider
register('func_tanktrain', T);
