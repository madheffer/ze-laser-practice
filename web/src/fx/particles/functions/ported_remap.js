// Ported from CS2's particles.dll (tools/particles/PORTING.md), split from ported_motion.js: scalar / vector remaps,
// lifetimes from sequences, orientation from directions and transforms, visibility and the culls. Build: particles.dll
// md5 63babcbf3245e56855a777134323e74a ("63babcbf" below).
import { A, VECTOR_ATTRS, add, sub, mul, dot, cross, norm, clamp, sat, getV, setV, getCp, drawVarying, FLT_EPSILON,
  angleVectors, attrIndex, cpPositionAt, kill, report, toWorld, transformOf, DEG2RAD, FLT_MIN } from './common.js';
import { evalFloat, evalVec } from '../inputs.js';
import { PI, age, setMethod, scalarOut, noise3 } from './ported_motion.js';

// The "remap one scalar" step these classes inline: in0 == in1 steps at in1 (x - in1 >= 0 -> out1), else a clamped lerp.
const remapClamped = (x, in0, in1, out0, out1) => {
  if (in0 === in1) return x - in1 >= 0 ? out1 : out0;
  return sat((x - in0) / (in1 - in0)) * (out1 - out0) + out0;
};

// Remap outputs to an alpha (mask 0x10080) clamp their output range to [0,1] first (0x1801f9c90, 0x1801cb930).
const unitRange = (out, lo, hi) => ((1 << out) & 0x10080 ? [sat(lo), sat(hi)] : [lo, hi]);

// rsqrt with one Newton step on |v|^2 + FLT_EPSILON (DAT_18053413c, DAT_180534280 = 3, DAT_1805341b8 = 0.5): exact here.
const nrm = (v) => mul(v, 1 / Math.sqrt(dot(v, v) + FLT_EPSILON));

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

export const ported_remap = {
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
