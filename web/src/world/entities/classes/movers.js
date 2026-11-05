// Things that move: doors / movelinears (often carrying laser trigger_hurts), rotators, momentary_rot_button.
// Trains riding chains of path_tracks are in trains.js / paths.js.
import * as THREE from 'three';
import { register } from '../registry.js';
import { DEG, num, parseVec, angleForward } from '../math.js';
import { approach, clamp01 } from '../../../lib/math.js';
import './trains.js'; // registers path_track, func_tracktrain, func_tanktrain, func_train
import { doorMoveSound, doorArriveSound, moveLinearStartSound, moveLinearStopSound } from '../sound.js';

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
  // dist is signed (a door whose lip exceeds its size moves backwards): the rate is over its length
  s.pos = approach(s.pos, s.target, s.dist !== 0 ? (s.speed * dt) / Math.abs(s.dist) : 1);
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
    // CS2 CBaseDoor::Spawn (cs2_server FUN_180d53f10): travel = |movedir . OBB size| - m_flLip, unclamped, and
    // position2 = position1 + movedir x travel. A lip bigger than the brush gives a negative travel: the door moves
    // backwards along movedir (ze_visualizer's dodge balls: 32 u doors with lip 3200 fly 3168 u "against" movedir).
    const dist = modelSizeAlong(e, dir) - num(e.kv.lip);
    linearMover(e, dir, dist, 0);
    if (num(e.kv.spawnpos) === 1 || (num(e.kv.spawnflags) & 1)) { e.state.pos = e.state.target = 1; e.pos.copy(e.state.p2); }
  },
  input(e, inp, p, act) {
    const s = e.state;
    // from rest, a door starts its moving sound (sound.js doorMoveSound)
    const open = () => {
      if (s.locked) return;
      if (s.target !== 1) { if (s.pos === s.target) doorMoveSound(e, true); s.target = 1; e.fireOutput('OnOpen', act); s.activator = act; }
    };
    const close = () => { if (s.target !== 0) { if (s.pos === s.target) doorMoveSound(e, false); s.target = 0; e.fireOutput('OnClose', act); s.activator = act; } };
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
      doorArriveSound(e, t === 1);
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
    const open = () => { if (!s.locked && s.target !== 1) { if (s.pos === s.target) doorMoveSound(e, true); s.target = 1; e.fireOutput('OnOpen', act); s.activator = act; } };
    const close = () => { if (s.target !== 0) { if (s.pos === s.target) doorMoveSound(e, false); s.target = 0; e.fireOutput('OnClose', act); s.activator = act; } };
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
    doorArriveSound(e, s.target === 1);
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

// a move to somewhere it isn't (Source MoveTo with a non-zero speed) plays StartSound (sound.js)
function linearTo(e, target, act) {
  const s = e.state;
  if (target !== s.pos && s.speed) moveLinearStartSound(e);
  s.target = target;
  s.activator = act;
  return true;
}

register('func_movelinear', {
  solid: (e) => !(num(e.kv.spawnflags) & 8),
  spawn(e) {
    const dir = angleForward(parseVec(e.kv.movedir));
    linearMover(e, dir, num(e.kv.movedistance, 100), num(e.kv.startposition));
  },
  input(e, inp, p, act) {
    const s = e.state;
    switch (inp) {
      case 'open': return linearTo(e, 1, act);
      case 'close': return linearTo(e, 0, act);
      case 'setposition': return linearTo(e, clamp01(num(p)), act);
      case 'setspeed': s.speed = num(p); return true;
    }
  },
  think(e, dt) {
    moveLinear(e, dt, (t) => {
      moveLinearStopSound(e);
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

