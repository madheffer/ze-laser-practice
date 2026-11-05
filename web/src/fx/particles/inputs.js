// Float/vector parameter inputs (CParticleFloatInput / CParticleVecInput) as particles.dll evaluates them (RE §11).
// `ctx` is a collection (system.js); `i` a particle index, or -1 for a collection-level input (first value,
// 0x18005ad90); `kind` is 'init' inside an initializer (substitutions, 0x18005acd0).
import {
  A, ANGLE_ATTRS, DEG, VECTOR_ATTRS, clamp, drawConstant, drawVarying, getCp, len, sub,
} from './functions/common.js';

// Both input forms: a bare number or array (KV3 text shorthand), and the struct, compact
// ({ m_nType, m_flLiteralValue }) or full. Missing sub-fields read the struct default.
const FLOAT_D = {
  m_nType: 'PF_TYPE_LITERAL', m_nMapType: 'PF_MAP_TYPE_DIRECT', m_flLiteralValue: 0, m_nControlPoint: 0,
  m_nScalarAttribute: 3, m_nVectorAttribute: 6, m_nVectorComponent: 0, m_flRandomMin: 0, m_flRandomMax: 1,
  m_bHasRandomSignFlip: false, m_nRandomSeed: -1, m_nRandomMode: 'PF_RANDOM_MODE_CONSTANT', m_flLOD0: 0,
  m_flLOD1: 0, m_flLOD2: 0, m_flLOD3: 0, m_flNoiseOutputMin: 0, m_flNoiseOutputMax: 1, m_flNoCameraFallback: 0,
  m_nInputMode: 'PF_INPUT_MODE_CLAMPED', m_flMultFactor: 1, m_flInput0: 0, m_flInput1: 1, m_flOutput0: 0,
  m_flOutput1: 1, m_flNotchedRangeMin: 0, m_flNotchedRangeMax: 1, m_flNotchedOutputOutside: 0,
  m_flNotchedOutputInside: 1, m_nRoundType: 'PF_ROUND_TYPE_NEAREST', m_nBiasType: 'PF_BIAS_TYPE_STANDARD',
  m_flBiasParameter: 0, m_Curve: { m_spline: [], m_tangents: [], m_vDomainMins: [0, 0], m_vDomainMaxs: [0, 0] }, m_flCompareValue: 0,
};
// These literals equal defaults.js structs.CParticleFloatInput / CParticleVecInput (MGetKV3ClassDefaults,
// RE §11); ParticleRuntimeTests pins that, so a regenerated defaults.js cannot drift from them.
const VEC_D = {
  m_nType: 'PVEC_TYPE_LITERAL', m_vLiteralValue: [0, 0, 0], m_LiteralColor: [0, 0, 0], m_nVectorAttribute: 6,
  m_vVectorAttributeScale: [1, 1, 1], m_nControlPoint: 0, m_nDeltaControlPoint: 0, m_vCPValueScale: [1, 1, 1],
  m_vCPRelativePosition: [0, 0, 0], m_vCPRelativeDir: [1, 0, 0], m_flInterpInput0: 0, m_flInterpInput1: 1,
  m_vInterpOutput0: [0, 0, 0], m_vInterpOutput1: [1, 1, 1], m_Gradient: { m_Stops: [] }, m_vRandomMin: [0, 0, 0],
  m_vRandomMax: [0, 0, 0],
};
export const FLOAT_DEFAULTS = FLOAT_D;
export const VEC_DEFAULTS = VEC_D;

const ENUM_INT = {
  m_nType: ['PF_TYPE_LITERAL', 'PF_TYPE_NAMED_VALUE', 'PF_TYPE_RANDOM_UNIFORM', 'PF_TYPE_RANDOM_BIASED', 'PF_TYPE_COLLECTION_AGE',
    'PF_TYPE_ENDCAP_AGE', 'PF_TYPE_CONTROL_POINT_COMPONENT', 'PF_TYPE_CONTROL_POINT_CHANGE_AGE', 'PF_TYPE_CONTROL_POINT_SPEED',
    'PF_TYPE_CONTROL_POINT_DISTANCE', 'PF_TYPE_PARTICLE_DETAIL_LEVEL', 'PF_TYPE_CONCURRENT_DEF_COUNT',
    'PF_TYPE_CLOSEST_CAMERA_DISTANCE', 'PF_TYPE_SNAPSHOT_COUNT', 'PF_TYPE_SNAPSHOT_CHANGED', 'PF_TYPE_CONTROL_POINT_IS_SET',
    'PF_TYPE_RENDERER_CAMERA_DISTANCE', 'PF_TYPE_RENDERER_CAMERA_DOT_PRODUCT', 'PF_TYPE_PARTICLE_NOISE', 'PF_TYPE_PARTICLE_AGE',
    'PF_TYPE_PARTICLE_AGE_NORMALIZED', 'PF_TYPE_PARTICLE_FLOAT', 'PF_TYPE_PARTICLE_INITIAL_FLOAT',
    'PF_TYPE_PARTICLE_VECTOR_COMPONENT', 'PF_TYPE_PARTICLE_INITIAL_VECTOR_COMPONENT', 'PF_TYPE_PARTICLE_SPEED',
    'PF_TYPE_PARTICLE_NUMBER', 'PF_TYPE_PARTICLE_NUMBER_NORMALIZED', 'PF_TYPE_PARTICLE_ROPE_SEGMENT',
    'PF_TYPE_PARTICLE_ROPE_SEGMENT_NORMALIZED', 'PF_TYPE_PARTICLE_SCREENSPACE_CAMERA_DISTANCE',
    'PF_TYPE_PARTICLE_SCREENSPACE_CAMERA_DOT_PRODUCT'],
  m_nMapType: ['PF_MAP_TYPE_DIRECT', 'PF_MAP_TYPE_MULT', 'PF_MAP_TYPE_REMAP', 'PF_MAP_TYPE_REMAP_BIASED', 'PF_MAP_TYPE_CURVE',
    'PF_MAP_TYPE_NOTCHED', 'PF_MAP_TYPE_ROUND', 'PF_MAP_TYPE_MIN', 'PF_MAP_TYPE_MAX', 'PF_MAP_TYPE_MOD'],
  m_nInputMode: ['PF_INPUT_MODE_CLAMPED', 'PF_INPUT_MODE_LOOPED'],
  m_nBiasType: ['PF_BIAS_TYPE_STANDARD', 'PF_BIAS_TYPE_GAIN', 'PF_BIAS_TYPE_EXPONENTIAL'],
  m_nRandomMode: ['PF_RANDOM_MODE_CONSTANT', 'PF_RANDOM_MODE_VARYING'],
  m_nRoundType: ['PF_ROUND_TYPE_NEAREST', 'PF_ROUND_TYPE_FLOOR', 'PF_ROUND_TYPE_CEIL'],
};
const VEC_TYPES = ['PVEC_TYPE_LITERAL', 'PVEC_TYPE_LITERAL_COLOR', 'PVEC_TYPE_NAMED_VALUE', 'PVEC_TYPE_PARTICLE_VECTOR',
  'PVEC_TYPE_PARTICLE_INITIAL_VECTOR', 'PVEC_TYPE_PARTICLE_VELOCITY', 'PVEC_TYPE_PARTICLE_GRAVITY', 'PVEC_TYPE_CP_VALUE',
  'PVEC_TYPE_CP_RELATIVE_POSITION', 'PVEC_TYPE_CP_RELATIVE_DIR', 'PVEC_TYPE_CP_RELATIVE_RANDOM_DIR', 'PVEC_TYPE_FLOAT_COMPONENTS',
  'PVEC_TYPE_FLOAT_INTERP_CLAMPED', 'PVEC_TYPE_FLOAT_INTERP_OPEN', 'PVEC_TYPE_FLOAT_INTERP_GRADIENT', 'PVEC_TYPE_RANDOM_UNIFORM',
  'PVEC_TYPE_RANDOM_UNIFORM_OFFSET', 'PVEC_TYPE_CP_DELTA', 'PVEC_TYPE_CLOSEST_CAMERA_POSITION'];

const f = (inp, k) => {
  const v = inp[k] ?? FLOAT_D[k];
  return typeof v === 'number' && ENUM_INT[k] ? ENUM_INT[k][v] : v;
};
const short = (n) => ({ m_nType: 'PF_TYPE_LITERAL', m_flLiteralValue: +n });
export const asFloatInput = (inp) => (inp == null ? short(0) : typeof inp === 'number' ? short(inp) : inp);
export const asVecInput = (inp) => (inp == null ? { m_nType: 'PVEC_TYPE_LITERAL', m_vLiteralValue: [0, 0, 0] }
  : Array.isArray(inp) ? { m_nType: 'PVEC_TYPE_LITERAL', m_vLiteralValue: inp.map(Number) } : inp);

// A per-input random seed. The game reads it from an op seed block (input+0x88) plus a per-frame
// op seed (coll+0x918); neither is extracted, so m_nRandomSeed is used when set and otherwise a
// stable per-input number. UNSETTLED: seed values (RE §11 UNSETTLED 3).
// The number comes from a counter owned by the ParticleSystem (ctx.sys), not the module: a module counter carried
// over from one system to the next, so the same system with the same table drew different CONSTANT randoms on
// its second build in one process.
const seeds = new WeakMap();
const seedOf = (inp, ctx) => {
  const s = f(inp, 'm_nRandomSeed');
  if (s >= 0) return s | 0;
  if (!seeds.has(inp)) {
    const owner = ctx?.sys || ctx || {};
    const n = owner._inputSeed = ((owner._inputSeed ?? 0x9e37) * 1103515245 + 12345) & 0x7fffffff;
    seeds.set(inp, n & 0xfff);
  }
  return seeds.get(inp);
};

// One random draw for an input (RE §11 randomTable): VARYING advances the counter; CONSTANT
// uses the seed plus, per particle, the particle's ID. `extra` = 0x25 for the sign-flip draw.
const draw = (inp, ctx, i, extra = 0) => {
  if (f(inp, 'm_nRandomMode') === 'PF_RANDOM_MODE_VARYING') return drawVarying(ctx);
  const pid = i >= 0 && ctx.attr ? ctx.attr[A.ID][i] : 0;
  return drawConstant(ctx, seedOf(inp, ctx) + (ctx.rnd?.frameSeed || 0) + extra, pid);
};

// Bias (RE §11, precompute 0x18005b5b0, apply 0x18006f1e0).
export const bias = (t, type, p) => {
  if (type === 'PF_BIAS_TYPE_EXPONENTIAL') {
    const e = p >= 0 ? 1 - clamp(p, 0, 1) : 20 - 19 * clamp(p + 1, 0, 1);
    if (e <= 0) return 1;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return Math.pow(t, Math.min(e, 20));
  }
  const b = clamp((p + 1) * 0.5, 0, 1);
  if (b <= 0) return 0;
  if (b >= 1) return 1;
  const k = 1 / b - 2;
  const schlick = (x) => x / ((1 - x) * k + 1);
  if (type === 'PF_BIAS_TYPE_GAIN') return t < 0.5 ? 0.5 * schlick(2 * t) : 1 - 0.5 * schlick(2 - 2 * t);
  return schlick(t);
};

// CURVE (RE §11, 0x18036fb10): under 2 points gives 0; Hermite from the left point's outgoing and
// the right point's incoming slope; clamped to the domain's y range. m_tangents is editor data.
export const curve = (c, x) => {
  const pts = (c && c.m_spline) || [];
  if (pts.length < 2) return 0;
  const X = (p) => +(p.x ?? p.m_flX ?? 0), Y = (p) => +(p.y ?? p.m_flY ?? 0);
  let lo = 0, hi = pts.length - 1;
  if (x <= X(pts[0])) hi = 1;
  else if (x >= X(pts[hi])) lo = hi - 1;
  else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (X(pts[m]) <= x) lo = m; else hi = m; } }
  const p0 = pts[lo], p1 = pts[lo + 1] || pts[lo];
  const dx = X(p1) - X(p0), dy = Y(p1) - Y(p0);
  const t = dx !== 0 ? clamp((x - X(p0)) / dx, 0, 1) : 0;
  const m0 = +(p0.m_flSlopeOutgoing ?? 0), m1 = +(p1.m_flSlopeIncoming ?? 0);
  const y = Y(p0) + m0 * dx * t + (3 * dy - (2 * m0 + m1) * dx) * t * t + ((m0 + m1) * dx - 2 * dy) * t * t * t;
  const mins = c.m_vDomainMins || [0, 0], maxs = c.m_vDomainMaxs || [0, 0];
  return clamp(y, Math.min(mins[1], maxs[1]), Math.max(mins[1], maxs[1]));
};

// Round half to even, the SSE cvtps2dq default rounding (RE §11 ROUND NEAREST).
const roundEven = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r; };

// The ten map types applied to a source value x (RE §11 map types, 0x18005ca10..0x180061f20).
// Exported for C_OP_SetControlPointFieldToScalarExpression's output remap, which uses the map alone.
export function applyMap(inp, x) {
  const map = f(inp, 'm_nMapType');
  const in0 = f(inp, 'm_flInput0'), in1 = f(inp, 'm_flInput1');
  const out0 = f(inp, 'm_flOutput0'), out1 = f(inp, 'm_flOutput1');
  const looped = f(inp, 'm_nInputMode') === 'PF_INPUT_MODE_LOOPED';
  switch (map) {
    case 'PF_MAP_TYPE_MULT': return x * f(inp, 'm_flMultFactor');
    case 'PF_MAP_TYPE_REMAP':
    case 'PF_MAP_TYPE_REMAP_BIASED': {
      // LOOPED wraps with period m_flInput1 alone (0x18005da90); a zero range steps at in0.
      if (looped) x = (x / in1 - Math.floor(x / in1)) * in1;
      let t = in1 === in0 ? (x >= in0 ? 1 : 0) : (x - in0) / (in1 - in0);
      if (map === 'PF_MAP_TYPE_REMAP_BIASED') t = bias(Math.min(t, 1), f(inp, 'm_nBiasType'), f(inp, 'm_flBiasParameter'));
      return clamp(out0 + t * (out1 - out0), Math.min(out0, out1), Math.max(out0, out1));
    }
    case 'PF_MAP_TYPE_CURVE': {
      const c = f(inp, 'm_Curve');
      if (looped) { const P = (c.m_vDomainMaxs || [0])[0]; x = (x / P - Math.floor(x / P)) * P; }
      return curve(c, x);
    }
    case 'PF_MAP_TYPE_NOTCHED': {
      // Both ends inclusive; the input mode is not applied (0x18005fb60).
      const a = f(inp, 'm_flNotchedRangeMin'), b = f(inp, 'm_flNotchedRangeMax');
      return Math.min(a, b) <= x && x <= Math.max(a, b) ? f(inp, 'm_flNotchedOutputInside') : f(inp, 'm_flNotchedOutputOutside');
    }
    case 'PF_MAP_TYPE_ROUND': {
      const r = f(inp, 'm_nRoundType');
      return r === 'PF_ROUND_TYPE_FLOOR' ? Math.floor(x) : r === 'PF_ROUND_TYPE_CEIL' ? Math.ceil(x) : roundEven(x);
    }
    case 'PF_MAP_TYPE_MIN': return Math.min(x, f(inp, 'm_flCompareValue'));
    case 'PF_MAP_TYPE_MAX': return Math.max(x, f(inp, 'm_flCompareValue'));
    case 'PF_MAP_TYPE_MOD': { const c = f(inp, 'm_flCompareValue'); return x - Math.trunc(x / c) * c; }
    default: return x; // DIRECT, and INVALID (CParticleRemapFloatInput's default)
  }
}

// Types a collection-level evaluation supports: {0..8, 10..18}; anything else yields 0 (0x18005ad90).
const COLLECTION_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
const typeIndex = (t) => ENUM_INT.m_nType.indexOf(t);

const particleScalar = (ctx, a, i, initial) => {
  const s = (initial ? ctx.init : ctx.attr)[a];
  if (!s || VECTOR_ATTRS.has(a)) return 0;
  // Angles read as degrees; int attributes (Int32Array) convert to float on read.
  return ANGLE_ATTRS.has(a) ? s[i] * DEG : s[i];
};

// The source value of a non-literal, non-random input (RE §11 sourceTypes, 0x18005ca10 / 0x18006f510).
function source(inp, ctx, i, kind) {
  let type = f(inp, 'm_nType');
  // In an initializer INITIAL_FLOAT reads the current value, INITIAL_VECTOR_COMPONENT likewise (0x18005acd0).
  if (kind === 'init' && type === 'PF_TYPE_PARTICLE_INITIAL_FLOAT') type = 'PF_TYPE_PARTICLE_FLOAT';
  if (kind === 'init' && type === 'PF_TYPE_PARTICLE_INITIAL_VECTOR_COMPONENT') type = 'PF_TYPE_PARTICLE_VECTOR_COMPONENT';
  if (i < 0 && !COLLECTION_TYPES.has(typeIndex(type))) return 0;
  const cp = () => getCp(ctx, f(inp, 'm_nControlPoint'));
  const dt0 = ctx.dt !== 0 ? ctx.dt : 0.1;
  switch (type) {
    case 'PF_TYPE_COLLECTION_AGE': return ctx.time;
    case 'PF_TYPE_ENDCAP_AGE': return ctx.endcap?.active ? ctx.time - ctx.endcap.start : 0;
    case 'PF_TYPE_CONTROL_POINT_COMPONENT': {
      // clamp(component, 0, 3); 3 reads the next float of the CP record, previous position x.
      const k = clamp(f(inp, 'm_nVectorComponent') | 0, 0, 3);
      const c = cp();
      return k < 3 ? c.position[k] : c.prevPosition[0];
    }
    case 'PF_TYPE_CONTROL_POINT_CHANGE_AGE': return ctx.time - cp().changeTime;
    case 'PF_TYPE_CONTROL_POINT_SPEED': { const c = cp(); return len(sub(c.position, c.prevPosition)) / dt0; }
    case 'PF_TYPE_CONTROL_POINT_DISTANCE': {
      const s = ctx.attr[A.POSITION];
      return len(sub([s[3 * i], s[3 * i + 1], s[3 * i + 2]], cp().position));
    }
    case 'PF_TYPE_PARTICLE_DETAIL_LEVEL': {
      // m_flLOD0..3 by the global detail level (0x1803845a0). UNSETTLED: which level the preview
      // stands for; opts.detailLevel, default 0.
      return f(inp, `m_flLOD${clamp(ctx.sys?.detailLevel | 0, 0, 3)}`);
    }
    case 'PF_TYPE_CONCURRENT_DEF_COUNT': return ctx.concurrent ? ctx.concurrent() : 1;
    case 'PF_TYPE_CLOSEST_CAMERA_DISTANCE': {
      const cam = ctx.sys?.camera?.();
      return cam ? len(sub(cam, cp().position)) : f(inp, 'm_flNoCameraFallback');
    }
    case 'PF_TYPE_SNAPSHOT_COUNT':
    case 'PF_TYPE_SNAPSHOT_CHANGED': return 0; // no snapshot CP in a preview
    case 'PF_TYPE_CONTROL_POINT_IS_SET': return cp().changeTime !== -1 ? 1 : 0;
    case 'PF_TYPE_PARTICLE_AGE': return ctx.time - ctx.attr[A.CREATION][i];
    case 'PF_TYPE_PARTICLE_AGE_NORMALIZED': {
      const life = ctx.attr[A.LIFE][i];
      return life <= 0 ? 0 : (ctx.time - ctx.attr[A.CREATION][i]) / life;
    }
    case 'PF_TYPE_PARTICLE_FLOAT': return particleScalar(ctx, f(inp, 'm_nScalarAttribute'), i, false);
    case 'PF_TYPE_PARTICLE_INITIAL_FLOAT': return particleScalar(ctx, f(inp, 'm_nScalarAttribute'), i, true);
    case 'PF_TYPE_PARTICLE_VECTOR_COMPONENT':
    case 'PF_TYPE_PARTICLE_INITIAL_VECTOR_COMPONENT': {
      const s = (type === 'PF_TYPE_PARTICLE_VECTOR_COMPONENT' ? ctx.attr : ctx.init)[f(inp, 'm_nVectorAttribute')];
      const k = clamp(f(inp, 'm_nVectorComponent') | 0, 0, 2); // UNSETTLED: component 3 of a vector stream
      return s ? s[3 * i + k] : 0;
    }
    case 'PF_TYPE_PARTICLE_SPEED': {
      const p = ctx.attr[A.POSITION], q = ctx.attr[A.PREV];
      return Math.hypot(p[3 * i] - q[3 * i], p[3 * i + 1] - q[3 * i + 1], p[3 * i + 2] - q[3 * i + 2]) / dt0;
    }
    case 'PF_TYPE_PARTICLE_NOISE':
      // Noise inputs are RE §11 UNSETTLED 2. Placeholder, not the game's value: the middle of the
      // noise output range. UNSETTLED.
      ctx.sys?.report(`${ctx.path}: PF_TYPE_PARTICLE_NOISE is UNSETTLED; using the middle of the noise output range`);
      return (f(inp, 'm_flNoiseOutputMin') + f(inp, 'm_flNoiseOutputMax')) / 2;
    case 'PF_TYPE_PARTICLE_NUMBER_NORMALIZED': {
      // particles.dll 63babcbf 0x18006f510 case 0x1b: the particle's index (block * 4 + lane; the lane offsets
      // DAT_1805ea540 are runtime-initialised, read as 0..3) * 1 / max(1, n), n = coll+0x74 - 1, or coll+0x74 when the
      // definition's behaviour version (+8) is below 12 (DAT_180534200 = 1). m_bReverseOrder is not read by this case.
      const n = Math.max(1, (ctx.def?.m_nBehaviorVersion | 0) < 12 ? ctx.count : ctx.count - 1);
      return i * (1 / n);
    }
    default:
      ctx.sys?.report(`${ctx.path}: float input type ${type} not implemented (reads 0)`);
      return 0;
  }
}

// A float input's value (RE §11 "Float inputs").
export function evalFloat(input, ctx, i = -1, kind = 'op') {
  const inp = asFloatInput(input);
  const type = f(inp, 'm_nType');
  // LITERAL returns m_flLiteralValue unchanged under every map type (case 0 of all ten evaluators).
  if (type === 'PF_TYPE_LITERAL') return f(inp, 'm_flLiteralValue');
  if (type === 'PF_TYPE_RANDOM_UNIFORM' || type === 'PF_TYPE_RANDOM_BIASED') {
    // m_nMapType is ignored: REMAP (or REMAP_BIASED) from [0,1] to [min,max], clamped, then the sign
    // flip when a second draw is below 0.5 (0x18005b3b0, 0x180090850).
    const lo = f(inp, 'm_flRandomMin'), hi = f(inp, 'm_flRandomMax');
    let t = draw(inp, ctx, i);
    if (type === 'PF_TYPE_RANDOM_BIASED') t = bias(Math.min(t, 1), f(inp, 'm_nBiasType'), f(inp, 'm_flBiasParameter'));
    let v = clamp(lo + t * (hi - lo), Math.min(lo, hi), Math.max(lo, hi));
    if (f(inp, 'm_bHasRandomSignFlip') && draw(inp, ctx, i, 0x25) < 0.5) v = -v;
    return v;
  }
  const x = source(inp, ctx, i, kind);
  // PARTICLE_DETAIL_LEVEL is broadcast as-is under CURVE (0x18005f1a2).
  if (type === 'PF_TYPE_PARTICLE_DETAIL_LEVEL' && f(inp, 'm_nMapType') === 'PF_MAP_TYPE_CURVE') return x;
  return applyMap(inp, x);
}

const v3 = (inp, k) => { const v = inp[k] ?? VEC_D[k]; return [+v[0], +v[1], +v[2]]; };
const vt = (inp) => { const t = inp.m_nType ?? VEC_D.m_nType; return typeof t === 'number' ? VEC_TYPES[t] : t; };

// Gradient stops sampled at t. The sampler (0x1800c2070) is not in the notes, so this is a
// linear blend between neighbouring stops, colour as 0..255 bytes / 255. UNSETTLED.
const gradient = (g, t) => {
  const stops = (g && g.m_Stops) || [];
  if (!stops.length) return [0, 0, 0];
  const c = (s) => { const k = s.m_Color || [0, 0, 0]; return [k[0] / 255, k[1] / 255, k[2] / 255]; };
  const p = (s) => +(s.m_flPosition ?? 0);
  if (t <= p(stops[0])) return c(stops[0]);
  for (let k = 1; k < stops.length; k++) {
    if (t <= p(stops[k])) {
      const a = p(stops[k - 1]), b = p(stops[k]);
      const u = b > a ? (t - a) / (b - a) : 0;
      const x = c(stops[k - 1]), y = c(stops[k]);
      return [x[0] + (y[0] - x[0]) * u, x[1] + (y[1] - x[1]) * u, x[2] + (y[2] - x[2]) * u];
    }
  }
  return c(stops[stops.length - 1]);
};

// A vector input's value (RE §11 "Vector inputs", 0x1800bfa80 / 0x1800bf0f0).
export function evalVec(input, ctx, i = -1, kind = 'op') {
  const inp = asVecInput(input);
  let type = vt(inp);
  if (kind === 'init' && type === 'PVEC_TYPE_PARTICLE_INITIAL_VECTOR') type = 'PVEC_TYPE_PARTICLE_VECTOR';
  const cp = (k = 'm_nControlPoint') => getCp(ctx, inp[k] ?? VEC_D[k]);
  switch (type) {
    case 'PVEC_TYPE_LITERAL': return v3(inp, 'm_vLiteralValue');
    case 'PVEC_TYPE_LITERAL_COLOR': {
      // rgb * (1/255), alpha ignored (0.0039216).
      const c = inp.m_LiteralColor ?? VEC_D.m_LiteralColor;
      return [c[0] * 0.0039216, c[1] * 0.0039216, c[2] * 0.0039216];
    }
    case 'PVEC_TYPE_PARTICLE_VECTOR':
    case 'PVEC_TYPE_PARTICLE_INITIAL_VECTOR':
    case 'PVEC_TYPE_PARTICLE_VELOCITY': {
      if (i < 0) return [0, 0, 0]; // collection evaluation of these returns 0
      const s3 = v3(inp, 'm_vVectorAttributeScale');
      if (type === 'PVEC_TYPE_PARTICLE_VELOCITY') {
        const p = ctx.attr[A.POSITION], q = ctx.attr[A.PREV], r = ctx.dt !== 0 ? 1 / ctx.dt : 0;
        return [0, 1, 2].map((k) => (p[3 * i + k] - q[3 * i + k]) * r * s3[k]);
      }
      const s = (type === 'PVEC_TYPE_PARTICLE_VECTOR' ? ctx.attr : ctx.init)[inp.m_nVectorAttribute ?? VEC_D.m_nVectorAttribute];
      return s && s.length >= 3 * (i + 1) ? [0, 1, 2].map((k) => s[3 * i + k] * s3[k]) : [0, 0, 0];
    }
    case 'PVEC_TYPE_CP_VALUE': { const c = cp(), s = v3(inp, 'm_vCPValueScale'); return [c.position[0] * s[0], c.position[1] * s[1], c.position[2] * s[2]]; }
    case 'PVEC_TYPE_CP_RELATIVE_POSITION': {
      // CP matrix (forward, left, up, pos) times m_vCPRelativePosition.
      const c = cp(), r = v3(inp, 'm_vCPRelativePosition');
      return [0, 1, 2].map((k) => c.position[k] + c.forward[k] * r[0] + c.left[k] * r[1] + c.up[k] * r[2]);
    }
    case 'PVEC_TYPE_CP_RELATIVE_DIR': {
      const c = cp(), r = v3(inp, 'm_vCPRelativeDir');
      return [0, 1, 2].map((k) => c.forward[k] * r[0] + c.left[k] * r[1] + c.up[k] * r[2]);
    }
    case 'PVEC_TYPE_FLOAT_COMPONENTS':
      return ['m_FloatComponentX', 'm_FloatComponentY', 'm_FloatComponentZ'].map((k) => evalFloat(inp[k], ctx, i, kind));
    case 'PVEC_TYPE_FLOAT_INTERP_CLAMPED':
    case 'PVEC_TYPE_FLOAT_INTERP_OPEN':
    case 'PVEC_TYPE_FLOAT_INTERP_GRADIENT': {
      // t = (f - in0)/(in1 - in0) with no zero-range guard; CLAMPED clamps t, OPEN does not.
      const fv = evalFloat(inp.m_FloatInterp, ctx, i, kind);
      const in0 = inp.m_flInterpInput0 ?? VEC_D.m_flInterpInput0, in1 = inp.m_flInterpInput1 ?? VEC_D.m_flInterpInput1;
      let t = (fv - in0) / (in1 - in0);
      if (type === 'PVEC_TYPE_FLOAT_INTERP_GRADIENT') return gradient(inp.m_Gradient, t);
      if (type === 'PVEC_TYPE_FLOAT_INTERP_CLAMPED') t = clamp(t, 0, 1);
      const o0 = v3(inp, 'm_vInterpOutput0'), o1 = v3(inp, 'm_vInterpOutput1');
      return [0, 1, 2].map((k) => o0[k] + t * (o1[k] - o0[k]));
    }
    case 'PVEC_TYPE_CP_DELTA': { const a = cp(), b = cp('m_nDeltaControlPoint'); return sub(a.position, b.position); }
    case 'PVEC_TYPE_RANDOM_UNIFORM':
    case 'PVEC_TYPE_RANDOM_UNIFORM_OFFSET': {
      // min + r*(max-min) per component, seen for one lane in the decompile only (0x1800c1c70).
      // UNSETTLED (RE §11 UNSETTLED 2), including what _OFFSET adds.
      ctx.sys?.report(`${ctx.path}: ${type} is UNSETTLED`);
      const lo = v3(inp, 'm_vRandomMin'), hi = v3(inp, 'm_vRandomMax');
      return [0, 1, 2].map((k) => lo[k] + drawVarying(ctx) * (hi[k] - lo[k]));
    }
    default:
      ctx.sys?.report(`${ctx.path}: vector input type ${type} not implemented (reads 0)`);
      return [0, 0, 0];
  }
}
