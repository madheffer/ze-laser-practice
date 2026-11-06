// env_sprite / env_glow (Source's CSprite; a Source 1 map's glows, drawn by world/sprites-source1.js from the bake's
// sprites/). sprite.cpp CSprite::Spawn: a named sprite without spawnflag 1 ("Start on") starts off, every other one
// (an unnamed sprite) on. ShowSprite / HideSprite / ToggleSprite turn it on / off; SetScale changes its scale. Its
// colour and alpha are the entity's rendercolor / renderamt (the generic Color / Alpha inputs change them).
import { register } from '../registry.js';
import { num } from '../math.js';

const sprite = {
  spawn(e) { e.state.on = !e.name || (num(e.kv.spawnflags) & 1) === 1; },
  input(e, inp, p) {
    switch (inp) {
      case 'showsprite': case 'turnon': e.state.on = true; return true;
      case 'hidesprite': case 'turnoff': e.state.on = false; return true;
      case 'togglesprite': case 'toggle': e.state.on = !e.state.on; return true;
      case 'setscale': e.kv.scale = String(num(p, 1)); return true;
    }
  },
};
for (const k of ['env_sprite', 'env_glow', 'env_sprite_oriented']) register(k, sprite);
