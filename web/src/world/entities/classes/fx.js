// Effects and one-shot actions: particle systems, point_teleport, and sound entities.
import { register } from '../registry.js';
import { Entity } from '../entity.js';
import { num, bool, parseVec } from '../math.js';

// env_particle_glow is CS2's CEnvParticleGlow, a CParticleSystem with a few extra tint keys (alphascale, colortint,
// scale, selfillumscale; ze_deadcore's leave them at 1 / white): the same entity to us. ze_deadcore's escape platforms
// are drawn by one (escape_platform_propN, particles/cs2/escape_propN.vpcf), their brushes have no render mesh
export const isParticleSystem = (cls) => cls === 'info_particle_system' || cls === 'env_particle_glow';
const particleSystem = {
  spawn(e) { e.state.active = bool(e.kv.start_active); },
  input(e, inp) {
    if (inp === 'start') { e.state.active = true; return true; }
    if (inp === 'stop' || inp === 'stopplayendcap' || inp === 'destroyimmediately') { e.state.active = false; return true; }
  },
};
for (const k of ['info_particle_system', 'env_particle_glow']) register(k, particleSystem);

register('point_teleport', {
  input(e, inp, p, act) {
    if (inp === 'teleport' || inp === 'teleportentity' || inp === 'teleporttocurrentpos') {
      const target = inp === 'teleportentity' ? e.engine.findOne(p, e, act) : (e.kv.target ? null : act);
      const list = target ? [target] : e.engine.find(e.kv.target, e, act);
      const m = e.getWorld();
      for (const t of list) {
        if (t === e.engine.playerEnt) e.engine.onTeleportPlayer?.(e.worldOrigin(), parseVec(e.kv.angles)[1]);
        else if (t instanceof Entity) t.setWorldTransform(m);
      }
      return true;
    }
  },
});

// Sound entities don't make sound here: they emit 'sound' events ({ type: 'start'|'stop', ent, name, pos,
// local }) that audio.js turns into playback. snd_event_point is what CS2 maps use; the older classes map
// onto the same events.
function soundName(e) {
  return e.kv.soundname || e.kv.message || e.kv.soundeventname || e.kv.sound || '';
}
function emitSound(e, type, extra = {}) {
  e.engine.emit('sound', {
    type, ent: e, name: soundName(e), pos: e.worldOrigin(),
    local: bool(e.kv.tolocalplayer) || bool(e.kv.playeverywhere) || (num(e.kv.spawnflags) & 1) === 1 && e.cls === 'ambient_generic',
    ...extra,
  });
}
const soundEntity = {
  spawn(e) {
    if (bool(e.kv.startonspawn) || (e.cls === 'ambient_generic' && !(num(e.kv.spawnflags) & 16))) {
      e.engine.fire(e, 'StartSound', '', 0, null, e);
    }
  },
  input(e, inp, p) {
    switch (inp) {
      case 'startsound': case 'playsound': case 'start':
        if (bool(e.kv.stoponnew)) emitSound(e, 'stop');
        emitSound(e, 'start'); return true;
      case 'stopsound': case 'stop': emitSound(e, 'stop'); return true;
      case 'togglesound': case 'toggle': emitSound(e, e.state.playing ? 'stop' : 'start'); e.state.playing = !e.state.playing; return true;
      case 'setsoundname': case 'setsoundevent': e.kv.soundname = p; return true;
      case 'volume': case 'setvolume': emitSound(e, 'volume', { value: num(p, 10) }); return true;
      case 'pitch': case 'setpitch': emitSound(e, 'pitch', { value: num(p, 100) }); return true;
      case 'kill': emitSound(e, 'stop'); return false; // fall through to the generic kill
    }
  },
};
for (const k of ['snd_event_point', 'point_soundevent', 'ambient_generic', 'snd_event_alignedbox']) register(k, soundEntity);
