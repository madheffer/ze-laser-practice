// skybox_swapper (CS:GO's CSkyboxSwapper): its Trigger input makes its SkyboxName the 2D sky (the server sets
// sv_skyname, which every client's sky follows). One sky for the whole map: the one triggered last. Visual only:
// world/source1-look.js swaps the scene background to that sky's baked faces (manifest sky2dSets).
// ze_xenovation_v3_5: relay7 / relay9 trigger skybox2 (sky_oblako_01, clouds) 11 s into the stage before the ending.
import { register } from '../registry.js';

register('skybox_swapper', {
  input(e, inp) {
    if (inp !== 'trigger') return false;
    const name = String(e.kv.skyboxname || '').trim().toLowerCase();
    if (name) e.engine.s1Sky = name;
    return true;
  },
});

// the sky a skybox_swapper set, or null (worldspawn's skyname)
export const swappedSky = (engine) => engine?.s1Sky || null;
