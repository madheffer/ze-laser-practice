// Ported from CS2's particles.dll (tools/particles/PORTING.md): each entry cites the build and the address it was read
// from. The motion group: see the comment on each class. Build: particles.dll md5 63babcbf3245e56855a777134323e74a
// ("63babcbf" below). Constants are cited by address; read them with tools/particles/consts.py.
import { A, VECTOR_ATTRS, add, sub, mul, dot, cross, len, norm, clamp, sat, getV, setV, getCp, drawVarying, drawConstant, FLT_EPSILON, FLT_MAX, angleVectors, attrIndex, cpPositionAt, kill, outputClamp, report, toWorld, transformOf } from './common.js';
import { applyMap, evalFloat, evalVec } from '../inputs.js';

const DEG2RAD = 0.0174532924; // DAT_180534170
const PI = 3.14159274; // DAT_180534284
const TWO_PI = 6.28318548; // DAT_1805342c8 (scalar), DAT_180534a20 / -DAT_180534cb0 (x4)
const FLT_MIN = 1.17549435e-38; // DAT_180589120
const age = (c, i) => c.time - c.attr[A.CREATION][i];
// The class's set method as its ParticleSetMethod_t index (KV3 may carry the name or the int).
const SET_METHODS = ['PARTICLE_SET_REPLACE_VALUE', 'PARTICLE_SET_SCALE_INITIAL_VALUE', 'PARTICLE_SET_ADD_TO_INITIAL_VALUE',
  'PARTICLE_SET_RAMP_CURRENT_VALUE', 'PARTICLE_SET_SCALE_CURRENT_VALUE', 'PARTICLE_SET_ADD_TO_CURRENT_VALUE'];
const setMethod = (m) => (typeof m === 'number' ? m : Math.max(0, SET_METHODS.indexOf(m)));
// Scalar stream check shared by the scalar operators: a vector or missing output is reported, never written.
const scalarOut = (c, cls, out) => {
  if (VECTOR_ATTRS.has(out) || !c.attr[out]) { report(c, `${cls} output ${out} is not a scalar stream`); return false; }
  return true;
};
// The "remap one scalar" step these classes inline: in0 == in1 steps at in1 (x - in1 >= 0 -> out1), else a clamped lerp.
const remapClamped = (x, in0, in1, out0, out1) => {
  if (in0 === in1) return x - in1 >= 0 ? out1 : out0;
  return sat((x - in0) / (in1 - in0)) * (out1 - out0) + out0;
};
// Output range clamp of the slot-6 inits (0x1801cf320 / 0x18020b0e0 / 0x180202d30): mask 0x10080 [0,1], 0x408 [0,FLT_MAX].
const clampOut = (out) => outputClamp(out);
// Remap outputs to an alpha (mask 0x10080) clamp their output range to [0,1] first (0x1801f9c90, 0x1801cb930).
const unitRange = (out, lo, hi) => ((1 << out) & 0x10080 ? [sat(lo), sat(hi)] : [lo, hi]);
// rsqrt with one Newton step on |v|^2 + FLT_EPSILON (DAT_18053413c, DAT_180534280 = 3, DAT_1805341b8 = 0.5): exact here.
const nrm = (v) => mul(v, 1 / Math.sqrt(dot(v, v) + FLT_EPSILON));
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
// Basis to angles (0x18035d810): left = normalize(up x forward) (rsqrt of |l|^2 + DAT_18053413c), then MatrixAngles:
// xy > 0.001 (DAT_180534150): yaw atan2(f.y, f.x), pitch atan2(-f.z, xy), roll atan2(l.z, u.z); degrees (x DAT_180534314).
// UNSETTLED: the xy <= 0.001 branch was not read past the compare; Source's MatrixAngles else-branch is used.
const basisAngles = (f, u) => {
  const l = nrm(cross(u, f));
  const xy = Math.hypot(f[0], f[1]);
  const R = 57.2957764;
  if (xy > 0.001) return [Math.atan2(-f[2], xy) * R, Math.atan2(f[1], f[0]) * R, Math.atan2(l[2], u[2]) * R];
  return [Math.atan2(-f[2], xy) * R, Math.atan2(-l[0], l[1]) * R, 0];
};

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

  // particles.dll 63babcbf C_INIT_RemapScalarToVector: slot 6 0x18014d100 (bias on when m_flRemapBias != 0.5,
  // DAT_1805341b8), Init slot 34 0x18014d130. Gate: t = max(0, creation - opTimeOrigin) in [start, end), or either
  // time == -1 (DAT_1805343cc). x = the input attribute (creation time: minus the op time origin, floored at 0); each
  // output component = remapClamped(x); with the bias, each OUTPUT component goes through Schlick bias(v, b)
  // (0x18035c540: v and b clamped to [0,1] / [FLT_MIN,1], v / ((1/b - 2)(1 - v) + 1)) (sic: the outputs, not t).
  // Position output: + CP position at the creation time (non-local) or through the CP frame (local, 0x18036ac60), set
  // method against position and previous position (1/4 mul, 2/5 add, 3 v*dt + cur, 0 set); local writes previous =
  // position. Other outputs: 1/4 mul, 2/5 add, 3 dt*cur + v (sic), 0 set. UNSETTLED: the local path uses the current
  // CP orientation (the game reads the transform at the creation time, 0x1800c1e70).
  C_INIT_RemapScalarToVector: {
    evidence: 'RE',
    init(fn, c, start, end) {
      const out = attrIndex(fn.m_nFieldOutput, A.POSITION), inp = attrIndex(fn.m_nFieldInput, A.CREATION);
      if (!VECTOR_ATTRS.has(out)) { report(c, `C_INIT_RemapScalarToVector output ${out} is not a vector stream`); return; }
      if (!c.attr[inp]) { report(c, `C_INIT_RemapScalarToVector input ${inp} is not a stream`); return; }
      const t0 = +fn.m_flStartTime, t1 = +fn.m_flEndTime, b = +fn.m_flRemapBias;
      const bias = (v) => { const x = v < 0 ? 0 : Math.min(1, v), k = b < FLT_MIN ? FLT_MIN : Math.min(1, b); return x / ((1 / k - 2) * (1 - x) + 1); };
      const m = setMethod(fn.m_nSetMethod);
      const cp = getCp(c, fn.m_nControlPointNumber | 0);
      const omin = fn.m_vecOutputMin || [0, 0, 0], omax = fn.m_vecOutputMax || [1, 1, 1];
      for (let i = start; i < end; i++) {
        const t = Math.max(0, c.attr[A.CREATION][i] - c.opTimeOrigin);
        if (!((t0 <= t && t < t1) || t0 === -1 || t1 === -1)) continue;
        let x = VECTOR_ATTRS.has(inp) ? c.attr[inp][3 * i] : c.attr[inp][i];
        if (inp === A.CREATION) x = Math.max(0, x - c.opTimeOrigin);
        let v = [0, 1, 2].map((k) => remapClamped(x, fn.m_flInputMin, fn.m_flInputMax, omin[k], omax[k]));
        if (b !== 0.5) v = v.map(bias);
        const cur = getV(c, out, i);
        const apply = (p) => (m === 1 || m === 4 ? [0, 1, 2].map((k) => v2[k] * p[k]) : m === 2 || m === 5 ? add(v2, p)
          : m === 3 ? add(mul(v2, c.dt), p) : v2.slice());
        let v2;
        if (out === A.POSITION) {
          if (!fn.m_bLocalCoords) {
            v2 = add(cpPositionAt(c, cp, c.attr[A.CREATION][i]), v);
            const prev = getV(c, A.PREV, i);
            setV(c, A.POSITION, i, apply(cur));
            setV(c, A.PREV, i, apply(prev));
          } else {
            v2 = add(cpPositionAt(c, cp, c.attr[A.CREATION][i]), toWorld(cp, v));
            const p = apply(cur);
            setV(c, A.POSITION, i, p);
            setV(c, A.PREV, i, p);
          }
        } else {
          v2 = v;
          setV(c, out, i, m === 1 || m === 4 ? [0, 1, 2].map((k) => v[k] * cur[k]) : m === 2 || m === 5 ? add(v, cur)
            : m === 3 ? add(mul(cur, c.dt), v) : v);
        }
      }
    },
  },

  // particles.dll 63babcbf C_OP_RemapDotProductToScalar: Operate slot 34 0x1801f9c90. The CP fetch 0x180049c80 gives
  // each CP's forward at +0x30/+0x40/+0x50; input = fwd(CP1) . fwd(CP2), or normalize(p - prev) . fwd(CP2)
  // (m_bUseParticleVelocity, rsqrt of |v|^2 + FLT_EPSILON), or normal . fwd(CP2) (m_bUseParticleNormal). With
  // m_bActiveRange an input outside [min, max] skips (the whole op for the CP dot, per particle otherwise). Output range
  // clamped to [0,1] for an alpha output; remapClamped; set method 1 init*v, 2 init + v, 3 v*dt + cur, 4 cur*v,
  // 5 cur + v, 0 v; an int attribute stores the truncated value.
  C_OP_RemapDotProductToScalar: {
    evidence: 'RE',
    op(fn, c) {
      const out = attrIndex(fn.m_nFieldOutput, A.ALPHA);
      if (!scalarOut(c, 'C_OP_RemapDotProductToScalar', out)) return;
      const [o0, o1] = unitRange(out, +fn.m_flOutputMin, +fn.m_flOutputMax);
      const f1 = getCp(c, fn.m_nInputCP1 | 0).forward, f2 = getCp(c, fn.m_nInputCP2 | 0).forward;
      const lo = +fn.m_flInputMin, hi = +fn.m_flInputMax;
      const outside = (x) => x < lo || x > hi;
      const cpDot = dot(f1, f2);
      if (fn.m_bActiveRange && !fn.m_bUseParticleVelocity && !fn.m_bUseParticleNormal && outside(cpDot)) return;
      const m = setMethod(fn.m_nSetMethod);
      for (let i = 0; i < c.count; i++) {
        let x = cpDot;
        if (fn.m_bUseParticleVelocity) x = dot(nrm(sub(getV(c, A.POSITION, i), getV(c, A.PREV, i))), f2);
        else if (fn.m_bUseParticleNormal) x = dot(getV(c, A.NORMAL, i), f2);
        if ((fn.m_bUseParticleVelocity || fn.m_bUseParticleNormal) && fn.m_bActiveRange && outside(x)) continue;
        const v = remapClamped(x, lo, hi, o0, o1), cur = c.attr[out][i], init = c.init[out][i];
        c.attr[out][i] = m === 1 ? init * v : m === 2 ? init + v : m === 3 ? v * c.dt + cur : m === 4 ? cur * v : m === 5 ? cur + v : v;
      }
    },
  },

  // particles.dll 63babcbf C_INIT_SequenceLifeTime: Init slot 34 0x18014cea0. Finds the first renderer whose sheet query
  // (renderer slot 34) answers; if m_flFramerate != 0 each new particle's life = (sequence record +0x10, taken as the
  // sequence's total time) / m_flFramerate, or 1 (DAT_180534200) when the sequence is out of range, unmapped or 0.
  // No renderer with a sheet: nothing is written. UNSETTLED: the simulation has no sheet data unless
  // sys.opts.sheet(texturePath) is supplied (the catalog's sheet JSON, frames[].time summed); without it this reports.
  C_INIT_SequenceLifeTime: {
    evidence: 'RE',
    init(fn, c, start, end) {
      const lookup = c.sys.opts?.sheet;
      if (typeof lookup !== 'function') { report(c, 'C_INIT_SequenceLifeTime: no sheet data in the simulation (opts.sheet), lifetimes unchanged'); return; }
      let sheet = null;
      for (const r of c.def.m_Renderers || []) {
        for (const g of r.m_vecTexturesInput || []) { const sh = g?.m_hTexture && lookup(g.m_hTexture); if (Array.isArray(sh) && sh.length) { sheet = sh; break; } }
        if (sheet) break;
      }
      if (!sheet) return;
      const fr = +fn.m_flFramerate || 0;
      if (fr === 0) return;
      for (let i = start; i < end; i++) {
        const q = c.attr[A.SEQUENCE][i] >>> 0;
        const seq = q < sheet.length ? sheet[q] : null;
        const total = seq ? (seq.totalTime ?? (seq.frames || []).reduce((a, f) => a + Math.max(0, f.time || 0), 0)) : 0;
        c.attr[A.LIFE][i] = total !== 0 ? total / fr : 1;
      }
    },
  },

  // particles.dll 63babcbf C_INIT_AgeNoise: Init slot 34 0x18014cbe0. t = creation + m_flOffset;
  // n = noise3((p + m_vecOffsetLoc) * m_flNoiseScaleLoc + t * m_flNoiseScale) (0x180366520, ported above); |n| when
  // m_bAbsVal (mask 0x7fffffff, scale 1) else scale 0.5 (DAT_1805341b8); 1 - n when m_bAbsValInv;
  // a = sat(range*scale*n + (1 - scale)*range + ageMin), range = ageMax - ageMin; creation -= a * life.
  C_INIT_AgeNoise: {
    evidence: 'RE',
    init(fn, c, start, end) {
      const sc = fn.m_bAbsVal ? 1 : 0.5, range = fn.m_flAgeMax - fn.m_flAgeMin;
      const off = fn.m_vecOffsetLoc || [0, 0, 0];
      for (let i = start; i < end; i++) {
        const t = (c.attr[A.CREATION][i] + fn.m_flOffset) * fn.m_flNoiseScale;
        const p = getV(c, A.POSITION, i);
        let n = noise3((p[0] + off[0]) * fn.m_flNoiseScaleLoc + t, (p[1] + off[1]) * fn.m_flNoiseScaleLoc + t, (p[2] + off[2]) * fn.m_flNoiseScaleLoc + t);
        if (fn.m_bAbsVal) n = Math.abs(n);
        if (fn.m_bAbsValInv) n = 1 - n;
        const a = sat(range * sc * n + (1 - sc) * range + fn.m_flAgeMin);
        c.attr[A.CREATION][i] -= a * c.attr[A.LIFE][i];
      }
    },
  },

  // particles.dll 63babcbf C_OP_OrientTo2dDirection: Operate slot 34 0x1801f4890. d = m_vecInput(i) x/y; if not both 0:
  // angle = atan2(y, x) of d normalised (rsqrt of x^2 + y^2 + FLT_EPSILON); out += (angle + pi + m_flRotOffset*deg2rad
  // - out) * m_flSpinStrength. The operator strength is not used (sic).
  C_OP_OrientTo2dDirection: {
    evidence: 'RE',
    op(fn, c) {
      const out = attrIndex(fn.m_nFieldOutput, A.ROLL);
      if (!scalarOut(c, 'C_OP_OrientTo2dDirection', out)) return;
      const off = (+fn.m_flRotOffset || 0) * DEG2RAD, k = +fn.m_flSpinStrength;
      for (let i = 0; i < c.count; i++) {
        const v = evalVec(fn.m_vecInput, c, i);
        if (v[0] === 0 && v[1] === 0) continue;
        const r = 1 / Math.sqrt(v[0] * v[0] + FLT_EPSILON + v[1] * v[1]);
        const a = Math.atan2(v[1] * r, v[0] * r), cur = c.attr[out][i];
        c.attr[out][i] = ((a + PI + off) - cur) * k + cur;
      }
    },
  },

  // particles.dll 63babcbf C_INIT_RemapTransformOrientationToRotations: Init slot 34 0x180161a60 -> 0x1801fd660. The
  // transform's quaternion rotates forward / left / up (static init 0x180008e30 / e40 / e90: (1,0,0) / (0,1,0) /
  // (0,0,1)). Without m_bUseQuat: angles = basisAngles(forward, up) (0x18035d810); m_bWriteNormal writes
  // AngleVectors(angles + m_vecRotation) forward (0x18035cab0) to the normal, else pitch / yaw / roll (20 / 12 / 4)
  // = (angle + rotation) * deg2rad. With m_bUseQuat: q = quat(basis) (0x180360390) * quat(QAngle(rot.y, rot.z, rot.x))
  // (0x1803600b0, 0x180360c80), then the normal = q * forward, or angles from q (0x180361000). UNSETTLED (quat path):
  // the product order of 0x180360c80, built here as matrices R_basis * R_rot.
  C_INIT_RemapTransformOrientationToRotations: {
    evidence: 'RE',
    init(fn, c, start, end) {
      const tr = transformOf(c, fn.m_TransformInput);
      const rot = fn.m_vecRotation || [0, 0, 0];
      let ang, normal;
      if (!fn.m_bUseQuat) {
        const b = basisAngles(tr.forward, tr.up);
        ang = [b[0] + rot[0], b[1] + rot[1], b[2] + rot[2]];
        normal = angleVectors(ang[0], ang[1], ang[2]).forward;
      } else {
        const r = angleVectors(rot[1], rot[2], rot[0]);
        const f = toWorld(tr, r.forward), u = toWorld(tr, r.up);
        ang = basisAngles(f, u);
        normal = f;
      }
      for (let i = start; i < end; i++) {
        if (fn.m_bWriteNormal) { setV(c, A.NORMAL, i, normal); continue; }
        c.attr[A.PITCH][i] = ang[0] * DEG2RAD; c.attr[A.YAW][i] = ang[1] * DEG2RAD; c.attr[A.ROLL][i] = ang[2] * DEG2RAD;
      }
    },
  },

  // particles.dll 63babcbf C_INIT_NormalAlignToCP: Init slot 34 0x18015a4e0. normal = the transform's quaternion applied
  // to the axis constant (X/Y/Z = (1,0,0)/(0,1,0)/(0,0,1), static init 0x180008e30 / e40 / e90), negated for the
  // NEGATIVE axes: the CP's forward / left / up. UNSETTLED: the game reads the transform at each particle's creation time
  // (0x1800bb4d0); the current frame is used.
  C_INIT_NormalAlignToCP: {
    evidence: 'RE',
    init(fn, c, start, end) {
      const tr = transformOf(c, fn.m_transformInput);
      const ax = String(fn.m_nControlPointAxis ?? 'PARTICLE_CP_AXIS_Z');
      const idx = typeof fn.m_nControlPointAxis === 'number' ? fn.m_nControlPointAxis
        : ['X', 'Y', 'Z'].indexOf(ax.slice(-1)) + (ax.includes('NEGATIVE') ? 3 : 0);
      const base = [tr.forward, tr.left, tr.up][idx % 3] || tr.up;
      const n = idx >= 3 ? mul(base, -1) : base.slice();
      for (let i = start; i < end; i++) setV(c, A.NORMAL, i, n);
    },
  },

  // particles.dll 63babcbf C_OP_RemapVisibilityScalar: Operate slot 34 0x1801cb930. vis = the scene's visibility query
  // (coll+0x1d8 slot 26) at the particle position with radius * m_flRadiusScale; output range [0,1] for alpha;
  // out += (remapClamped(vis) - out) * strength. UNSETTLED: the preview has no visibility query; sys.opts.visibility
  // (pos, radius) is used when supplied, else 1 (fully visible), reported.
  C_OP_RemapVisibilityScalar: {
    evidence: 'RE',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nFieldOutput, A.ALPHA);
      if (!scalarOut(c, 'C_OP_RemapVisibilityScalar', out)) return;
      const q = c.sys.opts?.visibility;
      if (typeof q !== 'function') report(c, 'C_OP_RemapVisibilityScalar: no visibility query in the preview, visibility read as 1');
      const [o0, o1] = unitRange(out, +fn.m_flOutputMin, +fn.m_flOutputMax);
      for (let i = 0; i < c.count; i++) {
        const vis = typeof q === 'function' ? +q(getV(c, A.POSITION, i), c.attr[A.RADIUS][i] * fn.m_flRadiusScale) : 1;
        const v = remapClamped(vis, fn.m_flInputMin, fn.m_flInputMax, o0, o1), cur = c.attr[out][i];
        c.attr[out][i] = (v - cur) * s + cur;
      }
    },
  },

  // particles.dll 63babcbf C_OP_Cull: Operate slot 34 0x1801d4ef0. Per particle two VARYING draws r1, r2 (always taken);
  // if r1 <= strength * m_flCullPerc: t = sat(age / life); killed when start <= t <= end and
  // pow(r2, m_flCullExp) * (end - start) + start <= t.
  C_OP_Cull: {
    evidence: 'RE',
    op(fn, c, s) {
      const t0 = +fn.m_flCullStart, t1 = +fn.m_flCullEnd;
      for (let i = 0; i < c.count; i++) {
        const r1 = drawVarying(c), r2 = Math.pow(drawVarying(c), +fn.m_flCullExp);
        if (!(r1 <= s * fn.m_flCullPerc)) continue;
        const t = sat(age(c, i) / c.attr[A.LIFE][i]);
        if (t0 <= t && t <= t1 && r2 * (t1 - t0) + t0 <= t) kill(c, i);
      }
    },
  },

  // particles.dll 63babcbf C_OP_PlaneCull: Operate slot 34 0x1801ec610. n = normalize(m_vecPlaneDirection) (first value,
  // through the CP frame when m_bLocalSpace, 0x18035ec80); point = CP - n * m_flPlaneOffset; killed where
  // (p - point) . n < 0.
  C_OP_PlaneCull: {
    evidence: 'RE',
    op(fn, c) {
      const cp = getCp(c, fn.m_nPlaneControlPoint | 0);
      let d = evalVec(fn.m_vecPlaneDirection, c, -1);
      if (fn.m_bLocalSpace) d = toWorld(cp, d);
      const n = norm(d), P = sub(cp.position, mul(n, +fn.m_flPlaneOffset || 0));
      for (let i = 0; i < c.count; i++) if (dot(sub(getV(c, A.POSITION, i), P), n) < 0) kill(c, i);
    },
  },

  // particles.dll 63babcbf C_OP_DistanceCull (raw decompile only): Operate slot 34 0x1801eccc0. D = m_flDistance (first
  // value); centre = CP position + m_vecPointOffset (world space, no rotation); killed where |attr - C|^2 > D^2, or
  // < D^2 with m_bCullInside (attribute m_nAttribute). UNSETTLED: the game skips the op when coll+0x8c2 & 8 and the
  // centre-in-bounds test (0x18036bfe0 on coll+0x210/+0x21c) differs from m_bCullInside; bounds are not kept, so the
  // op always runs.
  C_OP_DistanceCull: {
    evidence: 'RE',
    op(fn, c) {
      const a = attrIndex(fn.m_nAttribute, A.POSITION);
      if (!VECTOR_ATTRS.has(a)) { report(c, `C_OP_DistanceCull attribute ${a} is not a vector stream`); return; }
      const D = evalFloat(fn.m_flDistance, c, -1), D2 = D * D;
      const C = add(getCp(c, fn.m_nControlPoint | 0).position, fn.m_vecPointOffset || [0, 0, 0]);
      for (let i = 0; i < c.count; i++) {
        const d = sub(getV(c, a, i), C), d2 = dot(d, d);
        if (fn.m_bCullInside ? d2 < D2 : D2 < d2) kill(c, i);
      }
    },
  },

  // particles.dll 63babcbf C_INIT_DistanceToNeighborCull: Init slot 34 0x180157f10. For each new particle with life > 0,
  // scan j = count-1 .. 0 (j != i), skipping life_j <= 0 and, when 1 - overlap(i) < 1, j with age_j/life_j >
  // 1 - overlap(i); the first j with D(i)^2 > |p_i - p_j|^2 - (m_bIncludeRadii ? (r_i + r_j)^2 : 0) is the neighbour.
  // Found: field NONE (19) sets life_i = -1; else v = m_flModify(i) against attr_j (m_bUseNeighbor) or attr_i:
  // 1/4 v*src, 2/5 v + src, 3 v*dt + src, 0 v; written to particle i.
  C_INIT_DistanceToNeighborCull: {
    evidence: 'RE',
    init(fn, c, start, end) {
      const field = attrIndex(fn.m_nFieldModify, A.NONE), m = setMethod(fn.m_nSetMethod);
      if (field !== A.NONE && (VECTOR_ATTRS.has(field) || !c.attr[field])) { report(c, `C_INIT_DistanceToNeighborCull field ${field} is not a scalar stream`); return; }
      for (let i = start; i < end; i++) {
        const D = evalFloat(fn.m_flDistance, c, i, 'init'), ov = 1 - evalFloat(fn.m_flLifespanOverlap, c, i, 'init');
        if (!(c.attr[A.LIFE][i] > 0)) continue;
        const p = getV(c, A.POSITION, i);
        let found = -1;
        for (let j = c.count - 1; j >= 0; j--) {
          if (j === i) continue;
          const lj = c.attr[A.LIFE][j];
          if (lj <= 0 || (ov < 1 && ov < age(c, j) / lj)) continue;
          const d = sub(p, getV(c, A.POSITION, j));
          let rr = 0;
          if (fn.m_bIncludeRadii) { rr = c.attr[A.RADIUS][j] + c.attr[A.RADIUS][i]; rr *= rr; }
          if (D * D > dot(d, d) - rr) { found = j; break; }
        }
        if (found < 0) continue;
        if (field === A.NONE) { c.attr[A.LIFE][i] = -1; continue; }
        const v = evalFloat(fn.m_flModify, c, i, 'init'), src = c.attr[field][fn.m_bUseNeighbor ? found : i];
        c.attr[field][i] = m === 1 || m === 4 ? v * src : m === 2 || m === 5 ? v + src : m === 3 ? v * c.dt + src : v;
      }
    },
  },

  // particles.dll 63babcbf C_INIT_GlobalScale: slot 6 0x18013ff00 (m_nControlPointNumber clamped [0,63]), Init slot 34
  // 0x1801627a0. k = m_flScale * (m_nScaleControlPointNumber >= 0 ? that CP's position x : 1). Radius *= k
  // (m_bScaleRadius). Position: P + R*(R^T (p - P) * k) through the CP frame (0x18036ac60). Velocity v = p - prev:
  // scale velocity only -> prev = p - v*k; position only -> prev = p' - v; both -> prev scaled about P like p.
  C_INIT_GlobalScale: {
    evidence: 'RE',
    init(fn, c, start, end) {
      let k = +fn.m_flScale;
      if ((fn.m_nScaleControlPointNumber | 0) >= 0) k *= getCp(c, fn.m_nScaleControlPointNumber | 0).position[0];
      const cp = getCp(c, clamp(fn.m_nControlPointNumber | 0, 0, 63)), P = cp.position;
      const scaleAbout = (q) => add(P, toWorld(cp, mul([dot(cp.forward, sub(q, P)), dot(cp.left, sub(q, P)), dot(cp.up, sub(q, P))], k)));
      for (let i = start; i < end; i++) {
        if (fn.m_bScaleRadius) c.attr[A.RADIUS][i] *= k;
        let p = getV(c, A.POSITION, i), q = getV(c, A.PREV, i);
        const v = sub(p, q);
        if (fn.m_bScalePosition) p = scaleAbout(p);
        if (fn.m_bScaleVelocity && fn.m_bScalePosition) q = scaleAbout(q);
        else if (fn.m_bScaleVelocity) q = sub(p, mul(v, k));
        else if (fn.m_bScalePosition) q = sub(p, v);
        setV(c, A.POSITION, i, p);
        setV(c, A.PREV, i, q);
      }
    },
  },
};
