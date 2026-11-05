// Effects and one-shot actions: particle systems and point_teleport (sound entities: soundents.js).
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

