// Playing a replay back, tick by tick: loop.js asks here instead of reading your keys. The stage is the normal
// one (session.js, rebuilt from the replay's seed and rules); this puts the recorded player where they stood on
// each tick and redoes what they did that the map reacts to (shots at a boss, E, fall damage), on the tick they did
// it, so the map's own logic plays the rest out the same. app/replay.js owns S.replay; this only reads it.
//
// S.replay = { meta, data (lib/replay-codec.js decodeReplay), byTick: Map(tick -> events), cam: 'first' | 'third' | 'free', ... }
import { S } from './state.js';
import { POS_SCALE, ANG_SCALE, SHOT_KINDS } from '../lib/replay-codec.js';
import { CS } from '../world/movement.js';
import { GUNS, GUN_IDS, KNIFE, PISTOLS, DEFAULT_PISTOL } from '../lib/weapons.js';

export const replaying = () => !!S.replay;

// tick -> [events], for the lookups below
export function indexEvents(events) {
  const m = new Map();
  for (const ev of events) {
    if (!m.has(ev.tick)) m.set(ev.tick, []);
    m.get(ev.tick).push(ev);
  }
  return m;
}

// the recorded pose of tick k (1-based) onto the player; false once the recording has run out
export function applyPose(k, player) {
  const d = S.replay.data;
  const i = k - 1;
  if (i < 0 || i >= d.n) return false;
  const prev = player.origin;
  const o = [d.x[i] / POS_SCALE, d.y[i] / POS_SCALE, d.z[i] / POS_SCALE];
  // the speed the viewmodel bob and the body's legs read (a teleport's jump is not a speed)
  const v = [(o[0] - prev[0]) / CS.tick, (o[1] - prev[1]) / CS.tick, (o[2] - prev[2]) / CS.tick];
  player.velocity = Math.hypot(v[0], v[1], v[2]) < 4000 ? v : [0, 0, 0];
  player.origin = o;
  player.yaw = d.yaw[i] / ANG_SCALE;
  player.pitch = d.pitch[i] / ANG_SCALE;
  const f = d.flags[i];
  player.duckAmount = (f & 15) / 15;
  player.onGround = !!(f & 16);
  player.ducked = !!(f & 32); // the hull the map's triggers touch (player.height follows it)
  player.groundEntity = null; // no riding: the recorded positions already moved with the platform
  S.replay.weapon = f & 64 ? 'gun' : f & 128 ? 'pistol' : 'knife';
  return true;
}

// what the player did during tick k (between moving and the map's touches): fall damage
export function eventsDuring(k, { hurt }) {
  for (const ev of S.replay.byTick.get(k) || []) if (ev.type === 'fall') hurt(Math.min(ev.damage, 10000) / 10, 'fall');
}

// what the player did after tick k, before tick k + 1 (a frame between ticks): shots, E, a bought gun
// (S.replay.gunName: the primary at this point of the run; session.js starts it at the replay's meta.gun)
export function eventsAfter(k, { shoot, use }) {
  for (const ev of S.replay.byTick.get(k) || []) {
    if (ev.type === 'use') use();
    else if (ev.type === 'buy') S.replay.gunName = GUN_IDS[ev.gun] || S.replay.gunName;
    // a replay is someone else's data: a shot is held to CS2's own numbers (lib/weapons.js), whatever it claims
    else if (ev.type === 'shot') {
      const gun = S.replay.weapon === 'pistol' ? PISTOLS[DEFAULT_PISTOL] : GUNS[S.replay.gunName];
      const w = ev.kind === 0 ? gun : ev.kind === 2 ? KNIFE.stab : KNIFE.slash;
      const damage = Math.min(ev.damage, ev.kind === 0 ? gun.damage : ev.kind === 2 ? KNIFE.stab.damage : KNIFE.slash.first);
      shoot({ kind: SHOT_KINDS[ev.kind], damage, range: Math.min(ev.range, w.range), gun: ev.kind === 0 ? gun.name : undefined }, ev.yaw / ANG_SCALE, Math.max(-89, Math.min(89, ev.pitch / ANG_SCALE)));
    }
  }
}
