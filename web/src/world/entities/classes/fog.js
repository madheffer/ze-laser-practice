// Fog, as the map's own entities and I/O drive it (visual only: the renderer reads engine.fogState() every frame,
// world/lighting.js). Two kinds, both generic, so any map that uses them gets them:
//   env_fog_controller   Source's fog (CS:GO maps carried into CS2). The PLAYER picks one: `SetFogController <name>`
//                        aimed at !activator / !player switches it (keyvalues.js); until then the master
//                        (spawnflags 1) or, without one, the first. TurnOn / TurnOff, SetStartDist / SetEndDist /
//                        SetMaxDensity / SetColor / SetColorSecondary / SetFarZ / SetAngles, and *LerpTo +
//                        StartFogTransition (over foglerptime), as CFogController.
//   env_gradient_fog     CS2's distance x height fog. Enable / Disable (fading over fadetime), SetFogStartDistance /
//                        SetFogEndDistance / SetFogStartHeight / SetFogEndHeight / SetFogMaxOpacity / SetFogStrength /
//                        SetFogFalloffExponent / SetFogVerticalExponent / SetFogColor / SetFarZ, each easing over
//                        fadetime. With several enabled, the last one spawned wins (VRF's WorldFogInfo).
import { register } from '../registry.js';
import { num, bool, parseVec } from '../math.js';
import { stripPrefix } from '../../../lib/names.js';

const rgb = (s, d = [255, 255, 255]) => {
  const v = String(s ?? '').replace(/[[\],]/g, ' ').trim().split(/\s+/).map(Number);
  return v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? v.slice(0, 3) : [...d];
};
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// A set of fog values that eases from `from` to `to` over `dur` seconds of engine time.
function easing(values) { return { from: { ...values }, to: { ...values }, t0: 0, dur: 0 }; }
function current(f, time) {
  const t = f.dur > 0 ? Math.min(1, Math.max(0, (time - f.t0) / f.dur)) : 1;
  const out = {};
  for (const k of Object.keys(f.to)) out[k] = Array.isArray(f.to[k]) ? lerp3(f.from[k], f.to[k], t) : lerp(f.from[k], f.to[k], t);
  return out;
}
function setTo(e, f, changes, dur) {
  const now = current(f, e.engine.time);
  f.from = now;
  f.to = { ...now, ...changes };
  f.t0 = e.engine.time;
  f.dur = dur;
}

// ---- env_fog_controller
register('env_fog_controller', {
  spawn(e) {
    const kv = e.kv;
    e.state.on = bool(kv.fogenable);
    e.state.master = (num(kv.spawnflags) & 1) !== 0;
    e.state.fog = easing({
      color: rgb(kv.fogcolor), color2: rgb(kv.fogcolor2), start: num(kv.fogstart, 0), end: num(kv.fogend, 1000),
      density: num(kv.fogmaxdensity, 1), exponent: num(kv.fogexponent, 1), hdr: num(kv.hdrcolorscale, 1), farz: num(kv.farz, -1),
    });
    e.state.blend = bool(kv.fogblend);
    e.state.dir = bool(kv.use_angles) ? null : parseVec(kv.fogdir, [1, 0, 0]);
    e.state.lerp = {}; // the *LerpTo targets
  },
  input(e, inp, p) {
    const s = e.state, f = s.fog;
    const set = (k, v) => { setTo(e, f, { [k]: v }, 0); return true; };
    switch (inp) {
      case 'turnon': s.on = true; return true;
      case 'turnoff': s.on = false; return true;
      case 'setstartdist': return set('start', num(p, 0));
      case 'setenddist': return set('end', num(p, 0));
      case 'setmaxdensity': return set('density', num(p, 1));
      case 'setcolor': return set('color', rgb(p));
      case 'setcolorsecondary': return set('color2', rgb(p));
      case 'setfarz': return set('farz', num(p, -1));
      case 'setangles': s.dir = parseVec(p); return true;
      case 'setstartdistlerpto': s.lerp.start = num(p, 0); return true;
      case 'setenddistlerpto': s.lerp.end = num(p, 0); return true;
      case 'setmaxdensitylerpto': s.lerp.density = num(p, 1); return true;
      case 'setcolorlerpto': s.lerp.color = rgb(p); return true;
      case 'setcolorsecondarylerpto': s.lerp.color2 = rgb(p); return true;
      case 'startfogtransition': setTo(e, f, s.lerp, Math.max(0, num(e.kv.foglerptime, 0))); s.lerp = {}; return true;
    }
    return false;
  },
});

// ---- env_gradient_fog
const GRADIENT_INPUTS = {
  setfogstartdistance: 'start', setfogenddistance: 'end', setfogstartheight: 'startHeight', setfogendheight: 'endHeight',
  setfogmaxopacity: 'opacity', setfogstrength: 'strength', setfogfalloffexponent: 'exponent', setfogverticalexponent: 'vexponent', setfarz: 'farz',
};
register('env_gradient_fog', {
  spawn(e) {
    const kv = e.kv;
    const height = bool(kv.heightfog);
    e.state.fog = easing({
      color: rgb(kv.fogcolor), start: num(kv.fogstart, 0), end: num(kv.fogend, 4000), strength: num(kv.fogstrength, 1),
      opacity: num(kv.fogmaxopacity, 1), exponent: num(kv.fogfalloffexponent, 2),
      // heightfog off: the height term is 1 (VRF zeroes the heights and the vertical exponent)
      startHeight: height ? num(kv.fogstartheight, 0) : 0, endHeight: height ? num(kv.fogendheight, 0) : 0,
      vexponent: height ? num(kv.fogverticalexponent, 1) : 0, farz: num(kv.farz, -1),
      weight: e.enabled ? 1 : 0, // Enable / Disable fade this
    });
    e.state.spawnOrder = e.id;
  },
  input(e, inp, p) {
    const f = e.state.fog, fade = Math.max(0, num(e.kv.fadetime, 0));
    if (inp === 'enable') { e.enabled = true; setTo(e, f, { weight: 1 }, fade); return true; }
    if (inp === 'disable') { e.enabled = false; setTo(e, f, { weight: 0 }, fade); return true; }
    if (inp === 'setfogcolor') { setTo(e, f, { color: rgb(p) }, fade); return true; }
    if (inp === 'setfadetime') { e.kv.fadetime = p; return true; }
    const k = GRADIENT_INPUTS[inp];
    if (k) { setTo(e, f, { [k]: num(p, 0) }, k === 'farz' ? 0 : fade); return true; }
    return false;
  },
});

// The fog the player sees now: { controller: {...} | null, gradient: {...} | null }. Values are the entities'
// own (colours 0-255 sRGB, distances in units); world/lighting.js turns them into shader numbers.
export function fogState(engine) {
  const time = engine.time;
  let ctl = engine.fogController;
  if (!ctl?.alive) {
    const all = [...(engine.byClass.get('env_fog_controller') || [])].filter((x) => x.alive);
    ctl = all.find((x) => x.state.master) || all[0] || null;
  }
  let grad = null;
  for (const g of engine.byClass.get('env_gradient_fog') || []) {
    if (!g.alive || !g.state.fog) continue;
    const v = current(g.state.fog, time);
    if (v.weight <= 0.001) continue;
    if (!grad || g.state.spawnOrder > grad.order) grad = { ...v, order: g.state.spawnOrder };
  }
  const c = ctl?.state.fog ? { ...current(ctl.state.fog, time), on: ctl.state.on, blend: ctl.state.blend, dir: ctl.state.dir } : null;
  return { controller: c, gradient: grad };
}

// SetFogController from the player's inputs (keyvalues.js): a name (a [PR#] prefix and the case don't matter)
export function setPlayerFog(engine, name) {
  const key = stripPrefix(String(name ?? '')).trim();
  engine.fogController = key ? engine.findOne(key) : null;
}
