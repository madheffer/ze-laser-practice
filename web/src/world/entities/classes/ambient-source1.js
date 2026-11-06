// ambient_generic on a Source 1 map (entities.json "engine": "source1"): CS:GO's CAmbientGeneric, which differs from
// CS2's sound entities. From csgo_server_legacy.dll (its datadesc: InputPlaySound FUN_101c59e0, InputStopSound
// LAB_101c5a10, InputToggleSound LAB_101c5b70 -> ToggleSound, vtable +800) and Source's sound.cpp for the bodies the
// binary calls into:
//  - looping = !(spawnflags & 32 "Is NOT Looped"); m_fActive is true only while a looping sound plays
//  - Spawn: a looping sound without spawnflag 16 ("Start Silent") is active and starts (Activate)
//  - PlaySound: only when not active (binary: m_fActive +0x400 == 0): SendSound(SND_STOP) then ToggleSound
//  - StopSound: only when active (binary: m_fActive != 0): ToggleSound. A non-looping sound is never active, so
//    StopSound leaves it playing (maps stop their music with Volume 0, as ze_ffvii_malgo_reactor does)
//  - ToggleSound: active -> stop, inactive; else looping -> active, non-looping -> stop first; then send the sound
//  - Volume: m_dpv.vol = clamp(round(value x 10), 0, 100), kept for later plays, SND_CHANGE_VOL on the playing one;
//    Pitch: m_dpv.pitch = clamp(value, 0, 255), SND_CHANGE_PITCH. Spawn: vol = health x 10, pitch = "pitch" (100)
//  - the level: ComputeSoundlevel(radius, play everywhere) (audio/source1-falloff.js); spawnflag 1 plays everywhere
//  - SourceEntityName: the sound plays from that entity; with none found it plays nothing (SendSound's
//    m_hSoundSource check). Looked up when the sound is sent (Source resolves it in Activate; a template's source
//    spawns with it)
// Which sound loops is the file's (a wave's cue point, soundevents.json `loop`), not the flag.
import { num } from '../math.js';
import { ambientLevel } from '../../../audio/source1-falloff.js';

const flags = (e) => num(e.kv.spawnflags) | 0;
const looping = (e) => (flags(e) & 32) === 0;
const everywhere = (e) => (flags(e) & 1) === 1;
const name = (e) => String(e.kv.message || '');

function source(e, act) {
  const src = e.kv.sourceentityname;
  if (!src) return e;
  return e.engine.findOne(src, e, act) || null;
}

function send(e, act) {
  const s = e.state, n = name(e);
  if (!n) return;
  const src = source(e, act);
  if (!src) return;
  s.startPitch = Math.max(1, s.pitch) / 100;
  e.engine.emit('sound', {
    type: 'start', ent: e, name: n, pos: src.worldOrigin(), local: everywhere(e),
    volume: s.vol / 100, pitch: s.startPitch, soundlevel: ambientLevel(num(e.kv.radius, 1250), everywhere(e)),
    follow: src === e ? null : () => (src.alive ? src.worldOrigin() : null),
  });
}
const stop = (e) => e.engine.emit('sound', { type: 'stop', ent: e });

function toggle(e, act) {
  const s = e.state;
  if (s.active) { stop(e); s.active = false; return; }
  if (looping(e)) s.active = true;
  else stop(e);
  send(e, act);
}

export const ambientSource1 = {
  spawn(e) {
    const s = e.state;
    s.active = false;
    s.vol = Math.max(0, Math.min(100, Math.round(num(e.kv.health, 10) * 10)));
    s.pitch = Math.max(0, Math.min(255, num(e.kv.pitch, 100)));
    if (looping(e) && !(flags(e) & 16)) e.engine.fire(e, 'PlaySound', '', 0, null, e);
  },
  input(e, inp, p, act) {
    const s = e.state;
    switch (inp) {
      case 'playsound': if (!s.active) { stop(e); toggle(e, act); } return true;
      case 'stopsound': if (s.active) toggle(e, act); return true;
      case 'togglesound': toggle(e, act); return true;
      case 'volume':
        s.vol = Math.max(0, Math.min(100, Math.round(num(p, 10) * 10)));
        e.engine.emit('sound', { type: 'volume', ent: e, value: s.vol / 100, absolute: true });
        return true;
      case 'pitch':
        s.pitch = Math.max(0, Math.min(255, num(p, 100)));
        // the voice started at startPitch: the change is a factor on it
        e.engine.emit('sound', { type: 'pitch', ent: e, value: Math.max(0.01, Math.min(4, s.pitch / 100 / (s.startPitch || 1))) });
        return true;
      case 'kill': stop(e); return false;
    }
  },
};
