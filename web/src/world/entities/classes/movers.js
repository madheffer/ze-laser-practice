// Things that move: doors / movelinears (often carrying laser trigger_hurts), rotators, momentary_rot_button,
// and trains riding chains of path_tracks.
import * as THREE from 'three';
import { register } from '../registry.js';
import { stripName } from '../entity.js';
import { DEG, num, parseVec, angleQuat, angleForward, poseMatrix, rotationOf } from '../math.js';
import { approach, clamp01 } from '../../../lib/math.js';

// Linear movers share this: position 0 = pos1, 1 = pos2, in the parent's space.
function linearMover(e, dir, dist, startPos = 0) {
  e.state.p1 = e.pos.clone().addScaledVector(new THREE.Vector3(...dir), -dist * startPos);
  e.state.p2 = e.state.p1.clone().addScaledVector(new THREE.Vector3(...dir), dist);
  e.state.dist = dist;
  e.state.pos = startPos;
  e.state.target = startPos;
  e.state.speed = num(e.kv.speed, 100);
}
function moveLinear(e, dt, onArrive) {
  const s = e.state;
  if (s.pos === s.target) return;
  s.pos = approach(s.pos, s.target, s.dist > 0 ? (s.speed * dt) / s.dist : 1);
  e.pos.lerpVectors(s.p1, s.p2, s.pos);
  e.engine.moved(e);
  if (s.pos === s.target) onArrive(s.target);
}

function modelSizeAlong(e, dir) {
  const b = e.engine.assets.bounds[e.model];
  if (!b) return 0;
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  return Math.abs(size[0] * dir[0]) + Math.abs(size[1] * dir[1]) + Math.abs(size[2] * dir[2]);
}

register('func_door', {
  solid: (e) => !(num(e.kv.spawnflags) & 8),
  spawn(e) {
    const dir = angleForward(parseVec(e.kv.movedir));
    const dist = Math.max(0, modelSizeAlong(e, dir) - num(e.kv.lip));
    linearMover(e, dir, dist, 0);
    if (num(e.kv.spawnpos) === 1 || (num(e.kv.spawnflags) & 1)) { e.state.pos = e.state.target = 1; e.pos.copy(e.state.p2); }
  },
  input(e, inp, p, act) {
    const s = e.state;
    const open = () => {
      if (s.locked) return;
      if (s.target !== 1) { s.target = 1; e.fireOutput('OnOpen', act); s.activator = act; }
    };
    const close = () => { if (s.target !== 0) { s.target = 0; e.fireOutput('OnClose', act); s.activator = act; } };
    switch (inp) {
      case 'open': open(); return true;
      case 'close': close(); return true;
      case 'toggle': (s.target === 1 ? close : open)(); return true;
      case 'lock': s.locked = true; return true;
      case 'unlock': s.locked = false; return true;
      case 'setspeed': s.speed = num(p); return true;
    }
  },
  think(e, dt) {
    moveLinear(e, dt, (t) => {
      if (t === 1) {
        e.fireOutput('OnFullyOpen', e.state.activator);
        const wait = num(e.kv.wait, 4);
        if (wait >= 0 && !(num(e.kv.spawnflags) & 32)) e.engine.fire(e, 'Close', '', wait, e, e);
      } else e.fireOutput('OnFullyClosed', e.state.activator);
    });
  },
});

// func_door_rotating: swings `distance` degrees about its Z axis (spawnflags 64: X, 128: Y; 2 reverses) at `speed`
// degrees/s, in the parent's space; the same open / close / wait rules as func_door (Source CRotDoor)
register('func_door_rotating', {
  solid: (e) => !(num(e.kv.spawnflags) & 8),
  spawn(e) {
    const sf = num(e.kv.spawnflags);
    const s = e.state;
    s.axis = sf & 64 ? new THREE.Vector3(1, 0, 0) : sf & 128 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    s.deg = num(e.kv.distance, 90) * (sf & 2 ? -1 : 1);
    s.q0 = e.quat.clone();
    s.speed = Math.abs(num(e.kv.speed, 100));
    s.pos = s.target = num(e.kv.spawnpos) === 1 || (sf & 1) ? 1 : 0;
    if (s.pos) e.quat.copy(s.q0).multiply(new THREE.Quaternion().setFromAxisAngle(s.axis, s.deg * DEG));
  },
  input(e, inp, p, act) {
    const s = e.state;
    const open = () => { if (!s.locked && s.target !== 1) { s.target = 1; e.fireOutput('OnOpen', act); s.activator = act; } };
    const close = () => { if (s.target !== 0) { s.target = 0; e.fireOutput('OnClose', act); s.activator = act; } };
    switch (inp) {
      case 'open': open(); return true;
      case 'close': close(); return true;
      case 'toggle': (s.target === 1 ? close : open)(); return true;
      case 'lock': s.locked = true; return true;
      case 'unlock': s.locked = false; return true;
      case 'setspeed': s.speed = Math.abs(num(p)); return true;
    }
  },
  think(e, dt) {
    const s = e.state;
    if (s.pos === s.target) return;
    s.pos = approach(s.pos, s.target, s.deg ? (s.speed * dt) / Math.abs(s.deg) : 1);
    e.quat.copy(s.q0).multiply(new THREE.Quaternion().setFromAxisAngle(s.axis, s.deg * s.pos * DEG));
    e.engine.moved(e);
    if (s.pos !== s.target) return;
    if (s.target === 1) {
      e.fireOutput('OnFullyOpen', s.activator);
      const wait = num(e.kv.wait, 4);
      if (wait >= 0 && !(num(e.kv.spawnflags) & 32)) e.engine.fire(e, 'Close', '', wait, e, e);
    } else e.fireOutput('OnFullyClosed', s.activator);
  },
});

// func_button: the map's item buttons (mist's Cleansing Aura is a func_button on the item's weapon). Press / Use
// (app/items.js presses it for you on E) fires OnPressed unless locked; Lock / Unlock / PressOut as Source has them.
// No movement or sounds: item buttons are invisible.
register('func_button', {
  input(e, inp, p, act) {
    const s = e.state;
    switch (inp) {
      case 'press': case 'use': case 'pressin':
        if (s.locked) { e.fireOutput('OnUseLocked', act); return true; }
        e.fireOutput('OnPressed', act); e.fireOutput('OnIn', act); return true;
      case 'pressout': e.fireOutput('OnOut', act); return true;
      case 'lock': s.locked = true; return true;
      case 'unlock': s.locked = false; return true;
    }
  },
});

register('func_movelinear', {
  solid: (e) => !(num(e.kv.spawnflags) & 8),
  spawn(e) {
    const dir = angleForward(parseVec(e.kv.movedir));
    linearMover(e, dir, num(e.kv.movedistance, 100), num(e.kv.startposition));
  },
  input(e, inp, p, act) {
    const s = e.state;
    switch (inp) {
      case 'open': s.target = 1; s.activator = act; return true;
      case 'close': s.target = 0; s.activator = act; return true;
      case 'setposition': s.target = clamp01(num(p)); s.activator = act; return true;
      case 'setspeed': s.speed = num(p); return true;
    }
  },
  think(e, dt) {
    moveLinear(e, dt, (t) => {
      if (t === 1) e.fireOutput('OnFullyOpen', e.state.activator);
      else if (t === 0) e.fireOutput('OnFullyClosed', e.state.activator);
      e.fireOutput('OnReachedPosition', e.state.activator);
    });
  },
});

register('func_rotating', {
  solid: (e) => !(num(e.kv.spawnflags) & 64),
  spawn(e) {
    const sf = num(e.kv.spawnflags);
    e.state.axis = sf & 4 ? new THREE.Vector3(1, 0, 0) : sf & 8 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    e.state.dir = sf & 2 ? -1 : 1;
    e.state.max = num(e.kv.maxspeed, 100);
    e.state.speed = sf & 1 ? e.state.max * e.state.dir : 0;
    e.state.target = e.state.speed;
    // fanfriction: how fast it spins up/down (Source: % of max speed per tick at 10 Hz-ish). 0 = instant.
    e.state.friction = num(e.kv.fanfriction, 20);
  },
  input(e, inp, p) {
    const s = e.state;
    switch (inp) {
      case 'start': s.target = s.max * s.dir; return true;
      case 'stop': s.target = 0; return true;
      case 'toggle': s.target = s.target ? 0 : s.max * s.dir; return true;
      case 'reverse': s.dir = -s.dir; s.target = s.max * s.dir; return true;
      case 'startforward': s.dir = 1; s.target = s.max; return true;
      case 'startbackward': s.dir = -1; s.target = -s.max; return true;
      case 'setspeed': s.target = s.max * s.dir * clamp01(num(p)); return true;
      case 'stopatstartpos': s.target = 0; return true;
    }
  },
  think(e, dt) {
    const s = e.state;
    if (s.speed !== s.target) {
      // spin up/down over roughly maxspeed / (fanfriction * maxspeed / 100 * 10) seconds
      const rate = Math.max(1, (s.max * Math.max(1, s.friction)) / 10);
      s.speed = approach(s.speed, s.target, rate * dt);
    }
    if (!s.speed) return;
    e.quat.multiply(new THREE.Quaternion().setFromAxisAngle(s.axis, s.speed * dt * DEG));
    e.engine.moved(e);
  },
});

// A rotating handle driven by inputs: SetPosition(0..1) turns it toward distance*pos degrees at speed.
const rotButton = register('momentary_rot_button', {
  solid: () => false,
  spawn(e) {
    const sf = num(e.kv.spawnflags);
    e.state.axis = sf & 64 ? new THREE.Vector3(1, 0, 0) : sf & 128 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    e.state.dir = sf & 2 ? -1 : 1;
    e.state.base = e.quat.clone();
    e.state.distance = num(e.kv.distance, 90);
    e.state.speed = num(e.kv.speed, 100);
    e.state.pos = num(e.kv.startposition, 0);
    e.state.target = e.state.pos;
    rotButton.apply(e);
  },
  apply(e) {
    const s = e.state;
    e.quat.copy(s.base).multiply(new THREE.Quaternion().setFromAxisAngle(s.axis, s.dir * s.distance * s.pos * DEG));
    e.engine.moved(e);
  },
  input(e, inp, p, act) {
    const s = e.state;
    switch (inp) {
      case 'setposition': s.target = clamp01(num(p)); s.activator = act; return true;
      case 'setpositionimmediately': s.pos = s.target = clamp01(num(p)); rotButton.apply(e); return true;
      case 'lock': case 'unlock': case 'enable': case 'disable': return true;
      case '_setspeed': case 'setspeed': s.speed = num(p); return true;
    }
  },
  think(e, dt) {
    const s = e.state;
    if (s.pos === s.target) return;
    s.pos = approach(s.pos, s.target, s.distance > 0 ? (s.speed * dt) / s.distance : 1);
    rotButton.apply(e);
    e.fireOutput('Position', s.activator, s.pos);
    if (s.pos === s.target) {
      e.fireOutput('OnReachedPosition', s.activator);
      if (s.pos >= 1) e.fireOutput('OnFullyOpen', s.activator);
      if (s.pos <= 0) e.fireOutput('OnFullyClosed', s.activator);
    }
  },
});

const pathTrack = register('path_track', {
  next(node, dir) {
    if (!node) return null;
    if (dir > 0) {
      if (node.state.disabled) return null;
      return node.kv.target ? node.engine.findOne(node.kv.target) : null;
    }
    // previous: whoever targets this node
    for (const e of node.engine.byClass.get('path_track') || []) if (e.kv.target && stripName(e.kv.target) === node.key) return e;
    return null;
  },
  input(e, inp, p) {
    if (inp === 'enablepath') { e.state.disabled = false; return true; }
    if (inp === 'disablepath') { e.state.disabled = true; return true; }
    if (inp === 'togglepath') { e.state.disabled = !e.state.disabled; return true; }
    if (inp === 'enablealternatepath' || inp === 'disablealternatepath' || inp === 'togglealternatepath') return true;
  },
});

// A train riding a chain of path_tracks at its speed. Origin sits on the path (plus "height").
const trackTrain = register('func_tracktrain', {
  // spawnflags: 8 passable, 16 fixed orientation. Keys: startspeed = max speed, speed = initial speed.
  solid: (e) => !(num(e.kv.spawnflags) & 8),
  spawn(e) {
    const s = e.state;
    s.max = num(e.kv.startspeed, 100) || 100;
    s.speed = num(e.kv.speed, 0);
    s.dir = 1;
    s.height = num(e.kv.height, 0);
    s.fixed = !!(num(e.kv.spawnflags) & 16) || (e.kv.orientationtype != null && num(e.kv.orientationtype) === 0);
    // start on its first path_track
    e.engine.fire(e, '__trainstart', '', 0, null, e);
  },
  input(e, inp, p, act) {
    const s = e.state;
    switch (inp) {
      case '__trainstart': {
        const first = e.engine.findOne(e.kv.target);
        if (first) {
          s.node = first;
          const o = first.worldOrigin();
          trackTrain.place(e, [o[0], o[1], o[2] + s.height]);
          s.next = pathTrack.next(first, 1);
        }
        return true;
      }
      case 'startforward': s.dir = 1; s.speed = Math.abs(s.speed) || s.max; s.next = s.node ? pathTrack.next(s.node, 1) : null; return true;
      case 'startbackward': s.dir = -1; s.speed = Math.abs(s.speed) || s.max; s.next = s.node ? pathTrack.next(s.node, -1) : null; return true;
      case 'stop': s.speed = 0; return true;
      case 'resume': s.speed = s.speed || s.max; return true;
      case 'toggle': s.speed = s.speed ? 0 : s.max; return true;
      case 'setspeed': s.speed = s.max * clamp01(num(p)); return true;
      case 'setspeedreal': case 'setmaxspeed': s.speed = num(p); if (inp === 'setmaxspeed') s.max = num(p); return true;
      case 'setspeeddir': s.dir = num(p) < 0 ? -1 : 1; s.speed = Math.abs(num(p)) * s.max; s.next = s.node ? pathTrack.next(s.node, s.dir) : null; return true;
      case 'teleporttopathtrack': {
        const t = e.engine.findOne(p);
        if (t) { s.node = t; const o = t.worldOrigin(); trackTrain.place(e, [o[0], o[1], o[2] + s.height]); s.next = pathTrack.next(t, s.dir); }
        return true;
      }
    }
    void act;
  },
  place(e, at, faceTo) {
    let q = rotationOf(e.getWorld());
    if (faceTo && !e.state.fixed) {
      const d = new THREE.Vector3(faceTo[0] - at[0], faceTo[1] - at[1], faceTo[2] - at[2]);
      if (d.lengthSq() > 1) {
        const yaw = Math.atan2(d.y, d.x) / DEG;
        const pitch = -Math.atan2(d.z, Math.hypot(d.x, d.y)) / DEG;
        q = angleQuat([pitch, yaw, 0]);
      }
    }
    e.setWorldTransform(poseMatrix(at, q));
  },
  think(e, dt) {
    const s = e.state;
    if (!s.speed || !s.next) return;
    let travel = Math.abs(s.speed) * dt;
    let pos = e.worldOrigin();
    pos[2] -= s.height;
    let guard = 0;
    while (travel > 0 && s.next && guard++ < 16) {
      const t = s.next.worldOrigin();
      const d = [t[0] - pos[0], t[1] - pos[1], t[2] - pos[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      if (len <= travel) {
        pos = t;
        travel -= len;
        s.node = s.next;
        s.node.fireOutput('OnPass', e);
        // a path_track can change the train's speed as it passes
        const ns = num(s.node.kv.speed, 0);
        if (ns > 0) s.speed = ns;
        s.next = pathTrack.next(s.node, s.dir);
        if (!s.next) { s.speed = 0; s.node.fireOutput('OnTeleport', e); }
      } else {
        pos = [pos[0] + (d[0] / len) * travel, pos[1] + (d[1] / len) * travel, pos[2] + (d[2] / len) * travel];
        travel = 0;
      }
    }
    const look = s.next ? s.next.worldOrigin() : null;
    trackTrain.place(e, [pos[0], pos[1], pos[2] + s.height], look && [look[0], look[1], look[2] + s.height]);
  },
});
register('func_train', trackTrain);
register('func_tanktrain', trackTrain); // the same path_track rider (CS2 CFuncTankTrain); ze_dreamin's line lasers ride one
