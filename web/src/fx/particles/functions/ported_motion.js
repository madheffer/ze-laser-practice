// Ported from CS2's particles.dll (tools/particles/PORTING.md): each entry cites the build and the address it was read
// from. The motion group: see the comment on each class. Build: particles.dll md5 63babcbf3245e56855a777134323e74a
// ("63babcbf" below). Constants are cited by address; read them with tools/particles/consts.py.
import { A, VECTOR_ATTRS, add, sub, mul, dot, cross, len, norm, clamp, sat, getV, setV, getCp, drawVarying, drawConstant, FLT_EPSILON, FLT_MAX, angleVectors, attrIndex, cpPositionAt, kill, outputClamp, report, toWorld, transformOf, DEG2RAD, FLT_MIN } from './common.js';
import { applyMap, evalFloat, evalVec } from '../inputs.js';

export const PI = 3.14159274; // DAT_180534284
const TWO_PI = 6.28318548; // DAT_1805342c8 (scalar), DAT_180534a20 / -DAT_180534cb0 (x4)
export const age = (c, i) => c.time - c.attr[A.CREATION][i];
// The class's set method as its ParticleSetMethod_t index (KV3 may carry the name or the int).
const SET_METHODS = ['PARTICLE_SET_REPLACE_VALUE', 'PARTICLE_SET_SCALE_INITIAL_VALUE', 'PARTICLE_SET_ADD_TO_INITIAL_VALUE',
  'PARTICLE_SET_RAMP_CURRENT_VALUE', 'PARTICLE_SET_SCALE_CURRENT_VALUE', 'PARTICLE_SET_ADD_TO_CURRENT_VALUE'];
export const setMethod = (m) => (typeof m === 'number' ? m : Math.max(0, SET_METHODS.indexOf(m)));
// Scalar stream check shared by the scalar operators: a vector or missing output is reported, never written.
export const scalarOut = (c, cls, out) => {
  if (VECTOR_ATTRS.has(out) || !c.attr[out]) { report(c, `${cls} output ${out} is not a scalar stream`); return false; }
  return true;
};
// Output range clamp of the slot-6 inits (0x1801cf320 / 0x18020b0e0 / 0x180202d30): mask 0x10080 [0,1], 0x408 [0,FLT_MAX].
const clampOut = (out) => outputClamp(out);
// MatrixBuildRotationAboutAxis (0x18035d0c0): degrees (x DAT_180534170), applied as M*v (rows +0x00/+0x10/+0x20).
const rotateAboutAxis = (k, deg, v) => {
  const a = deg * DEG2RAD, s = Math.sin(a), co = Math.cos(a), t = 1 - co;
  const [x, y, z] = k;
  return [
    (x * x * t + co) * v[0] + (x * y * t - z * s) * v[1] + (x * z * t + y * s) * v[2],
    (x * y * t + z * s) * v[0] + (y * y * t + co) * v[1] + (y * z * t - x * s) * v[2],
    (x * z * t - y * s) * v[0] + (y * z * t + x * s) * v[1] + (z * z * t + co) * v[2],
  ];
};
// VectorNormalize with a fallback (0x180122c90): a zero vector returns the fallback.
const normOr = (v, fb) => { const l = len(v); return l > 0 ? mul(v, 1 / l) : fb.slice(); };

// The 3D value noise C_INIT_AgeNoise samples (0x180366520). Cell = floor(p); hash of ((iz<<10)+iy)<<10)+ix plus the
// corner offsets (0,1,1024,1025) / +1048576 (static init 0x18000d3f0 -> 0x1805ea6e0/6f0); murmur-style mix with
// 0x4c9e2d51, 0x1b873593, *5 + 0xe6546b64, 0x04b2b735 (0x18046b7f0 / b750 / b6d0 / b840 / b740), 31-bit masks
// (DAT_180534bd0); value = ((h >> 16 ^ h) & 0xffff) / 65535 (0x18046b720 / b760). Trilinear weights with no fade
// (0x18000d2d0..d3b0 -> 0x1805ea700..810), then (sum - 0.5) * 2 (DAT_1805341b8): about [-1, 1].
const M31 = 0x7fffffff;
const cornerValue = (h) => {
  let a = Math.imul(h, 0x4c9e2d51) & M31;
  a = (a >> 17) | (a << 15);
  a = Math.imul(a, 0x1b873593) & M31;
  a = (a >> 19) | (a << 13);
  a = (Math.imul(a, 5) + 0xe6546b64) | 0;
  a = ((a >> 16) ^ a) & M31;
  a = Math.imul(a, 0x04b2b735);
  return (((a >> 16) ^ a) & 0xffff) / 65535;
};
export const noise3 = (x, y, z) => {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z;
  const base = ((((Z | 0) << 10) + (Y | 0)) << 10) + (X | 0) | 0;
  const off = [0, 1, 1024, 1025];
  const wx = [1 - fx, fx, 1 - fx, fx], wy = [1 - fy, 1 - fy, fy, fy];
  let s = 0;
  for (let k = 0; k < 4; k++) {
    s += cornerValue((base + off[k]) | 0) * wy[k] * wx[k] * (1 - fz);
    s += cornerValue((base + off[k] + 1048576) | 0) * wy[k] * wx[k] * fz;
  }
  return (s - 0.5) * 2;
};

// Spin and SpinUpdate (and their yaw twins) share the bodies; `out` is the class's own slot-38 attribute.
const spinOp = (out) => (fn, c, s) => {
  // Slot 6 (0x1801d6a90): degrees -> radians (DAT_180534170) into +0x1e8 / +0x1f0.
  const rate = (fn.m_nSpinRateDegrees | 0) * DEG2RAD, minRate = (fn.m_nSpinRateMinDegrees | 0) * DEG2RAD;
  const cur = s * rate;
  if (cur === 0) return;
  const stop = +fn.m_fSpinRateStopTime || 0;
  // |cur + cur| * pi * dt (0x1801d6b9e addss, mulss DAT_180534284, andps abs, mulss dt): the per-frame step really is
  // 2*pi*radians/s, the Source FIXME carried over. fmod 2pi when the stop time is 0, sign of cur restored.
  let step = Math.abs((cur + cur) * PI) * c.dt;
  if (stop === 0) step %= TWO_PI;
  if (cur < 0) step = -step;
  // The minimum: (min + min) * pi * dt with no abs and no strength (0x1801d6bff..c4e).
  const minStep = (minRate + minRate) * PI * c.dt;
  const a = c.attr[out];
  for (let i = 0; i < c.count; i++) {
    let k = 0; // stop time 0: the reciprocal lane is 0, so the factor is 1
    if (stop !== 0) {
      const d = c.attr[A.LIFE][i] * stop;
      k = 1 / (Math.abs(d) < FLT_MIN ? (d < 0 ? -FLT_EPSILON : FLT_EPSILON) : d); // rcpps of (d | FLT_EPSILON bits), exact
    }
    let delta = Math.max(0, 1 - age(c, i) * k) * step;
    if (cur < 0 ? minStep <= delta : delta <= minStep) delta = minStep;
    let v = delta + a[i];
    // Wrap by 2pi (DAT_180534a20 / DAT_180534cb0). UNSETTLED: the game skips the wrap when coll+0x50 > +0x58 >= +0x54,
    // coll+0x2a0 is set and !(coll+0x8c1 & 0x10); those fields are not decoded, so the wrap always runs here.
    const w = v >= TWO_PI ? v - TWO_PI : v;
    a[i] = v <= -TWO_PI ? w + TWO_PI : w;
  }
};
const spinUpdateOp = (out, speed) => (fn, c, s) => {
  // value += min(dt, age) * strength * speed (minps dt, curTime - creation).
  for (let i = 0; i < c.count; i++) c.attr[out][i] += Math.min(c.dt, age(c, i)) * s * c.attr[speed][i];
};

export const ported_motion = {
  // particles.dll 63babcbf C_OP_Spin: slot 6 0x1801d6a90, Operate slot 34 0x1801d6ad0, attribute slot 38 0x1801d6fb0 (4).
  C_OP_Spin: { evidence: 'RE', op: spinOp(A.ROLL) },

  // particles.dll 63babcbf C_OP_SpinUpdate: Operate slot 34 0x1801d6e70; roll (slot 38 -> 4) += min(dt, age) * strength *
  // roll speed (slot 39 0x180143510 -> 5).
  C_OP_SpinUpdate: { evidence: 'RE', op: spinUpdateOp(A.ROLL, A.ROLL_SPEED) },

  // particles.dll 63babcbf C_OP_TwistAroundAxis is a force generator: slot 34 0x1801105c0 (this, acc, coll, _, count,
  // strength). axis = m_TwistAxis, through the CP frame when m_bLocalSpace (0x1800e7390: forward*x + left*y + up*z),
  // normalised (rsqrtps + Newton, exact here); centre = CP position at curTime (0x180053d30). Per particle:
  // dn = normalize(p - C); v = dn * (1 - n.dn) (sic: dn, not n, is scaled; disassembly 0x1801107f5..80e);
  // acc += cross(normalize(v), n) * force * strength, only where |p - C|^2 and |v|^2 exceed FLT_EPSILON (DAT_1805890b0).
  // `acc` is a flat [x, y, z] * count array (C_OP_BasicMovement fills it, ported_movement.js). UNSETTLED: the axis-frame CP is m_nControlPointNumber only when *(def+8) > 2 (else 0),
  // a definition field not decoded (taken as m_nControlPointNumber).
  C_OP_TwistAroundAxis: {
    evidence: 'RE',
    force(fn, c, acc, s) {
      const cp = getCp(c, fn.m_nControlPointNumber | 0);
      const ax = fn.m_TwistAxis || [0, 0, 1];
      const n = norm(fn.m_bLocalSpace ? toWorld(cp, ax) : ax);
      const C = cp.position;
      const k = s * (+fn.m_fForceAmount || 0);
      for (let i = 0; i < c.count; i++) {
        const d = sub(getV(c, A.POSITION, i), C), d2 = dot(d, d);
        const dn = mul(d, 1 / Math.sqrt(d2));
        const v = mul(dn, 1 - dot(n, dn)), v2 = dot(v, v);
        if (!(d2 > FLT_EPSILON && v2 > FLT_EPSILON)) continue;
        const f = mul(cross(mul(v, 1 / Math.sqrt(v2)), n), k);
        acc[3 * i] += f[0]; acc[3 * i + 1] += f[1]; acc[3 * i + 2] += f[2];
      }
    },
  },

  // particles.dll 63babcbf C_OP_MovementRotateParticleAroundAxis: Operate slot 34 0x1801f5580. angle = dt * m_flRotRate
  // (degrees, collection input); axis = m_vecRotAxis normalised (0x180122c90, zero -> (0,0,1) = local_860 / DAT_180534200),
  // rotated by the transform's quaternion when m_bLocalSpace; centre = the transform position. M =
  // MatrixBuildRotationAboutAxis (0x18035d0c0); position and previous position each move toward C + M(p - C) by the
  // strength: p += (C + M(p - C) - p) * s.
  C_OP_MovementRotateParticleAroundAxis: {
    evidence: 'RE',
    op(fn, c, s) {
      const ang = c.dt * evalFloat(fn.m_flRotRate, c, -1);
      const tr = transformOf(c, fn.m_TransformInput);
      let k = normOr(evalVec(fn.m_vecRotAxis, c, -1), [0, 0, 1]);
      if (fn.m_bLocalSpace) k = toWorld(tr, k);
      const C = tr.position;
      for (let i = 0; i < c.count; i++) {
        for (const a of [A.POSITION, A.PREV]) {
          const p = getV(c, a, i);
          const t = add(C, rotateAboutAxis(k, ang, sub(p, C)));
          setV(c, a, i, add(p, mul(sub(t, p), s)));
        }
      }
    },
  },

  // particles.dll 63babcbf C_OP_RotateVector: slot 6 0x1801f5bc0 (a zero min/max axis becomes (0,0,1), both normalised
  // by 0x1800522b0), Operate slot 34 0x1801f5c40. r = T[(pid + c914) & 0xfff] (one draw per particle, constant);
  // axis = normalize(lerp(min, max, r)) (zero -> 0); angle = lerp(rateMin, rateMax, r) * m_flScale(i) * dt degrees;
  // v' = M v (0x18035ec80), normalised when m_bNormalize and nonzero; v += (v' - v) * strength.
  C_OP_RotateVector: {
    evidence: 'RE',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nFieldOutput, A.NORMAL);
      if (!VECTOR_ATTRS.has(out)) { report(c, `C_OP_RotateVector output ${out} is not a vector stream`); return; }
      const fix = (v) => { const a = v || [0, 0, 0]; return a[0] === 0 && a[1] === 0 && a[2] === 0 ? [0, 0, 1] : norm(a); };
      const mn = fix(fn.m_vecRotAxisMin), mx = fix(fn.m_vecRotAxisMax);
      for (let i = 0; i < c.count; i++) {
        const r = drawConstant(c, 0, c.attr[A.ID][i]);
        const k = normOr(add(mn, mul(sub(mx, mn), r)), [0, 0, 0]);
        const deg = ((fn.m_flRotRateMax - fn.m_flRotRateMin) * r + fn.m_flRotRateMin) * evalFloat(fn.m_flScale, c, i) * c.dt;
        const v = getV(c, out, i);
        let w = rotateAboutAxis(k, deg, v);
        if (fn.m_bNormalize && (w[0] !== 0 || w[1] !== 0 || w[2] !== 0)) w = norm(w);
        setV(c, out, i, add(v, mul(sub(w, v), s)));
      }
    },
  },

  // particles.dll 63babcbf C_INIT_RandomYawFlip: Init slot 34 0x180150910. One VARYING draw per particle; below
  // m_flPercent the yaw becomes fmod(yaw, pi) + pi (DAT_180534284).
  C_INIT_RandomYawFlip: {
    evidence: 'RE',
    init(fn, c, start, end) {
      for (let i = start; i < end; i++) {
        if (drawVarying(c) < +fn.m_flPercent) c.attr[A.YAW][i] = (c.attr[A.YAW][i] % PI) + PI;
      }
    },
  },

  // particles.dll 63babcbf C_INIT_RandomSecondSequence: Init slot 34 0x180150a50. sequence 1 (attribute 13) =
  // (int)((max - min + 1) * r) + min, r one VARYING draw per particle (truncated toward zero, stored as float).
  C_INIT_RandomSecondSequence: {
    evidence: 'RE',
    init(fn, c, start, end) {
      const lo = fn.m_nSequenceMin | 0, hi = fn.m_nSequenceMax | 0;
      for (let i = start; i < end; i++) c.attr[A.SEQUENCE1][i] = Math.trunc((hi - lo + 1) * drawVarying(c)) + lo;
    },
  },

  // particles.dll 63babcbf C_OP_RampScalarLinearSimple: slot 6 0x1801cf320 (output clamp), Operate slot 34 0x1801cf390.
  // Where life > 0 and m_flStartTime <= age/life < m_flEndTime: v = clamp(v + m_Rate * strength * dt). No angle
  // conversion (the rate is added as written).
  C_OP_RampScalarLinearSimple: {
    evidence: 'RE',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nField, A.ALPHA);
      if (!scalarOut(c, 'C_OP_RampScalarLinearSimple', out)) return;
      const [lo, hi] = clampOut(out), step = (+fn.m_Rate || 0) * s * c.dt;
      for (let i = 0; i < c.count; i++) {
        const life = c.attr[A.LIFE][i], t = age(c, i) / life; // rcpps, exact here
        if (life > 0 && fn.m_flStartTime <= t && t < fn.m_flEndTime) c.attr[out][i] = clamp(c.attr[out][i] + step, lo, hi);
      }
    },
  },

  // particles.dll 63babcbf C_OP_LerpEndCapScalar: state init slot 11 0x1801cca70 (-FLT_MAX), Operate slot 34 0x1801ccac0.
  // Runs while coll+0x8c1 & 0x40; the first such frame (state < 0) stores curTime and copies the current values into
  // the initial stream; then t = clamp((cur - start) / (m_flLerpTime + FLT_EPSILON)) (DAT_18053413c) and
  // v += (lerp(init, m_flOutput, t) - v) * strength. UNSETTLED: coll+0x8c1 & 0x40 is read as "endcap active".
  C_OP_LerpEndCapScalar: {
    evidence: 'RE',
    op(fn, c, s, st) {
      if (!c.endcap.active) return;
      const out = attrIndex(fn.m_nFieldOutput, A.ALPHA);
      if (!scalarOut(c, 'C_OP_LerpEndCapScalar', out)) return;
      st.start ??= -FLT_MAX;
      if (st.start < 0) { st.start = c.time; c.init[out].set(c.attr[out].subarray(0, c.count)); }
      const t = sat((c.time - st.start) / ((+fn.m_flLerpTime || 0) + FLT_EPSILON));
      for (let i = 0; i < c.count; i++) {
        const init = c.init[out][i], v = c.attr[out][i];
        c.attr[out][i] = (((+fn.m_flOutput - init) * t + init) - v) * s + v;
      }
    },
  },

  // particles.dll 63babcbf C_OP_SetFloatCollection: slot 6 0x18020b0e0 (output clamp), Operate slot 34 0x18020b6a0.
  // v = strength * m_InputValue, L = sat(strength * m_Lerp) (both collection inputs); per set method:
  // 1 cur + (init*v - cur)L, 4 cur + (cur*v - cur)L, 2 cur + (init + v - cur)L, 5 cur + vL, 3 cur + dt*v*L,
  // 0 lerp(cur, v, L) computed ONCE from the first 4-lane block and stored to every block, so particle i gets the value
  // of lane i & 3 (sic). Then the output clamp. No angle conversion.
  C_OP_SetFloatCollection: {
    evidence: 'RE',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nOutputField, A.RADIUS);
      if (!scalarOut(c, 'C_OP_SetFloatCollection', out)) return;
      const v = s * evalFloat(fn.m_InputValue, c, -1), L = sat(s * evalFloat(fn.m_Lerp, c, -1));
      const [lo, hi] = clampOut(out), a = c.attr[out], init = c.init[out];
      const m = setMethod(fn.m_nSetMethod);
      if (m === 0) {
        const lane = [0, 1, 2, 3].map((k) => clamp((v - a[k]) * L + a[k], lo, hi));
        for (let i = 0; i < c.count; i++) a[i] = lane[i & 3];
        return;
      }
      for (let i = 0; i < c.count; i++) {
        const cur = a[i];
        let o;
        if (m === 1) o = cur + (init[i] * v - cur) * L;
        else if (m === 4) o = cur + L * (cur * v - cur);
        else if (m === 2) o = cur + L * ((init[i] + v) - cur);
        else if (m === 5) o = ((cur + v) - cur) * L + cur;
        else o = L * ((c.dt * v + cur) - cur) + cur;
        a[i] = clamp(o, lo, hi);
      }
    },
  },

  // particles.dll 63babcbf C_OP_SetVec: Operate slot 34 0x18020d2b0. target = set method of m_InputValue(i) against the
  // initial (1 mul, 2 add) or current (3 cur + dt*v, 4 mul, 5 add) value, 0 the value; clamped [0,1] when the output is in
  // mask 0xc100c0 (colour, alpha, alpha 2, glow); w = sat(strength * m_Lerp(i)); out = cur + (target - cur) w; then
  // normalised when m_bNormalizedOutput (rsqrtps of |v|^2, FLT_EPSILON-guarded under FLT_MIN; exact here).
  C_OP_SetVec: {
    evidence: 'RE',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nOutputField, A.POSITION);
      if (!VECTOR_ATTRS.has(out)) { report(c, `C_OP_SetVec output ${out} is not a vector stream`); return; }
      const m = setMethod(fn.m_nSetMethod), unit = ((1 << out) & 0xc100c0) !== 0;
      for (let i = 0; i < c.count; i++) {
        const v = evalVec(fn.m_InputValue, c, i), cur = getV(c, out, i), init = [c.init[out][3 * i], c.init[out][3 * i + 1], c.init[out][3 * i + 2]];
        let t = [0, 1, 2].map((k) => (m === 1 ? v[k] * init[k] : m === 2 ? init[k] + v[k] : m === 3 ? c.dt * v[k] + cur[k]
          : m === 4 ? v[k] * cur[k] : m === 5 ? cur[k] + v[k] : v[k]));
        if (unit) t = t.map(sat);
        const w = sat(s * evalFloat(fn.m_Lerp, c, i));
        let r = [0, 1, 2].map((k) => (t[k] - cur[k]) * w + cur[k]);
        if (fn.m_bNormalizedOutput) { const q = dot(r, r); r = mul(r, 1 / Math.sqrt(Math.abs(q) < FLT_MIN ? FLT_EPSILON : q)); }
        setV(c, out, i, r);
      }
    },
  },

  // particles.dll 63babcbf C_OP_SetAttributeToScalarExpression: slot 6 0x180202d30 (output clamp), Operate slot 34
  // 0x180202da0. e = expression of m_flInput1(i), m_flInput2(i) times strength (ADD, SUBTRACT (b * -1, 0x1805890e0),
  // MUL, DIVIDE (b == 0 -> 0), INPUT_1, MIN, MAX, MOD a - b*trunc(a/b)); EQUAL / GT / LT give 1 or 0 without the
  // strength. Then m_flOutputRemap's map (0x18005a990, as inputs.js applyMap), the set method against initial (1 mul,
  // 2 add) or current (3 cur + dt*e, 4 mul, 5 add) value, and the output clamp.
  C_OP_SetAttributeToScalarExpression: {
    evidence: 'RE',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nOutputField, A.SCRATCH);
      if (!scalarOut(c, 'C_OP_SetAttributeToScalarExpression', out)) return;
      const [lo, hi] = clampOut(out), m = setMethod(fn.m_nSetMethod), ex = fn.m_nExpression;
      for (let i = 0; i < c.count; i++) {
        const a = evalFloat(fn.m_flInput1, c, i), b = evalFloat(fn.m_flInput2, c, i);
        let e;
        switch (ex) {
          case 'SCALAR_EXPRESSION_ADD': e = (a + b) * s; break;
          case 'SCALAR_EXPRESSION_SUBTRACT': e = (b * -1 + a) * s; break;
          case 'SCALAR_EXPRESSION_MUL': e = a * b * s; break;
          case 'SCALAR_EXPRESSION_DIVIDE': e = (b === 0 ? 0 : a / b) * s; break;
          case 'SCALAR_EXPRESSION_INPUT_1': e = s * a; break;
          case 'SCALAR_EXPRESSION_MIN': e = Math.min(a, b) * s; break;
          case 'SCALAR_EXPRESSION_MAX': e = Math.max(a, b) * s; break;
          case 'SCALAR_EXPRESSION_MOD': e = (a - b * Math.trunc(a / b)) * s; break;
          case 'SCALAR_EXPRESSION_EQUAL': e = a === b ? 1 : 0; break;
          case 'SCALAR_EXPRESSION_GT': e = b < a ? 1 : 0; break;
          case 'SCALAR_EXPRESSION_LT': e = a < b ? 1 : 0; break;
          default: e = c.attr[out][i]; // an unknown expression leaves the loaded value (the switch has no default)
        }
        e = applyMap(fn.m_flOutputRemap || {}, e);
        const cur = c.attr[out][i], init = c.init[out][i];
        const o = m === 1 ? e * init : m === 2 ? e + init : m === 3 ? e * c.dt + cur : m === 4 ? e * cur : m === 5 ? e + cur : e;
        c.attr[out][i] = clamp(o, lo, hi);
      }
    },
  },

  // particles.dll 63babcbf C_OP_ClampScalar: Operate slot 34 0x1801c5010. c = min(max(v, m_flOutputMin(i)),
  // m_flOutputMax(i)); strength >= 1 writes c, else c*s + v*(1 - s). No output-attribute clamp.
  C_OP_ClampScalar: {
    evidence: 'RE',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nFieldOutput, A.RADIUS);
      if (!scalarOut(c, 'C_OP_ClampScalar', out)) return;
      for (let i = 0; i < c.count; i++) {
        const v = c.attr[out][i];
        const k = Math.min(evalFloat(fn.m_flOutputMax, c, i), Math.max(evalFloat(fn.m_flOutputMin, c, i), v));
        c.attr[out][i] = s >= 1 ? k : k * s + v * (1 - s);
      }
    },
  },

  // particles.dll 63babcbf C_OP_EndCapDecay: Operate slot 34 0x1801d2dc0. While coll+0x8c1 & 0x40, kills every particle
  // with life <= 0 or life <= (curTime - X) - X, X = coll+0x5c (disassembly 0x1801d2e00..0x1801d2ee6: subss then subps
  // of the same +0x5c, so X is subtracted twice; sic). UNSETTLED: +0x8c1 & 0x40 read as "endcap active", +0x5c as
  // the endcap start time (PORTING.md's collection layout).
  C_OP_EndCapDecay: {
    evidence: 'RE',
    op(fn, c) {
      if (!c.endcap.active) return;
      const lim = (c.time - c.endcap.start) - c.endcap.start;
      for (let i = 0; i < c.count; i++) { const l = c.attr[A.LIFE][i]; if (l <= 0 || l <= lim) kill(c, i); }
    },
  },

};
