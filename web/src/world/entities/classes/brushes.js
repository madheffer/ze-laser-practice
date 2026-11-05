// Brush entities with health (breakables, physboxes, override props) and toggled brushes
// (func_brush, func_wall_toggle). Damage itself is EntityEngine.damage / breakEntity.
import { register } from '../registry.js';
import { num } from '../math.js';

// Breakables and physboxes carry health. Bosses are usually one of these: players shoot it, and the map
// reads OnHealthChanged (health as a 0..1 fraction of max) or OnDamaged to count segments/hits.
// Max health is the SPAWN health and never changes: SetHealth / AddHealth move health only (Source's
// CBreakable). ze_mist_p depends on it: pbox_dragon spawns at 1,000,000, each segment is SetHealth(10000) +
// AddHealth(900 per human), and the map ends the segment when the fraction drops under 0.01 — i.e. after
// the 900 x humans on top of the 10000 (GFL's BossHUD config reads it with "offset": -10000).
const breakable = register('func_breakable', {
  solid: (e) => e.cls !== 'prop_dynamic_override',
  spawn(e) {
    const h = num(e.kv.health, 0);
    e.state.health = h;
    e.state.max = Math.max(1, h);
  },
  input(e, inp, p, act) {
    const s = e.state;
    switch (inp) {
      case 'break': e.engine.breakEntity(e, act); return true;
      case 'sethealth': s.health = num(p); e.engine.healthChanged(e, act); return true;
      case 'addhealth': s.health += num(p); e.engine.healthChanged(e, act); return true;
      case 'removehealth': e.engine.damage(e, num(p), act); return true;
      case 'setmass': case 'enablemotion': case 'disablemotion': case 'wake': case 'sleep': return true;
    }
  },
});
register('func_physbox', breakable);
register('func_physbox_multiplayer', breakable);
register('prop_physics_override', breakable);
register('prop_dynamic_override', { input: breakable.input, spawn: breakable.spawn });

const brush = register('func_brush', {
  solid: (e) => e.enabled && num(e.kv.solidity) !== 1,
  input(e, inp) {
    if (inp === 'enable') { e.enabled = true; e.visible = true; e.engine.moved(e); return true; }
    if (inp === 'disable') { e.enabled = false; e.visible = false; e.engine.moved(e); return true; }
    if (inp === 'toggle') { e.enabled = !e.enabled; e.visible = e.enabled; e.engine.moved(e); return true; }
  },
});
register('func_wall_toggle', brush);
