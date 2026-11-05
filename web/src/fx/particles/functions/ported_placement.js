// Ported from CS2's particles.dll (tools/particles/PORTING.md), split from ported_forces.js: position warps, creation
// noise, radial velocity, ground placement, per-particle forces, normal offsets, paths and point-to-point moves. Build:
// particles.dll md5 63babcbf3245e56855a777134323e74a ("63babcbf" below); constants via tools/particles/consts.py.
import { A, VECTOR_ATTRS, add, sub, mul, dot, cross, len, clamp, getV, setV, getF, setF, getInitV, getCp,
  cpPositionAt, drawVarying, report, toWorld, transformOf, FLT_EPSILON, FLT_MIN, DEG2RAD, isZero, enumIndex,
  vec3 } from './common.js';
import { evalFloat, evalVec } from '../inputs.js';
import { F, T, ANGLE_MASK, inMask, lerp, safeNorm, cpFrameAt, randomInBall, valueNoise3, traceQuery, worldTrace,
  MISS } from './ported_forces.js';

const ALPHA_MASK = 0x10080; // attributes 7, 16 (alpha, alpha 2): clamped [0, 1]

// A point through a 3x4 frame (FUN_18035ecc0: M * (v, 1)).
const toWorldPoint = (f, v) => add(f.position, toWorld(f, v));

// The initializer dispatcher every class here inherits (slot 36, 0x1800a0ec0): fewer than 16 particles run the
// per-particle slot 34 for all of them; otherwise slot 34 runs up to the first 4-aligned index, slot 35 (blocks of
// four) over the aligned middle, slot 34 over the rest. Only C_INIT_CreationNoise has a block slot that differs.
const dispatch = (start, end, single, block) => {
  const n = end - start;
  if (n < 16) { single(start, end); return; }
  let s = start;
  if (s & 3) { const k = Math.min(4 - (s & 3), n); single(s, s + k); s += k; }
  const blocks = (end - s) >> 2;
  if (blocks) { block(s, blocks); s += blocks * 4; }
  if (s < end) single(s, end);
};

export const ported_placement = {
  // particles.dll 63babcbf: C_INIT_PositionWarp slot 34 0x180145ff0, class init slot 6 0x180145fa0 (CP clamped 0..63,
  // radius component clamped -1..2), context init slot 11 0x180145f90 ({ collection time, 0, 0 }). warp =
  // lerp(lo, hi, t) with lo/hi = WarpMin/WarpMax (swapped by m_bInvertWarp), both times the position of
  // m_nScaleControlPointNumber when >= 0. t per axis = T[c910 + 2*c914 + k] (c910 += 3) when m_flWarpTime is 0; else
  // t = clamp((creation time - (start + t0)) / (warp time), 0, 1) with t0 the context time, or the running particle
  // count in place of creation time with m_bUseCount. pos = cp + R(R^T(pos - cp) * warp), prev the same with warp *
  // m_flPrevPosScale (the CP frame at creation time, FUN_1800c1e70 / FUN_18035ecc0); radius *= warp[component] when
  // the component is >= 0. UNSETTLED: when the game calls slot 11 (here: the collection's start time).
  C_INIT_PositionWarp: {
    evidence: 'RE',
    init(fn, c, s, e, _str, st) {
      let wmin = evalVec(fn.m_vecWarpMin, c, -1, 'init'), wmax = evalVec(fn.m_vecWarpMax, c, -1, 'init');
      let lo = fn.m_bInvertWarp ? wmax : wmin, hi = fn.m_bInvertWarp ? wmin : wmax;
      const scp = fn.m_nScaleControlPointNumber | 0;
      if (scp >= 0) {
        const p = getCp(c, scp).position;
        lo = [lo[0] * p[0], lo[1] * p[1], lo[2] * p[2]];
        hi = [hi[0] * p[0], hi[1] * p[1], hi[2] * p[2]];
      }
      if (!st.ctx) st.ctx = { t0: c.startTime ?? c.time, base: 0, count: 0 };
      const cpi = clamp(fn.m_nControlPointNumber | 0, 0, 63);
      const rc = clamp(fn.m_nRadiusComponent | 0, -1, 2);
      const wt = +fn.m_flWarpTime;
      for (let i = s; i < e; i++) {
        let tv;
        if (wt === 0) {
          const b = c.rnd.counter + 2 * c.rnd.offset;
          tv = [T(c, b), T(c, b + 1), T(c, b + 2)];
          c.rnd.counter += 3;
        } else {
          let t0 = +fn.m_flWarpStartTime, t1 = t0 + wt, x;
          if (!fn.m_bUseCount) { t0 += st.ctx.t0; t1 += st.ctx.t0; x = getF(c, A.CREATION, i); } else { t0 += st.ctx.base; t1 += st.ctx.base; x = st.ctx.count++; }
          const t = t0 === t1 ? (x - t1 < 0 ? 0 : 1) : clamp((x - t0) / (t1 - t0), 0, 1);
          tv = [t, t, t];
        }
        const warp = [lerp(lo[0], hi[0], tv[0]), lerp(lo[1], hi[1], tv[1]), lerp(lo[2], hi[2], tv[2])];
        const f = cpFrameAt(c, cpi, getF(c, A.CREATION, i));
        const loc = (v) => { const d = sub(v, f.position); return [dot(d, f.forward), dot(d, f.left), dot(d, f.up)]; };
        const pl = loc(getV(c, A.POSITION, i)), ql = loc(getV(c, A.PREV, i));
        const ps = +fn.m_flPrevPosScale;
        setV(c, A.POSITION, i, toWorldPoint(f, [pl[0] * warp[0], pl[1] * warp[1], pl[2] * warp[2]]));
        setV(c, A.PREV, i, toWorldPoint(f, [ql[0] * warp[0] * ps, ql[1] * warp[1] * ps, ql[2] * warp[2] * ps]));
        if (rc >= 0) setF(c, A.RADIUS, i, getF(c, A.RADIUS, i) * warp[rc]);
      }
    },
  },

  // particles.dll 63babcbf: C_INIT_CreationNoise per-particle slot 34 0x180147050, block slot 35 0x180146da0.
  // Per particle: noise(t*scale + ms*wts + (pos.x + offLoc.x) * scaleLoc, ...) with t = creation time of the call's
  // first particle + m_flOffset,
  // ms = Plat_MSTime(), wts = m_flWorldTimeScale; |n| with m_bAbsVal (scale 1, else 0.5); 1 - n with m_bAbsValInv;
  // out = n*(max-min)*s + (1-s)*(max-min) + min, alpha outputs clamped [0, 1], angle outputs' min/max * DAT_180534170.
  // The block slot (0x180146f70 loop) drops the world-time term and adds, for lane k of every block, the creation
  // time of particle (first block * 4 + k): read once before the loop and never advanced.
  // UNSETTLED: Plat_MSTime is the engine's millisecond clock; opts.now() seconds * 1000, truncated, stands in.
  C_INIT_CreationNoise: {
    evidence: 'RE',
    init(fn, c, s, e) {
      const out = fn.m_nFieldOutput | 0;
      if (VECTOR_ATTRS.has(out) || !c.attr[out]) { report(c, `C_INIT_CreationNoise output ${out} is not a scalar stream`); return; }
      const sc = fn.m_bAbsVal ? 1 : 0.5;
      const ang = inMask(ANGLE_MASK, out) ? DEG2RAD : 1;
      const mn = F(+fn.m_flOutputMin * ang), mx = F(+fn.m_flOutputMax * ang), range = mx - mn;
      const ns = +fn.m_flNoiseScale, nsl = +fn.m_flNoiseScaleLoc, off = +fn.m_flOffset;
      const ol = vec3(fn.m_vecOffsetLoc);
      const ms = Math.trunc((+c.sys.now() || 0) * 1000), wts = +fn.m_flWorldTimeScale;
      const write = (i, n) => {
        if (fn.m_bAbsVal) n = Math.abs(n);
        if (fn.m_bAbsValInv) n = 1 - n;
        let v = n * range * sc + (1 - sc) * range + mn;
        if (inMask(ALPHA_MASK, out)) v = clamp(v, 0, 1);
        setF(c, out, i, v);
      };
      const single = (a, b) => {
        // The creation time is read once, for the call's first particle, before the loop (0x180147050).
        const t = F(getF(c, A.CREATION, a) + off) * ns + ms * wts;
        for (let i = a; i < b; i++) {
          const p = getV(c, A.POSITION, i);
          write(i, valueNoise3(t + (p[0] + ol[0]) * nsl, t + (p[1] + ol[1]) * nsl, t + (p[2] + ol[2]) * nsl));
        }
      };
      const block = (a, n) => {
        const t4 = [0, 1, 2, 3].map((k) => F(F(off + getF(c, A.CREATION, a + k)) * ns));
        for (let bI = 0; bI < n; bI++) {
          for (let k = 0; k < 4; k++) {
            const i = a + 4 * bI + k;
            const p = getV(c, A.POSITION, i);
            write(i, valueNoise3(F(p[0] + ol[0]) * nsl + t4[k], F(p[1] + ol[1]) * nsl + t4[k], F(p[2] + ol[2]) * nsl + t4[k]));
          }
        }
      };
      dispatch(s, e, single, block);
    },
  },

  // particles.dll 63babcbf: C_INIT_VelocityRadialRandom slot 34 0x180140810, class init slot 6 0x1801407b0 (CP clamped
  // 0..63; local scale flag = m_vecLocalCoordinateSystemSpeedScale != (1,1,1)). Centre: the CP position at creation
  // time, or m_vecPosition with m_bPerParticleCenter. dir = normalised pos - centre (0 for a zero vector); with the
  // local scale flag, dir *= R * scale (FUN_18035ec80) with R the CP frame at creation time, or for a per-particle
  // centre the frame built from m_vecFwd: left = cross((0,0,1), fwd), up = cross(fwd, left) (FUN_18035eed0).
  // v = dir * lerp(m_fSpeedMin, m_fSpeedMax, T[c910++ + c914]); times prev dt unless m_bIgnoreDelta; prev -= v.
  // UNSETTLED: the degenerate (vertical m_vecFwd) branch FUN_18035ed10 is read as left (0,1,0).
  C_INIT_VelocityRadialRandom: {
    evidence: 'RE',
    init(fn, c, s, e) {
      const cpi = clamp(fn.m_nControlPointNumber | 0, 0, 63);
      const ls = vec3(fn.m_vecLocalCoordinateSystemSpeedScale, [1, 1, 1]);
      const scaled = !(ls[0] === 1 && ls[1] === 1 && ls[2] === 1);
      for (let i = s; i < e; i++) {
        const smin = evalFloat(fn.m_fSpeedMin, c, i, 'init'), smax = evalFloat(fn.m_fSpeedMax, c, i, 'init');
        const p = getV(c, A.POSITION, i);
        let dir, k = null;
        if (!fn.m_bPerParticleCenter) {
          const f = cpFrameAt(c, cpi, getF(c, A.CREATION, i));
          dir = safeNorm(sub(p, f.position));
          if (scaled) k = toWorld(f, ls);
        } else {
          const centre = evalVec(fn.m_vecPosition, c, i, 'init'), fwd = evalVec(fn.m_vecFwd, c, i, 'init');
          dir = safeNorm(sub(p, centre));
          if (scaled) {
            let left = cross([0, 0, 1], fwd);
            left = len(left) < 1.1920929e-7 ? [0, 1, 0] : safeNorm(left);
            const up = safeNorm(cross(fwd, left));
            k = toWorld({ forward: fwd, left, up }, ls);
          }
        }
        if (k) dir = [dir[0] * k[0], dir[1] * k[1], dir[2] * k[2]];
        const sp = smin + (smax - smin) * drawVarying(c);
        let v = mul(dir, sp);
        if (!fn.m_bIgnoreDelta) v = mul(v, c.prevDt);
        setV(c, A.PREV, i, sub(getV(c, A.PREV, i), v));
      }
    },
  },

  // particles.dll 63babcbf: C_OP_MovementPlaceOnGround Operate slot 34 0x1801f0660, class init slot 6 0x1801f0530
  // (content mask 0x1c3001 with m_bIncludeShotHull, | 0x18000 with water; "use reference CPs" = any ref/lerp CP >= 0
  // and tolerance > 0; "lerp" = lerp CP >= 0 or lerp rate > 0), context init slot 11 0x1801f05e0 (reference
  // positions FLT_MAX, time = collection time). Each frame: with reference CPs, a ref CP that moved more than the
  // tolerance from its stored position stores it, stamps the time and asks for traces (the lerp CP only stores).
  // Without reference CPs and without lerp every frame traces. Lerp factor: lerp rate <= 0 -> |lerp CP - stored| /
  // tolerance clamped [0,1]; else (time - stamp) / lerp rate clamped, and at 1 (without reference CPs) the stamp moves
  // to now and traces run. Per particle: dir = normalised m_vecTraceDir; offset = m_flOffset (* radius with
  // m_bScaleOffset; + the preserved z, kept in the initial hitbox-offset stream); the trace runs from pos -
  // dir*m_flTraceOffset for max(m_flMaxTraceLength, offset + trace offset when a miss behaviour is set). A hit or
  // TRACE_END places P = hit + n*offset (n = -dir, or the hit normal written to the normal with m_bSetNormal); without
  // lerp pos = P; with lerp the hit is kept in the hitbox-offset stream (the old one in the initial previous
  // position) and pos_k = lerp(old_k, hit_k, f) * |dir_k| + pos_k * (1 - |dir_k|). prev keeps the step (pos - prev).
  // A KILL miss sets life -1.
  C_OP_MovementPlaceOnGround: {
    evidence: 'RE',
    op(fn, c, _str, st) {
      const ref1 = fn.m_nRefCP1 | 0, ref2 = fn.m_nRefCP2 | 0, lcp = fn.m_nLerpCP | 0;
      const tol = +fn.m_flTolerance, tol2 = tol * tol;
      const useRef = !((ref1 < 0 && ref2 < 0 && lcp < 0) || tol <= 0);
      const useLerp = lcp >= 0 || +fn.m_flLerpRate > 0;
      const miss = enumIndex(fn.m_nTraceMissBehavior, MISS);
      let contents = fn.m_bIncludeShotHull ? 0x1c3001 : 0;
      if (fn.m_bIncludeWater) contents |= 0x18000;
      const query = traceQuery(fn, contents);
      const BIG = 3.4028234663852886e38;
      if (!st.ctx) st.ctx = { ref1: [BIG, BIG, BIG], ref2: [BIG, BIG, BIG], lerp: [BIG, BIG, BIG], time: c.time };
      const ctx = st.ctx;
      let any = false, trace = false;
      if (!useRef) { if (!useLerp) any = trace = true; } else {
        const moved = (i, k) => { const p = getCp(c, i).position, d = sub(p, ctx[k]); return dot(d, d) > tol2; };
        if (ref1 >= 0 && moved(ref1, 'ref1')) { ctx.ref1 = getCp(c, ref1).position.slice(); ctx.time = c.time; any = trace = true; }
        if (ref2 >= 0 && moved(ref2, 'ref2')) { ctx.ref2 = getCp(c, ref2).position.slice(); ctx.time = c.time; any = trace = true; }
        if (lcp >= 0 && moved(lcp, 'lerp')) ctx.lerp = getCp(c, lcp).position.slice();
      }
      const pcp = fn.m_nPreserveOffsetCP | 0;
      const preserveZ = pcp >= 0 ? getCp(c, pcp).position[2] : 0;
      let f = 0;
      if (useLerp) {
        const rate = +fn.m_flLerpRate;
        if (rate <= 0) {
          if (lcp >= 0) { const x = len(sub(getCp(c, lcp).position, ctx.lerp)) / tol; f = x >= 0 ? Math.min(x, 1) : 0; }
        } else {
          const t0 = ctx.time, t1 = t0 + rate;
          f = t0 === t1 ? (c.time - t1 < 0 ? 0 : 1) : clamp((c.time - t0) / (t1 - t0), 0, 1);
          if (f === 1 && !useRef) { ctx.time = c.time; trace = true; }
        }
      } else if (!any) return;
      for (let i = 0; i < c.count; i++) {
        const dir = safeNorm(evalVec(fn.m_vecTraceDir, c, i));
        const pos = getV(c, A.POSITION, i), prev = getV(c, A.PREV, i);
        const step = sub(pos, prev);
        let hb = getV(c, A.HITBOX_OFFSET, i), from = getInitV(c, A.PREV, i);
        let offset = evalFloat(fn.m_flOffset, c, i);
        if (fn.m_bScaleOffset) offset *= getF(c, A.RADIUS, i);
        let maxLen = +fn.m_flMaxTraceLength;
        if (miss !== 0 && maxLen <= offset + +fn.m_flTraceOffset) maxLen = offset + +fn.m_flTraceOffset;
        if (pcp >= 0) {
          const s3 = c.init[A.HITBOX_OFFSET];
          if (s3[3 * i] === 0) { s3[3 * i + 2] = getInitV(c, A.POSITION, i)[2] - preserveZ; s3[3 * i] = 1; }
          offset += s3[3 * i + 2];
        }
        if (useLerp && isZero(hb)) { trace = true; hb = pos.slice(); from = pos.slice(); }
        let to = hb, write = true, np = pos;
        if (trace) {
          const start = sub(pos, mul(dir, +fn.m_flTraceOffset));
          const t = worldTrace(c, start, dir, maxLen, query);
          if (t.fraction !== 1 || miss === 2) {
            let n = mul(dir, -1);
            if (fn.m_bSetNormal) { setV(c, A.NORMAL, i, t.normal); n = t.normal; }
            const P = add(t.pos, mul(n, offset));
            if (!useLerp) np = P; else {
              c.init[A.PREV].set(hb, 3 * i);
              setV(c, A.HITBOX_OFFSET, i, P);
              from = hb; to = P;
            }
          } else if (miss !== 0) setF(c, A.LIFE, i, -1); else write = false;
        }
        if (!write) continue;
        if (useLerp) {
          np = [0, 1, 2].map((k) => { const a = Math.abs(dir[k]); return lerp(from[k], to[k], f) * a + (1 - a) * pos[k]; });
        }
        setV(c, A.POSITION, i, np);
        setV(c, A.PREV, i, sub(np, step));
      }
    },
  },

  // particles.dll 63babcbf: C_OP_PerParticleForce AddForces slot 34 0x1801132c0. f = m_vForce per particle, rotated
  // by m_nCP's frame (x*fwd + y*left + z*up, cp+0x18/+0x30/+0x24) when m_nCP >= 0; acc += f * m_flForceScale * strength.
  C_OP_PerParticleForce: {
    evidence: 'RE',
    force(fn, c, acc, strength) {
      const cpi = fn.m_nCP | 0;
      const cp = cpi >= 0 ? getCp(c, cpi) : null;
      for (let i = 0; i < c.count; i++) {
        let f = evalVec(fn.m_vForce, c, i);
        if (cp) f = toWorld(cp, f);
        const k = strength * evalFloat(fn.m_flForceScale, c, i);
        for (let a = 0; a < 3; a++) acc[3 * i + a] += f[a] * k;
      }
    },
  },

  // particles.dll 63babcbf: C_INIT_NormalOffset slot 34 0x18015a910, class init slot 6 0x18015a8f0 (CP clamped 0..63).
  // off = lerp(m_OffsetMin, m_OffsetMax, T[c910 + 2*c914 + k]) (c910 += 3), rotated by the CP frame at creation time
  // with m_bLocalCoords (FUN_18035ec80); normal += off; normalised (FUN_18035ead0 range) with m_bNormalize.
  C_INIT_NormalOffset: {
    evidence: 'RE',
    init(fn, c, s, e) {
      const lo = vec3(fn.m_OffsetMin), hi = vec3(fn.m_OffsetMax);
      const cpi = clamp(fn.m_nControlPointNumber | 0, 0, 63);
      for (let i = s; i < e; i++) {
        const b = c.rnd.counter + 2 * c.rnd.offset;
        let off = [lerp(lo[0], hi[0], T(c, b)), lerp(lo[1], hi[1], T(c, b + 1)), lerp(lo[2], hi[2], T(c, b + 2))];
        c.rnd.counter += 3;
        if (fn.m_bLocalCoords) off = toWorld(cpFrameAt(c, cpi, getF(c, A.CREATION, i)), off);
        let n = add(getV(c, A.NORMAL, i), off);
        if (fn.m_bNormalize && !isZero(n)) n = safeNorm(n);
        setV(c, A.NORMAL, i, n);
      }
    },
  },

  // particles.dll 63babcbf: C_OP_ConstrainDistanceToPath constraint slot 35 0x1800eac00, class init slot 6 0x1800eab60
  // (start/end CP clamped 0..63, mid CP -1..63), path FUN_18004d170: S = start CP + start offset, E = end CP + end
  // offset; mid = 2*midCP - S/2 - E/2 (0.25 at DAT_1805341ac) with a mid CP, else S + (E-S)*m_flMidPoint plus either
  // a CONSTANT random bulge 2b*T[c914 + k] - b (bulge control 0) or the start/end CP forward (bulge control 1/2) times
  // |E-S| * b * (1 - |dot(dir, fwd)|) / |fwd|; mid += mid offset. t = min(1, (time - creation) / max(travel time *
  // scale field, FLT_EPSILON)) or the manual t field; the point is the quadratic Bezier B(t). The allowed distance is
  // max(max0, mid, max1) unless they differ and no particle of the block of four exceeds it, then the Bezier of
  // (max0, mid, max1) at t; beyond it the particle is pulled to that distance, inside m_fMinDistance pushed out to it.
  // UNSETTLED: the path's CPs are read at the current time (the call passes a time the decompiler mislabels).
  C_OP_ConstrainDistanceToPath: {
    evidence: 'RE',
    constrain(fn, c) {
      const pp = fn.m_PathParameters || {};
      const sc = clamp(pp.m_nStartControlPointNumber | 0, 0, 63), ec = clamp(pp.m_nEndControlPointNumber | 0, 0, 63);
      const mc = clamp(pp.m_nMidControlPointNumber ?? -1, -1, 63);
      const S = add(getCp(c, sc).position, vec3(pp.m_vStartPointOffset)), E = add(getCp(c, ec).position, vec3(pp.m_vEndOffset));
      let M;
      if (mc < 0) {
        const D = sub(E, S);
        M = add(S, mul(D, +(pp.m_flMidPoint ?? 0.5)));
        const bulge = +pp.m_flBulge || 0, bc = enumIndex(pp.m_nBulgeControl, [], 0);
        if (bc === 0) {
          M = [0, 1, 2].map((k) => (bulge - -bulge) * T(c, c.rnd.offset + k) + -bulge + M[k]);
        } else {
          const fwd = getCp(c, bc === 2 ? ec : sc).forward;
          const L = len(D);
          let w = 0;
          if (L > 1e-6) w = 1 - Math.abs(dot(mul(D, 1 / L), fwd));
          const fl = len(fwd);
          if (fl > 1e-6) M = add(M, mul(fwd, (L * bulge * w) / fl));
        }
      } else {
        const m = getCp(c, mc).position;
        M = [0, 1, 2].map((k) => 2 * (m[k] - S[k] * 0.25 - E[k] * 0.25));
      }
      M = add(M, vec3(pp.m_vMidPointOffset));
      const max0 = +fn.m_flMaxDistance0, midIn = +fn.m_flMaxDistanceMid, max1In = +fn.m_flMaxDistance1;
      const mid = midIn >= 0 ? midIn : max0;
      const max1 = max1In >= 0 ? max1In : mid;
      const constant = (midIn < 0 || midIn === max0) && (max1In < 0 || max1In === max0);
      const all = Math.max(max0, Math.max(mid, max1));
      const minD = +fn.m_fMinDistance;
      const scaleField = fn.m_nFieldScale ?? A.NONE, tField = fn.m_nManualTField ?? A.NONE;
      const bez = (a, b, d, t) => { const x = lerp(a, b, t), y = lerp(b, d, t); return lerp(x, y, t); };
      for (let b0 = 0; b0 < c.count; b0 += 4) {
        const n = Math.min(4, c.count - b0), rows = [];
        let over = false;
        for (let k = 0; k < n; k++) {
          const i = b0 + k;
          const scale = scaleField === A.NONE ? 1 : getF(c, scaleField, i);
          const inv = 1 / Math.max(+fn.m_flTravelTime * scale, FLT_EPSILON);
          const t = tField === A.NONE ? Math.min(1, (c.time - getF(c, A.CREATION, i)) * inv) : getF(c, tField, i);
          const P = [0, 1, 2].map((a) => bez(S[a], M[a], E[a], t));
          const d = sub(getV(c, A.POSITION, i), P), d2 = dot(d, d);
          if (all * all < d2) over = true;
          rows.push({ i, t, P, d, d2 });
        }
        for (const r of rows) {
          const allowed = !constant && !over ? bez(max0, mid, max1, r.t) : all;
          const tooFar = allowed * allowed < r.d2, tooNear = r.d2 < minD * minD;
          if (!tooFar && !tooNear) continue;
          const inv = 1 / Math.sqrt(Math.abs(r.d2) < FLT_MIN ? FLT_EPSILON : r.d2);
          const dist = tooNear ? minD : allowed;
          setV(c, A.POSITION, r.i, add(r.P, mul(r.d, inv * dist)));
        }
      }
    },
  },

  // particles.dll 63babcbf: C_INIT_MoveBetweenPoints slot 34 0x18014ae10. end = the end CP at creation time plus, when
  // m_flEndSpread > 0, spread * randomInBall; d = end - pos. m_flEndOffset moves end by d * off / (|d| + eps),
  // m_flStartOffset moves pos the same way (written back), eps = FLT_EPSILON (DAT_18053413c). speed =
  // lerp(min, max, T[c910++ + c914]); life = |d| / (speed + eps) (+ trail length with m_bTrailBias); prev = pos - d *
  // speed / (|d| + eps) * prev dt.
  C_INIT_MoveBetweenPoints: {
    evidence: 'RE',
    init(fn, c, s, e) {
      const ecp = fn.m_nEndControlPointNumber | 0;
      const eps = 1.1920929e-7;
      for (let i = s; i < e; i++) {
        const smin = evalFloat(fn.m_flSpeedMin, c, i, 'init'), smax = evalFloat(fn.m_flSpeedMax, c, i, 'init');
        const spread = evalFloat(fn.m_flEndSpread, c, i, 'init');
        const so = evalFloat(fn.m_flStartOffset, c, i, 'init'), eo = evalFloat(fn.m_flEndOffset, c, i, 'init');
        let pos = getV(c, A.POSITION, i);
        let end = cpPositionAt(c, getCp(c, clamp(ecp, 0, 63)), getF(c, A.CREATION, i));
        if (spread > 0) end = add(end, mul(randomInBall(c), spread));
        let d = sub(end, pos), L = len(d);
        if (eo !== 0) { end = add(end, mul(d, eo / (L + eps))); d = sub(end, pos); L = len(d); }
        if (so !== 0) { pos = add(pos, mul(d, so / (L + eps))); d = sub(end, pos); L = len(d); }
        const speed = smin + (smax - smin) * drawVarying(c);
        let life = L / (speed + eps);
        if (fn.m_bTrailBias) life += getF(c, A.TRAIL, i);
        setF(c, A.LIFE, i, life);
        if (so !== 0) setV(c, A.POSITION, i, pos);
        setV(c, A.PREV, i, sub(pos, mul(d, (speed / (L + eps)) * c.prevDt)));
      }
    },
  },

  // particles.dll 63babcbf: C_INIT_RemapInitialDirectionToTransformToVector slot 34 0x180160e70. R = rotation about
  // m_vecOffsetAxis by m_flOffsetRot degrees (FUN_18035d0c0, * DAT_180534170); out = R * (pos - transform position)
  // (the transform's orientation is not used), normalised with m_bNormalize when non-zero, times m_flScale.
  C_INIT_RemapInitialDirectionToTransformToVector: {
    evidence: 'RE',
    init(fn, c, s, e) {
      const out = fn.m_nFieldOutput | 0;
      if (!VECTOR_ATTRS.has(out)) { report(c, `C_INIT_RemapInitialDirectionToTransformToVector output ${out} is not a vector stream`); return; }
      const ax = vec3(fn.m_vecOffsetAxis), ang = (+fn.m_flOffsetRot || 0) * DEG2RAD;
      const sn = Math.sin(ang), cs = Math.cos(ang), ic = 1 - cs;
      const [x, y, z] = ax;
      const R = [
        [(1 - x * x) * cs + x * x, y * x * ic - sn * z, z * x * ic + sn * y],
        [y * x * ic + sn * z, (1 - y * y) * cs + y * y, y * z * ic - sn * x],
        [z * x * ic - sn * y, y * z * ic + sn * x, (1 - z * z) * cs + z * z],
      ];
      const o = transformOf(c, fn.m_TransformInput).position;
      for (let i = s; i < e; i++) {
        const d = sub(getV(c, A.POSITION, i), o);
        let v = [dot(R[0], d), dot(R[1], d), dot(R[2], d)];
        if (fn.m_bNormalize && !isZero(v)) v = safeNorm(v);
        setV(c, out, i, mul(v, +fn.m_flScale));
      }
    },
  },
};
