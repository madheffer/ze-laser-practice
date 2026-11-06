// env_sky: which sky is drawn, as the map's I/O switches it (visual only: world/lighting.js reads engine.skyState()
// every frame and redraws the sky when it changes). Enable / Disable (and TurnOn / TurnOff) as any entity; the sky
// drawn is the one enabled last, else the first enabled one spawned (what lighting.js picks as the map loads).
// ze_rush_b's relays swap skybox_dust / _black / _retro / _vertigoblue / _embassy as the round moves between worlds.
import { register } from '../registry.js';

register('env_sky', {
  input(e, inp) {
    if (inp === 'enable' || inp === 'turnon') { e.enabled = true; e.state.since = ++e.engine.skySerial; return true; }
    if (inp === 'disable' || inp === 'turnoff') { e.enabled = false; return true; }
    if (inp === 'toggle') { e.enabled = !e.enabled; if (e.enabled) e.state.since = ++e.engine.skySerial; return true; }
    return false;
  },
});

// the env_sky drawn now, or null
export function skyState(engine) {
  let best = null;
  for (const e of engine.byClass.get('env_sky') || []) {
    if (!e.alive || !e.enabled) continue;
    if (!best || (e.state.since || 0) > (best.state.since || 0)) best = e;
  }
  return best;
}
