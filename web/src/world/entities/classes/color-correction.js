// color_correction (Source 1's CColorCorrection; a CS:GO map's colour lookups, drawn by
// world/color-correction-source1.js from the bake's correction/). Visual only. Source SDK colorcorrection.cpp:
//   Spawn: enabled unless StartDisabled; an enabled one starts at maxweight, a disabled one at 0.
//   Enable: with fadeInDuration > 0 the weight goes linearly from where it is to maxweight over that time, else
//     straight to maxweight. Disable: the same down to 0 over fadeOutDuration. SetFadeInDuration /
//     SetFadeOutDuration change the times.
//   The client (c_colorcorrection.cpp) scales the weight by distance from the view: 1 within minfalloff, 0 past
//     maxfalloff, linear between; either one -1 = everywhere (ze_xenovation's are all -1, -1).
// ze_xenovation_v3_5: stage1_once / stage2_once enable color1 (zenovation_1), relay10 swaps it for color2
//   (xenova_last), relay13 (the ending) adds color3 (xenovation_stage2_1) 13 s in.
import { register } from '../registry.js';
import { num } from '../math.js';

function fadeTo(e, target, dur) {
  const now = e.engine.time;
  e.state.from = weightAt(e, now);
  e.state.to = target;
  e.state.t0 = now;
  e.state.dur = dur > 0 ? dur : 0;
}

// the server's current weight (before the client's distance falloff)
export function weightAt(e, time) {
  const s = e.state;
  if (!(s.dur > 0)) return s.to;
  const w = Math.min(1, Math.max(0, (time - s.t0) / s.dur));
  return s.from + (s.to - s.from) * w;
}

register('color_correction', {
  spawn(e) {
    const max = Math.min(1, Math.max(0, num(e.kv.maxweight, 1)));
    e.state.max = max;
    e.state.fadeIn = Math.max(0, num(e.kv.fadeinduration, 0));
    e.state.fadeOut = Math.max(0, num(e.kv.fadeoutduration, 0));
    e.state.from = e.state.to = e.enabled ? max : 0;
    e.state.t0 = 0;
    e.state.dur = 0;
  },
  input(e, inp, p) {
    switch (inp) {
      case 'enable': e.enabled = true; fadeTo(e, e.state.max, e.state.fadeIn); return true;
      case 'disable': e.enabled = false; fadeTo(e, 0, e.state.fadeOut); return true;
      case 'setfadeinduration': e.state.fadeIn = Math.max(0, num(p, 0)); return true;
      case 'setfadeoutduration': e.state.fadeOut = Math.max(0, num(p, 0)); return true;
    }
    return false;
  },
});

// [{ file: the entity's filename (lower case), weight }] for every lookup with any weight, seen from eye ([x, y, z])
export function colorCorrections(engine, eye) {
  const out = [];
  for (const e of engine.byClass.get('color_correction') || []) {
    if (!e.alive) continue;
    let w = weightAt(e, engine.time);
    if (!(w > 0)) continue;
    const lo = num(e.kv.minfalloff, -1), hi = num(e.kv.maxfalloff, -1);
    if (lo !== -1 && hi !== -1 && eye) {
      const o = e.worldOrigin();
      const d = Math.hypot(eye[0] - o[0], eye[1] - o[1], eye[2] - o[2]);
      w *= hi > lo ? 1 - Math.min(1, Math.max(0, (d - lo) / (hi - lo))) : d <= lo ? 1 : 0;
    }
    if (w > 0) out.push({ file: String(e.kv.filename || '').replace(/\\/g, '/').toLowerCase(), weight: w });
  }
  return out;
}
