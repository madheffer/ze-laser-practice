// Effects and one-shot actions: particle systems and point_teleport (sound entities: soundents.js).
import { register } from '../registry.js';
import { Entity } from '../entity.js';
import { num, bool, parseVec } from '../math.js';

// env_particle_glow is CS2's CEnvParticleGlow, a CParticleSystem with a few extra tint keys (alphascale, colortint,
// scale, selfillumscale; ze_deadcore's leave them at 1 / white): the same entity to us. ze_deadcore's escape platforms
// are drawn by one (escape_platform_propN, particles/cs2/escape_propN.vpcf), their brushes have no render mesh
export const isParticleSystem = (cls) => cls === 'info_particle_system' || cls === 'env_particle_glow';

// The glow's own control points: 16 = colortint (0-255), 17 = (alphascale, scale, selfillumscale), the order
// client.dll declares C_EnvParticleGlow's fields in (m_flAlphaScale, m_flRadiusScale, m_flSelfIllumScale, m_ColorTint).
// Westersand's boss HP bars (particles/ex_cube_big.vpcf) read them: CP16 / 255 is the tint, CP17.x the sheet sequence,
// stepped by the map's Boss_Health_Case -> SetAlphaScale(0..6). UNSETTLED: the CP write itself is not traced in
// client.dll; the effect and the map's IO are the evidence. Unset, CP16 stays (0,0,0) and the bar draws black.
const GLOW_INPUTS = { setalphascale: 'alphascale', setscale: 'scale', setselfillumscale: 'selfillumscale' };
export function glowControlPoints(e) {
  if (e.cls !== 'env_particle_glow') return null;
  const kv = e.kv;
  return {
    16: { position: parseVec(kv.colortint, [255, 255, 255]) },
    17: { position: [num(kv.alphascale, 1), num(kv.scale, 1), num(kv.selfillumscale, 1)] },
  };
}

const particleSystem = {
  spawn(e) { e.state.active = bool(e.kv.start_active); },
  input(e, inp, p) {
    if (inp === 'start') { e.state.active = true; return true; }
    if (inp === 'stop' || inp === 'stopplayendcap' || inp === 'destroyimmediately') { e.state.active = false; return true; }
    if (e.cls !== 'env_particle_glow') return;
    if (GLOW_INPUTS[inp]) { e.kv[GLOW_INPUTS[inp]] = String(num(p, 0)); return true; }
    if (inp === 'setcolortint' || inp === 'color') { e.kv.colortint = String(p ?? ''); return true; }
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

