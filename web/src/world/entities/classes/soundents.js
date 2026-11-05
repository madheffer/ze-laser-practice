// Sound entities. They don't make sound here: they emit 'sound' requests (world/entities/sound.js) that audio.js plays,
// so the engine stays the same on every client and on the co-op server.
//
// point_soundevent / snd_event_point / snd_event_alignedbox are CS2's CSoundEventEntity (server.dll 2026-09-23):
//  - startonspawn queues StartSound 1.0 s after spawn (FUN_180484c30: event queue, delay 0x3f800000)
//  - StartSound (FUN_1804a2010): with stoponnew and a sound still playing, that sound is stopped and SoundEventGuid
//    (m_onGUIDChanged) fires with the cleared handle; then the event starts, its handle is kept and SoundEventGuid
//    fires with it; a think fires OnSoundFinished after the event's duration (2 s when it has none and the entity
//    has OnSoundFinished connections, with a warning: "playing sound event '%s' with no duration!")
//  - SoundEventGuid's value is how snd_event_param (CSoundEventParameter) finds the sound: SetSoundEventGUID keeps
//    it, SetFloatValue sets the parameter (parametername, "volume" on ze_gris_p's music faders) on that sound
// ambient_generic is played through the same requests (Source's spawnflags: 1 everywhere, 16 start silent).
// The handle is a counter on the engine, the same on every client and on the server.
//
// Soundscapes (env_soundscape, env_soundscape_triggerable, env_soundscape_proxy, trigger_soundscape) as Source runs
// them, with CS2's sound event keys: the player's soundscape is the last one a trigger_soundscape they touch names
// (an enabled triggerable one), or an env_soundscape whose radius they are in; it plays its soundevent (when
// enablesoundevent) to the player and stops the one before. It stays until another takes over.
import { register } from '../registry.js';
import { num, bool } from '../math.js';

function soundName(e) {
  return e.kv.soundname || e.kv.message || e.kv.soundeventname || e.kv.sound || '';
}
const isLocal = (e) => bool(e.kv.tolocalplayer) || bool(e.kv.playeverywhere) || (e.cls === 'ambient_generic' && (num(e.kv.spawnflags) & 1) === 1);
function emit(e, type, extra = {}) {
  e.engine.emit('sound', { type, ent: e, name: soundName(e), pos: e.worldOrigin(), local: isLocal(e), ...extra });
}

// how long a sound event plays (its vsnd duration, from the map's soundevents.json: engine.assets.soundDurations)
const durationOf = (engine, name) => engine.assets.soundDurations?.get(String(name).toLowerCase()) ?? 0;
const hasOutput = (e, name) => e.io.some((c) => c.output.toLowerCase() === name);

function startSound(e, act) {
  const s = e.state, engine = e.engine;
  if (bool(e.kv.stoponnew) && s.guid) {
    emit(e, 'stop');
    s.guid = 0;
    e.fireOutput('SoundEventGuid', act, '0');
  }
  const name = soundName(e);
  if (!name) return;
  const guid = engine.soundGuid = (engine.soundGuid || 0) + 1;
  s.guid = guid;
  emit(e, 'start', { guid });
  e.fireOutput('SoundEventGuid', act, String(guid));
  let dur = durationOf(engine, name);
  if (!(dur > 0) && hasOutput(e, 'onsoundfinished')) dur = 2;
  if (dur > 0) {
    const token = s.finishToken = (s.finishToken || 0) + 1; // a restart replaces the think (one context per entity)
    engine.after(dur, () => { if (e.alive && s.finishToken === token) e.fireOutput('OnSoundFinished', act); });
  }
}

const soundEntity = {
  spawn(e) {
    if (e.cls === 'ambient_generic') {
      if (!(num(e.kv.spawnflags) & 16)) e.engine.fire(e, 'StartSound', '', 0, null, e);
    } else if (bool(e.kv.startonspawn)) e.engine.fire(e, 'StartSound', '', 1, null, e);
  },
  input(e, inp, p, act) {
    switch (inp) {
      case 'startsound': case 'playsound': case 'start': startSound(e, act); return true;
      case 'stopsound': case 'stop': emit(e, 'stop'); e.state.guid = 0; return true;
      case 'togglesound': case 'toggle':
        if (e.state.guid) { emit(e, 'stop'); e.state.guid = 0; } else startSound(e, act);
        return true;
      case 'setsoundname': case 'setsoundevent': e.kv.soundname = p; return true;
      // ambient_generic's Volume (0..10); point_soundevent's maps send it too (not confirmed against CS2's input list)
      case 'volume': case 'setvolume': emit(e, 'volume', { value: num(p, 10) }); return true;
      case 'pitch': case 'setpitch': emit(e, 'pitch', { value: num(p, 100) }); return true;
      case 'kill': emit(e, 'stop'); return false; // the generic kill follows
    }
  },
};
for (const k of ['snd_event_point', 'point_soundevent', 'ambient_generic', 'snd_event_alignedbox']) register(k, soundEntity);

// snd_event_param: a parameter on a playing sound, found by the handle SoundEventGuid handed over
register('snd_event_param', {
  input(e, inp, p) {
    if (inp === 'setsoundeventguid') { e.state.guid = Math.max(0, Math.floor(num(p, 0))); return true; }
    if (inp === 'setfloatvalue') {
      // an empty value keeps the entity's own (floatvalue): a bare SetFloatValue re-sends it
      if (p !== '' && p != null && Number.isFinite(Number(p))) e.kv.floatvalue = String(Number(p));
      if (e.state.guid) e.engine.emit('sound', { type: 'param', guid: e.state.guid, name: String(e.kv.parametername || ''), value: num(e.kv.floatvalue, 0) });
      return true;
    }
  },
});

// ---------------------------------------------------------------- soundscapes

const SOUNDSCAPES = ['env_soundscape', 'env_soundscape_triggerable', 'env_soundscape_proxy'];
const soundscapeEntity = {
  input(e, inp) {
    if (inp === 'enable') { e.enabled = true; return true; }
    if (inp === 'disable') { e.enabled = false; return true; }
    if (inp === 'toggleenabled' || inp === 'toggle') { e.enabled = !e.enabled; return true; }
  },
};
for (const k of SOUNDSCAPES) register(k, soundscapeEntity);

// the soundscape entity a proxy stands for (its mainsoundscapename), or itself
function resolve(engine, e) {
  for (let i = 0; e && e.cls === 'env_soundscape_proxy' && i < 4; i++) e = engine.findOne(e.kv.mainsoundscapename);
  return e;
}

// make `scape` the player's soundscape: its soundevent plays to the player, the previous one stops
export function setSoundscape(engine, scape) {
  const target = resolve(engine, scape);
  if (!target || !target.enabled || engine.soundscape === target) return;
  const prev = engine.soundscape;
  if (prev) engine.emit('sound', { type: 'stop', ent: prev, slot: 'soundscape' });
  engine.soundscape = target;
  if (bool(target.kv.enablesoundevent) && target.kv.soundevent) {
    engine.emit('sound', { type: 'start', ent: target, name: String(target.kv.soundevent), pos: target.worldOrigin(), local: true, slot: 'soundscape' });
  }
  target.fireOutput('OnPlay', engine.playerEnt);
}

// trigger_soundscape: touching it gives you the soundscape it names
export function soundscapeTouch(engine, trigger) {
  const scape = engine.findOne(trigger.kv.soundscape);
  if (scape && scape.cls === 'env_soundscape_triggerable') setSoundscape(engine, scape);
}

// env_soundscape (not the triggerable kind): the nearest enabled one whose radius you are in (-1 = everywhere)
export function soundscapeThink(engine, at) {
  let best = null, bestD = Infinity;
  for (const cls of ['env_soundscape', 'env_soundscape_proxy']) {
    for (const e of engine.byClass.get(cls) || []) {
      if (!e.alive || !e.enabled) continue;
      const o = e.worldOrigin();
      const d = Math.hypot(o[0] - at[0], o[1] - at[1], o[2] - at[2]);
      const r = num(e.kv.radius, 128);
      if ((r < 0 || d <= r) && d < bestD) { best = e; bestD = d; }
    }
  }
  if (best) setSoundscape(engine, best);
}
