// Ported from CS2's particles.dll (tools/particles/PORTING.md): each entry cites the build and the address it was read
// from. The forces group: see the comment on each class. Build: particles.dll md5 63babcbf3245e56855a777134323e74a
// (written "63babcbf" below). Constants are read with tools/particles/consts.py at the address given.
//
// Forces (CParticleFunctionForce, base vtable 0x1804e9d48) are not operators: C_OP_BasicMovement's Operate
// (0x1801c0ba0) fills an acceleration buffer with its gravity, then for every m_ForceGenerators entry whose strength
// (0x18003f820) is above zero calls slot 35 (0x18010f450, stores the gravity at force+0x1e0) and slot 34, AddForces
// (force, acc, collection, &state, blocks, strength). Integration is pos += (pos - prev) * drag + attr34 * dt^2 * acc.
// The entries here carry `force(fn, c, acc, strength, state)`: acc is a Float32Array of 3 * c.count (x, y, z per
// particle) that BasicMovement starts at its gravity and integrates after every force has added to it.
// Initializers follow initializers.js. C_OP_WorldTraceConstraint lives in ported_collision.js.
//
// World traces go through ParticleSystem opts.trace(from, dir, length, query) -> { hit, position, normal,
// startSolid? } | null, the contract preemission.js uses; `query` (new here) carries what the game's trace call
// gets: { traceSet: 'PARTICLE_TRACE_SET_*', mask: game trace-set mask 0xf/1/3/6, contents: content mask,
// collisionGroup: name, ignoreCp: CP index or -1 }. A miss ends at from + dir * length with fraction 1.
import { A, VECTOR_ATTRS, add, sub, mul, dot, cross, len, clamp, getV, setV, getF, setF, getInitV, getCp, cpPositionAt,
  drawVarying, mulberry32, report, toWorld, transformOf, FLT_EPSILON, FLT_MIN, DEG2RAD, isZero, enumIndex, TRACE_SETS,
  traceSetMask, randomBetween, evenIndex, threadRandom, vec3 } from './common.js';
import { evalFloat, evalVec } from '../inputs.js';

export const F = Math.fround;
export const T = (c, k) => c.table[k & 0xfff];
export const ANGLE_MASK = 0x101010; // attributes 4, 12, 20 (roll, yaw, pitch): the class-init slots scale degrees to radians
export const inMask = (mask, a) => a >= 0 && a < 32 && ((mask >>> a) & 1) === 1;
export const lerp = (a, b, t) => a + (b - a) * t;

// FUN_1800522b0 / FUN_18035ead0: normalise, 1/len for 1e-17 <= len <= 1e17 (DAT_180534130, DAT_180534398), the
// double-precision path outside that range, (0,0,0) for a zero vector (DAT_1804d2868).
export const safeNorm = (v) => {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (l === 0) return [0, 0, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
};

// A control point frame at a particle's creation time (FUN_1800c1e70 / FUN_180049980): the position lerps from the
// previous to the current position by max(0, (dt - (time - creationTime)) / dt); dt == 0 reads the position. The
// orientation is the current one, or the previous orientation (cp+0x3c..) for a particle created exactly at
// time - dt. UNSETTLED: the runtime keeps no previous orientation, so the current one is used for both.
export const cpFrameAt = (c, i, ctime) => {
  const cp = getCp(c, clamp(i | 0, 0, 63));
  return { position: cpPositionAt(c, cp, ctime), forward: cp.forward, left: cp.left, up: cp.up };
};

// The thread-local generator behind FUN_18036ba50 / FUN_18036b9c0 (lagged additive generator mod 1 in TLS+0x110,
// constant 1.0 at DAT_180534860). UNSETTLED: its state is per thread and unseeded from the effect, so a seeded stream
// per function stands in for it; the draw order is the game's.
const tlsRandom = threadRandom;

// Uniform point in the unit ball from three table draws (the inline code of C_INIT_VelocityRandom 0x18013d290 and
// C_INIT_MoveBetweenPoints 0x18014ae10): u_k = T[c910 + c914 + k] * 0.9999 + 0.0001 (DAT_1805341f8, DAT_18053414c),
// z = 2*u0 - 1, phi = u1 * 2pi (DAT_1805342c8), r = u2^(1/3) (DAT_1805341b0); x = r*sqrt(1-z^2)*cos(phi),
// y = r*sqrt(1-z^2)*sin(phi) (the SIMD sine at 0x180589160.. and cos = +-sqrt(1-sin^2)); c910 += 3.
export const randomInBall = (c) => {
  const b = c.rnd.counter + c.rnd.offset;
  const u0 = T(c, b) * 0.9999 + 0.0001, u1 = T(c, b + 1) * 0.9999 + 0.0001, u2 = T(c, b + 2) * 0.9999 + 0.0001;
  c.rnd.counter += 3;
  const z = 2 * u0 - 1, phi = u1 * 6.28318548, r = Math.pow(u2, 0.333333343);
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * s * Math.cos(phi), r * s * Math.sin(phi), r * z];
};

// x^(n/4) for an integer n (FUN_18036bf70): the |n| & 3 quarter powers through sqrt, the rest by squaring, and for
// n < 0 the reciprocal of the result with a value below FLT_MIN replaced by FLT_EPSILON (0x180589120, 0x1805890b0).
const powQuarter = (x, n) => {
  const m = Math.abs(n);
  let r = 1;
  if (m & 3) {
    const s = Math.sqrt(x);
    r = (m & 1) ? Math.sqrt(s) : 1;
    if (m & 2) r *= s;
  }
  for (let k = m >> 2, p = x; k; k >>= 1, p *= p) if (k & 1) r *= p;
  if (n < 0) r = 1 / (Math.abs(r) < FLT_MIN ? FLT_EPSILON : r);
  return r;
};

// ---- value noise (FUN_180366790), shared by C_OP_Noise, C_OP_VectorNoise, C_INIT_CreationNoise and
// C_INIT_InitialVelocityNoise. Each lattice corner key ix + iy*1024 + iz*1048576 is hashed with the murmur3 body
// (constants 0x4c9e2d51 0x18046b7f0, 0x1b873593 0x18046b750, 5 0x18046b6d0, 0xe6546b64 0x18046b840, mask 0x7fffffff
// 0x180534bd0, final multiplier 0x04b2ae35 0x18046b740), folded to 16 bits (0xffff 0x18046b720) and scaled by 1/65535
// (0x37800080, 0x18046b760); the eight corners blend trilinearly on the plain fractions (no fade curve), and the
// result maps to [-1, 1] as (v - 0.5) * 2 (0x1805347b0, 0x180534910).
const NOISE_SCALE = new Float32Array(new Uint32Array([0x37800080]).buffer)[0];
const corner = (k) => {
  let a = Math.imul(k, 0x4c9e2d51) & 0x7fffffff;
  a = (a << 15) | (a >> 17);
  a = Math.imul(a, 0x1b873593) & 0x7fffffff;
  a = (a << 13) | (a >> 19);
  a = (Math.imul(a, 5) + 0xe6546b64) | 0;
  a = ((a >> 16) ^ a) & 0x7fffffff;
  a = Math.imul(a, 0x04b2ae35);
  return F((((a >> 16) ^ a) & 0xffff) * NOISE_SCALE);
};
export const valueNoise3 = (x, y, z) => {
  x = F(x); y = F(y); z = F(z);
  const fx0 = Math.floor(x), fy0 = Math.floor(y), fz0 = Math.floor(z);
  const fx = F(x - fx0), fy = F(y - fy0), fz = F(z - fz0);
  const ix = fx0 | 0, iy = fy0 | 0, iz = fz0 | 0;
  const y0 = (iy << 10), y1 = ((iy + 1) << 10), z0 = (iz << 20), z1 = ((iz + 1) << 20);
  const c000 = corner((ix + y0 + z0) | 0), c100 = corner((ix + 1 + y0 + z0) | 0);
  const c010 = corner((ix + y1 + z0) | 0), c110 = corner((ix + 1 + y1 + z0) | 0);
  const c001 = corner((ix + y0 + z1) | 0), c101 = corner((ix + 1 + y0 + z1) | 0);
  const c011 = corner((ix + y1 + z1) | 0), c111 = corner((ix + 1 + y1 + z1) | 0);
  const a = F(F((c100 - c000) * fx) + c000), b = F(F((c110 - c010) * fx) + c010);
  const d = F(F((c101 - c001) * fx) + c001), e = F(F((c111 - c011) * fx) + c011);
  const ab = F(F((b - a) * fy) + a), de = F(F((e - d) * fy) + d);
  const r = F(F((de - ab) * fz) + ab);
  return F((r - 0.5) * 2);
};

// The trace call (vtable +0x20 of the collection's query object, coll+0x1d8) through opts.trace. Trace set: ALL ->
// mask 0xf, STATIC 1, STATIC_AND_KEYFRAMED 3, DYNAMIC 6 (the switch before each trace loop).
export const traceQuery = (fn, contents) => {
  const set = enumIndex(fn.m_nTraceSet, TRACE_SETS);
  return { traceSet: TRACE_SETS[set] || TRACE_SETS[0], mask: traceSetMask(set), contents,
    collisionGroup: String(fn.m_CollisionGroupName ?? 'NONE'), ignoreCp: fn.m_nIgnoreCP ?? -1 };
};
export const worldTrace = (c, from, dir, length, query) => {
  const r = c.sys.opts.trace ? c.sys.opts.trace(from.slice(), dir.slice(), length, query) : null;
  if (!c.sys.opts.trace) report(c, 'no opts.trace: world traces miss');
  if (r && r.hit) {
    const pos = vec3(r.position);
    return { hit: true, pos, normal: vec3(r.normal, [0, 0, 0]), startSolid: !!r.startSolid,
      fraction: length > 0 ? len(sub(pos, from)) / length : 0 };
  }
  // UNSETTLED: the normal a miss carries (taken as zero, as preemission.js does).
  return { hit: false, pos: add(from, mul(dir, length)), normal: [0, 0, 0], startSolid: !!(r && r.startSolid), fraction: 1 };
};
export const MISS = ['PARTICLE_TRACE_MISS_BEHAVIOR_NONE', 'PARTICLE_TRACE_MISS_BEHAVIOR_KILL', 'PARTICLE_TRACE_MISS_BEHAVIOR_TRACE_END'];

export const ported_forces = {
  // particles.dll 63babcbf: C_OP_AttractToControlPoint AddForces slot 34 0x180110e50, class init slot 6 0x180110af0
  // (m_fFalloffPower clamped to [-255, 255], DAT_1805343e8 / DAT_180534344). The exponent is trunc(falloff * -4)
  // quarters (DAT_1805343d8 = -4) through FUN_18036bf70. Per particle: amount = m_fForceAmount (max with
  // m_fForceAmountMin when m_bApplyMinForce), d = pos - transform position, dist = |d|, dist < m_fMinimumDistance
  // reads 1 (0x180589050); acc -= d * amount/dist * dist^(-falloff) * scale where dist > FLT_EPSILON. The component
  // scale is rotated by the transform orientation when the transform uses it, then times the strength.
  // UNSETTLED: the transform is read at the current time (FUN_1800bb4d0 slerps to the frame time).
  C_OP_AttractToControlPoint: {
    evidence: 'RE',
    force(fn, c, acc, strength) {
      const tcp = transformOf(c, fn.m_TransformInput);
      const falloff = clamp(+fn.m_fFalloffPower || 0, -255, 255);
      const n = Math.trunc(falloff * -4);
      let scale = vec3(fn.m_vecComponentScale, [1, 1, 1]);
      if (fn.m_TransformInput?.m_bUseOrientation) scale = toWorld(tcp, scale);
      scale = mul(scale, strength);
      for (let i = 0; i < c.count; i++) {
        let amount = evalFloat(fn.m_fForceAmount, c, i);
        if (fn.m_bApplyMinForce) amount = Math.max(amount, evalFloat(fn.m_fForceAmountMin, c, i));
        const d = sub(getV(c, A.POSITION, i), tcp.position);
        let dist = len(d);
        if (dist < evalFloat(fn.m_fMinimumDistance, c, i)) dist = 1;
        if (!(dist > FLT_EPSILON)) continue;
        const k = amount * (1 / (Math.abs(dist) < FLT_MIN ? FLT_EPSILON : dist)) * powQuarter(dist, n);
        for (let a = 0; a < 3; a++) acc[3 * i + a] -= d[a] * k * scale[a];
      }
    },
  },

  // particles.dll 63babcbf: C_OP_RandomForce AddForces slot 34 0x18010f550. acc += min*s + (max*s - min*s) * r per
  // axis, r from the thread-local generator FUN_18036ba50 (one 4-lane draw per axis per block of four).
  C_OP_RandomForce: {
    evidence: 'RE',
    force(fn, c, acc, strength, st) {
      const lo = mul(vec3(fn.m_MinForce), strength), hi = mul(vec3(fn.m_MaxForce), strength);
      const rnd = tlsRandom(st);
      for (let b = 0; b < c.count; b += 4) {
        for (let a = 0; a < 3; a++) {
          for (let k = 0; k < 4; k++) {
            const r = rnd();
            const i = b + k;
            if (i < c.count) acc[3 * i + a] += lo[a] + (hi[a] - lo[a]) * r;
          }
        }
      }
    },
  },

  // particles.dll 63babcbf: C_INIT_VelocityRandom InitNewParticles slot 34 0x18013d290, class init slot 6
  // 0x180128060 (CP clamped 0..63). Local velocity = FUN_1801231d0(m_randomnessParameters, local min, local max)
  // rotated by the CP frame at creation time (FUN_180049980), skipped (0) when both local vectors are zero; plus,
  // when either speed is non-zero, a uniform direction (randomInBall normalised by FUN_1800522b0) times
  // lerp(m_fSpeedMin, m_fSpeedMax, T[c910++ + c914]). Times prev dt (coll+0x68) unless m_bIgnoreDT; prev -= v.
  C_INIT_VelocityRandom: {
    evidence: 'RE',
    init(fn, c, s, e, _str, st) {
      const cpi = clamp(fn.m_nControlPointNumber | 0, 0, 63);
      for (let i = s; i < e; i++) {
        const lo = evalVec(fn.m_LocalCoordinateSystemSpeedMin, c, i, 'init');
        const hi = evalVec(fn.m_LocalCoordinateSystemSpeedMax, c, i, 'init');
        const smin = evalFloat(fn.m_fSpeedMin, c, i, 'init'), smax = evalFloat(fn.m_fSpeedMax, c, i, 'init');
        let v = [0, 0, 0];
        if (!(isZero(lo) && isZero(hi))) {
          // distribute-evenly index: the dispatcher's coll+0x88 - first + index (common.js evenIndex)
          const r = randomBetween(c, fn.m_randomnessParameters, lo, hi, evenIndex(c, s, i));
          v = toWorld(cpFrameAt(c, cpi, getF(c, A.CREATION, i)), r);
        }
        if (smax !== 0 || smin !== 0) {
          const dir = safeNorm(randomInBall(c));
          const sp = smin + (smax - smin) * drawVarying(c);
          v = add(v, mul(dir, sp));
        }
        if (!fn.m_bIgnoreDT) v = mul(v, c.prevDt);
        setV(c, A.PREV, i, sub(getV(c, A.PREV, i), v));
      }
    },
  },

  // particles.dll 63babcbf: C_OP_VectorNoise Operate slot 34 0x1801d0ab0. p = pos * m_fl4NoiseScale with
  // x += m_flNoiseAnimationTimeScale * time; x = noise(p), p += (100000.5, 300000.25, 9000001) (0x180534b00/b20/b40),
  // y = noise(p), p += (110000.25, 310000.75, 9100000) (0x180534b10/b30/b50), z = noise(p). Output per axis
  // n * (max-min)*0.5 + min + (max-min)*0.5 (DAT_1805341b8). m_bAdditive adds that * dt * strength, and into the
  // previous position too when the output is the position. m_bOffset is not read by Operate.
  C_OP_VectorNoise: {
    evidence: 'RE',
    op(fn, c, strength) {
      const out = fn.m_nFieldOutput | 0;
      if (!VECTOR_ATTRS.has(out)) { report(c, `C_OP_VectorNoise output ${out} is not a vector stream`); return; }
      const mn = vec3(fn.m_vecOutputMin), mx = vec3(fn.m_vecOutputMax, [1, 1, 1]);
      const half = [0, 1, 2].map((k) => F((mx[k] - mn[k]) * 0.5)), mid = [0, 1, 2].map((k) => F(half[k] + mn[k]));
      const sc = +fn.m_fl4NoiseScale, tx = F(+fn.m_flNoiseAnimationTimeScale * c.time);
      for (let i = 0; i < c.count; i++) {
        const p = getV(c, A.POSITION, i);
        let x = F(F(p[0] * sc) + tx), y = F(p[1] * sc), z = F(p[2] * sc);
        const n0 = valueNoise3(x, y, z);
        x = F(x + 100000.5); y = F(y + 300000.25); z = F(z + 9000001);
        const n1 = valueNoise3(x, y, z);
        x = F(x + 110000.25); y = F(y + 310000.75); z = F(z + 9100000);
        const n2 = valueNoise3(x, y, z);
        const v = [n0 * half[0] + mid[0], n1 * half[1] + mid[1], n2 * half[2] + mid[2]];
        if (!fn.m_bAdditive) { setV(c, out, i, v); continue; }
        const dv = mul(v, c.dt * strength);
        setV(c, out, i, add(getV(c, out, i), dv));
        if (out === A.POSITION) setV(c, A.PREV, i, add(getV(c, A.PREV, i), dv));
      }
    },
  },

  // particles.dll 63babcbf: C_INIT_InitialVelocityNoise slot 34 0x18013f090 (noise call at 0x18013f627). v = (offset
  // loc + pos) * m_flNoiseScaleLoc + (m_flOffset + creation time) * m_flNoiseScale; axis k = noise(v + C_k) with
  // C_0 = 0, C_1 = (100000.5, 300000.25, 9000001), C_2 = (110000.25, 310000.75, 9100000) (lanes of 0x1805344e0,
  // 0x1805344f0, 0x180534500). Axis k with m_vecAbsVal[k] != 0 takes |n| and scale 1, else scale 0.5. When any
  // m_vecAbsValInv component is set, axis k becomes n + 1 where AbsValInv[k] != 0 and -n where it is 0 (the
  // blends at 0x18013f1f2 / 0x18013f1fc read literally, -1 at 0x1805890e0). Output n * range * s + min +
  // range * (1 - s), range = max - min; times prev dt unless m_bIgnoreDt; rotated by the transform orientation when
  // the transform is valid (FUN_18038ebb0: a named value, or a CP type with m_nControlPoint >= 0); prev -= v.
  // UNSETTLED: block slot 35 (0x18013e230) is taken to match slot 34; the transform is read at the current time.
  C_INIT_InitialVelocityNoise: {
    evidence: 'RE',
    init(fn, c, s, e) {
      const abs = vec3(fn.m_vecAbsVal), inv = vec3(fn.m_vecAbsValInv);
      const anyInv = !isZero(inv);
      const tin = fn.m_TransformInput || {};
      const ttype = tin.m_nType ?? 'PT_TYPE_INVALID';
      const valid = ttype === 'PT_TYPE_NAMED_VALUE' ? !!tin.m_NamedValue
        : (ttype === 'PT_TYPE_CONTROL_POINT' || ttype === 'PT_TYPE_CONTROL_POINT_RANGE') && (tin.m_nControlPoint | 0) >= 0;
      if (ttype === 'PT_TYPE_NAMED_VALUE') report(c, 'C_INIT_InitialVelocityNoise named-value transform not implemented');
      const frame = valid && ttype !== 'PT_TYPE_NAMED_VALUE' ? transformOf(c, tin) : null;
      const C = [[0, 0, 0], [100000.5, 300000.25, 9000001], [110000.25, 310000.75, 9100000]];
      for (let i = s; i < e; i++) {
        const mn = evalVec(fn.m_vecOutputMin, c, i, 'init'), mx = evalVec(fn.m_vecOutputMax, c, i, 'init');
        const offLoc = evalVec(fn.m_vecOffsetLoc, c, i, 'init');
        const off = evalFloat(fn.m_flOffset, c, i, 'init');
        const ns = evalFloat(fn.m_flNoiseScale, c, i, 'init'), nsl = evalFloat(fn.m_flNoiseScaleLoc, c, i, 'init');
        const p = getV(c, A.POSITION, i);
        const tt = F(F(off + getF(c, A.CREATION, i)) * ns);
        const q = [0, 1, 2].map((k) => F(F(F(offLoc[k] + p[k]) * nsl) + tt));
        let v = [0, 1, 2].map((k) => {
          let n = valueNoise3(q[0] + C[k][0], q[1] + C[k][1], q[2] + C[k][2]);
          if (abs[k] !== 0) n = Math.abs(n);
          if (anyInv) n = inv[k] !== 0 ? n + 1 : -n;
          const sk = abs[k] !== 0 ? 1 : 0.5, range = mx[k] - mn[k];
          return n * range * sk + mn[k] + range * (1 - sk);
        });
        if (!fn.m_bIgnoreDt) v = mul(v, c.prevDt);
        if (frame) v = toWorld(frame, v);
        setV(c, A.PREV, i, sub(getV(c, A.PREV, i), v));
      }
    },
  },

  // particles.dll 63babcbf: C_INIT_PositionPlaceOnGround slot 34 0x18013b3c0, class init slot 6 0x18013b250 (content
  // mask 0x1c3001, 0x1db001 with m_bIncludeWater). Per particle: dir = normalised m_vecTraceDir, P = m_nAttribute;
  // the trace runs from P - dir*0.1 (DAT_180534194) for m_flMaxTraceLength. On a hit, a start-solid trace, or
  // TRACE_END: offset = m_flOffset (+ m_flOffsetByRadiusFactor * radius; + start.z - CP[m_nPreserveOffsetCP].z),
  // P += dir * (length * fraction - 0.1 - offset), written unless m_bSetPXYZOnly; with m_nAttribute 0 the previous
  // position moves by the same amount; m_bSetNormal writes the hit normal to m_nGroundNormalAttribute. A miss with
  // KILL sets life -1 (and still writes the normal).
  // UNSETTLED: GameInfo "Particles/ParticleTraceOffsetOnlyHit" (read at 0x18013c1xx) is taken as 0, so its
  // second radius trace and the m_bOffsetonColOnly path are not implemented.
  C_INIT_PositionPlaceOnGround: {
    evidence: 'RE',
    init(fn, c, s, e) {
      const attr = fn.m_nAttribute | 0;
      if (!VECTOR_ATTRS.has(attr)) { report(c, `C_INIT_PositionPlaceOnGround attribute ${attr} is not a vector stream`); return; }
      const miss = enumIndex(fn.m_nTraceMissBehavior, MISS);
      const query = traceQuery(fn, fn.m_bIncludeWater ? 0x1db001 : 0x1c3001);
      const pcp = fn.m_nPreserveOffsetCP | 0;
      const preserveZ = pcp >= 0 ? getCp(c, pcp).position[2] : 0;
      const normalOut = fn.m_nGroundNormalAttribute ?? A.NORMAL;
      for (let i = s; i < e; i++) {
        const dir = safeNorm(evalVec(fn.m_vecTraceDir, c, i, 'init'));
        const r = getF(c, A.RADIUS, i);
        const P = getV(c, attr, i);
        let offset = evalFloat(fn.m_flOffset, c, i, 'init');
        const length = evalFloat(fn.m_flMaxTraceLength, c, i, 'init');
        const start = sub(P, mul(dir, 0.1));
        const t = worldTrace(c, start, dir, length, query);
        if (t.fraction < 1 || t.startSolid || miss === 2) {
          if (+fn.m_flOffsetByRadiusFactor) offset += +fn.m_flOffsetByRadiusFactor * r;
          if (pcp >= 0) offset += start[2] - preserveZ;
          const move = mul(dir, length * t.fraction - 0.1 - offset);
          if (!fn.m_bSetPXYZOnly) setV(c, attr, i, add(P, move));
          if (attr === A.POSITION) setV(c, A.PREV, i, add(getV(c, A.PREV, i), move));
        } else if (miss !== 0) {
          setF(c, A.LIFE, i, -1);
        } else continue;
        if (fn.m_bSetNormal && VECTOR_ATTRS.has(normalOut)) setV(c, normalOut, i, t.normal);
      }
    },
  },

  // particles.dll 63babcbf: C_OP_MaxVelocity Operate slot 34 0x1801f6720. d = pos - prev, |d| against max*dt and
  // min*dt: scale = max*dt / |d| when |d| > max*dt, min*dt / |d| when |d| < min*dt. A block with min velocity > 0
  // and a zero step gets d = (R, R, 0.1 - Rx - Ry) from the thread-local generator FUN_18036b9c0 (0.1 at
  // 0x180534750). pos = prev + d*scale; strength < 1 blends: pos = (prev + d*scale) * s + pos * (1 - s).
  C_OP_MaxVelocity: {
    evidence: 'RE',
    op(fn, c, strength, st) {
      const dt = c.dt;
      for (let i = 0; i < c.count; i++) {
        const maxD = evalFloat(fn.m_flMaxVelocity, c, i) * dt;
        const minV = evalFloat(fn.m_flMinVelocity, c, i), minD = minV * dt;
        const p = getV(c, A.POSITION, i), q = getV(c, A.PREV, i);
        let d = sub(p, q), l2 = dot(d, d);
        if (minV > 0 && l2 <= 0) {
          const rnd = tlsRandom(st);
          const x = rnd(), y = rnd();
          d = [x, y, F(F(0.1 - x) - y)];
          l2 = dot(d, d);
        }
        const l = Math.sqrt(l2);
        let k = maxD < l ? maxD / l : 1;
        if (l < minD) k = minD / l;
        const np = add(q, mul(d, k));
        setV(c, A.POSITION, i, strength >= 1 ? np : add(mul(np, strength), mul(p, 1 - strength)));
      }
    },
  },

  // particles.dll 63babcbf: C_OP_Noise Operate slot 34 0x1801d08a0, class init slot 6 0x1801d07b0 (angle outputs
  // scale min/max by DAT_180534170). out = noise(pos.x * scale + m_flNoiseAnimationTimeScale * time, pos.y * scale,
  // pos.z * scale) * (max-min)*0.5 + min + (max-min)*0.5; m_bAdditive adds that * dt. Strength is not read.
  C_OP_Noise: {
    evidence: 'RE',
    op(fn, c) {
      const out = fn.m_nFieldOutput | 0;
      if (VECTOR_ATTRS.has(out) || !c.attr[out]) { report(c, `C_OP_Noise output ${out} is not a scalar stream`); return; }
      const ang = inMask(ANGLE_MASK, out) ? DEG2RAD : 1;
      const mn = F(+fn.m_flOutputMin * ang), mx = F(+fn.m_flOutputMax * ang);
      const half = F((mx - mn) * 0.5), mid = F(mn + half);
      const sc = +fn.m_fl4NoiseScale, tx = F(+fn.m_flNoiseAnimationTimeScale * c.time);
      for (let i = 0; i < c.count; i++) {
        const p = getV(c, A.POSITION, i);
        const v = valueNoise3(F(p[0] * sc) + tx, p[1] * sc, p[2] * sc) * half + mid;
        setF(c, out, i, fn.m_bAdditive ? getF(c, out, i) + v * c.dt : v);
      }
    },
  },

  // particles.dll 63babcbf: C_OP_CurlNoiseForce AddForces slot 34 0x180112150. p = m_vecOffset + m_vecOffsetRate *
  // time (coll+0x40) + pos * m_vecNoiseFreq; acc += noise(p) * m_vecNoiseScale * strength. PERLIN calls
  // FUN_180364be0 (440 instructions), CURL FUN_180368760 (three FUN_180368850 calls at offsets 0x18046b7c0..830,
  // their differences), WORLEY FUN_180367970 (with m_flWorleySeed / m_flWorleyJitter).
  // UNSETTLED: none of the three vector noises is ported yet (SIMD bodies the decompiler drops); the class reports
  // and adds nothing.
  C_OP_CurlNoiseForce: {
    evidence: 'RE',
    noop: 'its vector noise bodies (0x180364be0, 0x180368850, 0x180367970) are not ported yet',
    force(fn, c) { report(c, `C_OP_CurlNoiseForce ${fn.m_nNoiseType} noise is not ported (adds no force)`); },
  },

  // particles.dll 63babcbf: C_INIT_InheritVelocity slot 34 0x18014c4e0. With dt > 0: v = (cp - cp prev) * prev dt /
  // dt; if |v| < 100 (DAT_18053432c) prev -= v * m_flVelocityScale.
  C_INIT_InheritVelocity: {
    evidence: 'RE',
    init(fn, c, s, e) {
      if (!(c.dt > 0)) return;
      const cp = getCp(c, clamp(fn.m_nControlPointNumber | 0, 0, 63));
      const v = mul(sub(cp.position, cp.prevPosition), c.prevDt * (1 / c.dt));
      if (!(len(v) < 100)) return;
      const k = +fn.m_flVelocityScale;
      for (let i = s; i < e; i++) setV(c, A.PREV, i, sub(getV(c, A.PREV, i), mul(v, k)));
    },
  },

};
