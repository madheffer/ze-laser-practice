// Entity sounds as REQUESTS: the engine never plays anything. Every sound a class makes goes out as an engine
// 'sound' event that app/session.js hands to audio/audio.js (the co-op server's engine has no listener, so it
// ignores them). A request:
//   { type: 'start', ent, name, pos, local?, slot?, volume?, volumeRandom?: [min, max], pitch?, follow? }
//   { type: 'stop', ent, slot? }            stops that entity's voices (only the slot's, when given)
//   { type: 'pitch' | 'volume', ent, slot?, value }
// `slot` names one of an entity's sounds (a train's move loop vs its start / stop one-shots) the way Source's sound
// channels did; requests without a slot are the entity's only sound (ambient_generic, snd_event_point).
// `follow()` is where the sound is while it plays (the entity's centre as it moves); `pos` where it started.
// Randomness (a hit's volume) is the audio side's: the engine's own random stream must stay the same on every
// client and on the server.
//
// What each class plays and when is read from CS2's server.dll (2026-09-23 build, Ghidra project
// D:\tools\ghidra_projects_claude_composite) where noted, else from Source's code CS2 kept (CS2Fixes sdk/game/server).
// A name that no sound table defines plays nothing, as in CS2 ("StartSoundEvent Unable to find soundevent", in
// soundsystem.dll): Source-era vsnd paths left in noise1 / StartSound keys by a port stay silent there too.
import * as THREE from 'three';
import { num } from './math.js';

const _v = new THREE.Vector3();

// WorldSpaceCenter: the middle of the model's bounds, placed (the origin when the model has none)
export function centerOf(e) {
  const b = e.engine.assets.bounds?.[e.model];
  if (!b) return e.worldOrigin();
  _v.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2).applyMatrix4(e.getWorld());
  return [_v.x, _v.y, _v.z];
}

export function startSound(e, name, opts = {}) {
  if (!name) return;
  const pos = opts.pos || (opts.center ? centerOf(e) : e.worldOrigin());
  const ev = { type: 'start', ent: e, name: String(name), pos, ...opts };
  delete ev.center;
  if (opts.center && !opts.follow) ev.follow = () => centerOf(e);
  e.engine.emit('sound', ev);
}
export function stopSound(e, slot) {
  e.engine.emit('sound', slot ? { type: 'stop', ent: e, slot } : { type: 'stop', ent: e });
}
export function setSoundPitch(e, slot, value) {
  e.engine.emit('sound', { type: 'pitch', ent: e, slot, value });
}

// ---- CBreakable (func_breakable, func_physbox): material sounds. m_Material (FGD "material"):
// 0 glass, 1 wood, 2 metal, 3 flesh, 4 cinder block, 5 ceiling tile, 6 computer, 7 unbreakable glass, 8 rocks, 9 web.
// Die (FUN_180d8efa0) plays the break sound at WorldSpaceCenter; CS2 dropped Source's random volume / pitch here.
const BREAK = ['Breakable.Glass', 'Breakable.Crate', 'Breakable.Metal', 'Breakable.Flesh', 'Breakable.Concrete',
  'Breakable.Ceiling', 'Breakable.Computer', null, 'Breakable.Concrete', 'Breakable.Flesh'];
// DamageSound (FUN_180d8baf0): the shard noise of a hit, volume RandomFloat(0.75, 1.0) (DAT_1817af978, DAT_18177e580);
// a computer sounds like metal half the time
const SHARD = ['Breakable.MatGlass', 'Breakable.MatWood', 'Breakable.MatMetal', null, 'Breakable.MatConcrete',
  null, 'Breakable.Computer', 'Breakable.MatGlass', 'Breakable.MatConcrete', null];
export const BREAKABLE_CLASSES = new Set(['func_breakable', 'func_physbox', 'func_physbox_multiplayer']);
const material = (e) => num(e.kv.material, 0) | 0;

export function breakSound(e) {
  if (PROP_CLASS.test(e.cls)) { propBreakSound(e); return; }
  if (!BREAKABLE_CLASSES.has(e.cls)) return;
  const name = BREAK[material(e)];
  if (name) startSound(e, name, { center: true, slot: 'break' });
}

// ---- a breaking prop (CBreakableProp: prop_dynamic, prop_physics and their overrides) plays its surface's break
// sound (Source PhysBreakSound, props.cpp; CS2's surface properties carry it as audiosounds.break, server.dll has
// m_breakSound). The surface is the model's (lasers-bake surfaces.json "models"); the request names the model and
// audio.js looks the sound up, so the engine needs no surface table. A surface without one ("default") is silent:
// westersand's hall pillars (bridge_pillar02). UNSETTLED: CS2's prop break path itself is not decompiled.
const PROP_CLASS = /^prop_(dynamic|physics)/;
function propBreakSound(e) {
  if (!e.model) return;
  e.engine.emit('sound', { type: 'start', ent: e, name: '', surfaceBreak: String(e.model), pos: centerOf(e), slot: 'break', follow: null });
}

// CBreakable::TraceAttack (FUN_180daf340; CPhysBox::TraceAttack FUN_180ecf370 calls it first): every bullet or knife
// hit on a breakable that has physics plays DamageSound, unless the damage is DMG_BURN. `alt` picks the computer's
// metal variant (RandomInt(0, 1) in CS2: the caller rolls it, outside the engine's random stream).
export function hitSound(e, alt = false) {
  if (!BREAKABLE_CLASSES.has(e.cls) || !e.alive) return;
  const m = material(e);
  const name = m === 6 && alt ? 'Breakable.MatMetal' : SHARD[m];
  if (name) startSound(e, name, { center: true, slot: 'hit', volumeRandom: [0.75, 1] });
}

// ---- env_explosion (explosion creation FUN_180d921a0, reached from InputExplode FUN_180da56a0): the sound is
// explosion_custom_sound, else the explosion type's m_SoundName from CS2's scripts/explosion_types.vdata (an empty
// type is "default"), unless spawnflag 64 (No Sound: (flags >> 4) & 4 = TE_EXPLFLAG_NOSOUND). Played where it
// explodes. UNSETTLED: a type name the vdata lacks (treated as "default").
const EXPLOSION_TYPES = { default: 'BaseExplosionEffect.Sound', grenade: 'Grenade.Explode', molotov: 'Molotov.Explode',
  fireworks: 'Fireworks.Explode', gascan: 'Explosion.GasCan', gascylinder: 'GasCylinder.Explode',
  explosivebarrel: 'ExplosiveBarrel.Explode', electrical: 'Electrical.Explode', emp: 'EMP.Explode',
  shrapnel: 'Shrapnel.Explode', smoke: 'SmokeGrenade.Explode', flashbang: 'Flashbang.Explode',
  tripmine: 'Tripmine.Explode', ice: 'explode_3', none: '', custom: '' };
export function explosionSoundName(kv) {
  if (num(kv.spawnflags) & 64) return '';
  if (kv.explosion_custom_sound) return String(kv.explosion_custom_sound);
  const t = String(kv.explosion_type || 'default').toLowerCase();
  return Object.hasOwn(EXPLOSION_TYPES, t) ? EXPLOSION_TYPES[t] : EXPLOSION_TYPES.default;
}
export function explosionSound(e) {
  const name = explosionSoundName(e.kv);
  if (name) startSound(e, name, { slot: 'explode', follow: null });
}

// ---- func_tracktrain: CS2's CFuncTrackTrain::SoundUpdate (FUN_180fdcbb0) / SoundStop (FUN_180fdca10), called from
// Next (FUN_180fd3310) every think while the train has speed; SoundStop when it stops (Stop FUN_180fe0780), loses its
// path or reaches a dead end. Keys: MoveSound, MovePingSound, StartSound, StopSound, MoveSoundMin/MaxPitch,
// MoveSoundMin/MaxTime, volume (0-10).
//  - "playing" is the move sound's handle (+0x8fc): while there is none, each update plays StartSound and starts
//    MoveSound; a train with a StartSound but no MoveSound so plays StartSound on every update, as the binary does.
//  - multiplayer, playing: at most one update a second (+0x970 = curtime + 1.0).
//  - pitch = RemapVal(speed ratio, 0, 1, MoveSoundMinPitch, MoveSoundMaxPitch) x 0.01 (DAT_18179eeb4), a float; the
//    ratio is |speed| / 1000 (DAT_181782e1c), or / max speed with spawnflag 256. Sent as the move loop's pitch.
//  - MovePingSound: once curtime passes the next ping time; the next is RemapVal(ratio, 0, 1, MaxTime, MinTime) on.
//  - SoundStop: only with a move handle: stops it and plays StopSound at the train's volume.
const TRAIN_MAXSPEED = 1000;
const remap = (v, a, b, c, d) => c + (d - c) * (v - a) / (b - a);
export function trainSoundUpdate(e) {
  const kv = e.kv, s = e.state, now = e.engine.time;
  const move = kv.movesound, ping = kv.movepingsound, start = kv.startsound;
  if (!move && !start && !ping) return;
  const t = (s.snd ||= { playing: false, nextMP: 0, nextPing: 0 });
  if (t.playing) {
    if (t.nextMP > now) return;
    t.nextMP = now + 1.0;
  }
  const ratio = Math.min(1, Math.max(0, Math.abs(s.speed) / ((num(kv.spawnflags) & 0x100) ? Math.max(1e-6, s.max) : TRAIN_MAXSPEED)));
  const minP = num(kv.movesoundminpitch) || 60, maxP = num(kv.movesoundmaxpitch) || 200;
  const pitch = remap(ratio, 0, 1, minP, maxP) * 0.01;
  const volume = num(kv.volume, 10) * 0.1;
  const pingDelay = remap(ratio, 0, 1, num(kv.movesoundmaxtime), num(kv.movesoundmintime));
  if (!t.playing) {
    startSound(e, start, { center: true, slot: 'start', volume });
    if (move) { startSound(e, move, { center: true, slot: 'move', volume, pitch }); t.playing = true; }
    t.nextPing = now + pingDelay;
    return;
  }
  if (move) setSoundPitch(e, 'move', pitch);
  if (ping && now > t.nextPing) {
    startSound(e, ping, { slot: 'ping' });
    t.nextPing = now + pingDelay;
  }
}
export function trainSoundStop(e) {
  const t = e.state.snd;
  if (t?.playing) {
    stopSound(e, 'move');
    startSound(e, e.kv.stopsound, { slot: 'stop', volume: num(e.kv.volume, 10) * 0.1 });
  }
  if (t) t.playing = false;
}

// ---- func_door / func_door_rotating (Source CBaseDoor, doors.cpp; CS2 keeps m_NoiseMoving "noise1",
// m_NoiseArrived "noise2", m_NoiseMovingClosed "startclosesound", m_NoiseArrivedClosed "closesound" and the
// CBaseDoorMovingSoundThink). Unless spawnflag 4096 (Silent): starting to move from rest plays the moving sound (noise1;
// startclosesound instead when closing and set), arriving stops it and plays noise2 (closesound instead at the closed
// end when set). Source's defaults for an empty key (DoorSound.DefaultMove, ...) are names CS2's sound tables don't
// define: silent. loopmovesound (m_bLoopMoveSound; CBaseDoorMovingSoundThink re-plays the moving sound every time it
// ends, until the door arrives) is the request's `repeat`: audio.js loops the voice until it is stopped.
const doorSilent = (e) => (num(e.kv.spawnflags) & 4096) !== 0;
export function doorMoveSound(e, opening) {
  if (doorSilent(e)) return;
  const name = !opening && e.kv.startclosesound ? e.kv.startclosesound : e.kv.noise1;
  e.state.moveSnd = name;
  const loop = e.kv.loopmovesound;
  startSound(e, name, { slot: 'move', repeat: loop === '1' || String(loop).toLowerCase() === 'true' });
}
export function doorArriveSound(e, open) {
  if (doorSilent(e)) return;
  if (e.state.moveSnd) stopSound(e, 'move');
  e.state.moveSnd = '';
  startSound(e, !open && e.kv.closesound ? e.kv.closesound : e.kv.noise2, { slot: 'arrive' });
}

// ---- func_movelinear (Source CFuncMoveLinear::MoveTo / StopMoveSound, func_movelinear.cpp; CS2 keeps
// "StartSound" / "StopSound" and CFuncMoveLinearStopMoveSound): a move plays StartSound (once: a move while it is still
// the current sound plays nothing new), arriving stops it and plays StopSound.
export function moveLinearStartSound(e) {
  const kv = e.kv, s = e.state;
  if (!kv.startsound) return;
  if (s.curSnd === 'start') { stopSound(e, 'stop'); return; } // Source stops the stop sound here, as written
  s.curSnd = 'start';
  startSound(e, kv.startsound, { slot: 'move' });
}
export function moveLinearStopSound(e) {
  const kv = e.kv, s = e.state;
  if (kv.startsound && s.curSnd === 'start') stopSound(e, 'move');
  if (kv.stopsound && s.curSnd !== 'stop') { s.curSnd = 'stop'; startSound(e, kv.stopsound, { slot: 'stop' }); }
}
