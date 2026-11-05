// Entities that spawn template lumps: point_template (ForceSpawn at its own place) and env_entity_maker
// (ForceSpawn of its entitytemplate at itself, at another entity, or at the activator).
import { register } from '../registry.js';
import { poseMatrix, rotationOf } from '../math.js';

register('point_template', {
  input(e, inp, p, act) {
    if (inp === 'forcespawn') {
      e.engine.spawnTemplate(e, e.getWorld(), act);
      return true;
    }
  },
});

register('env_entity_maker', {
  input(e, inp, p, act) {
    const tpl = () => e.engine.findOne(e.kv.entitytemplate);
    if (inp === 'forcespawn') {
      const t = tpl();
      if (t) e.engine.spawnTemplate(t, e.getWorld(), act, e);
      return true;
    }
    if (inp === 'forcespawnatentityorigin' || inp === 'forcespawnatentitycenter') {
      const t = tpl(), at = e.engine.findOne(p, e, act);
      if (t && at) {
        const m = poseMatrix(at.worldOrigin(), e.quatWorld?.() || rotationOf(e.getWorld()));
        e.engine.spawnTemplate(t, m, act, e);
      }
      return true;
    }
    if (inp === 'forcespawnatactivatororigin' && act) {
      const t = tpl();
      if (t) {
        const m = poseMatrix(act.worldOrigin(), rotationOf(e.getWorld()));
        e.engine.spawnTemplate(t, m, act, e);
      }
      return true;
    }
  },
});
