// Initializers: run once on each new particle in [start, end).
import { evalFloat, evalVec } from '../inputs.js';
import {
  A, ANGLE_ATTRS, RAD, VECTOR_ATTRS, add, angleVectors, applySetMethod, attrIndex, clamp, cpPositionAt, dot, drawVarying,
  getCp, getF, getV, len, lerp3, mul, norm, report, setF, setV, sub, toWorld, transformOf,
} from './common.js';

// Radical inverse in base b (Halton, RE §11 C_INIT_CreateWithinBox distribute-evenly).
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const T = (c, k) => c.table[k & 0xfff];

export const initializers = {
  // VRF cross-check, UNSETTLED: the notes give only the constructor defaults (0x1801b7750,
  // output field 3 = radius, RE §10). Angles are written in radians unless the method scales,
  // the same rule C_OP_SetFloat follows (RE §11, 0x18020bbc0).
  C_INIT_InitFloat: {
    evidence: 'VRF',
    init(fn, c, s, e) {
      const out = attrIndex(fn.m_nOutputField, A.RADIUS);
      if (VECTOR_ATTRS.has(out) || !c.attr[out]) { report(c, `C_INIT_InitFloat output ${out} is not a scalar stream`); return; }
      const scaling = fn.m_nSetMethod === 'PARTICLE_SET_SCALE_INITIAL_VALUE' || fn.m_nSetMethod === 'PARTICLE_SET_SCALE_CURRENT_VALUE';
      for (let i = s; i < e; i++) {
        let v = evalFloat(fn.m_InputValue, c, i, 'init');
        if (ANGLE_ATTRS.has(out) && !scaling) v *= RAD;
        const cur = getF(c, out, i);
        const target = applySetMethod(fn.m_nSetMethod, v, cur, cur, c.dt);
        const k = evalFloat(fn.m_InputStrength, c, i, 'init');
        setF(c, out, i, cur + (target - cur) * k);
      }
    },
  },

  // VRF cross-check, UNSETTLED: no maths in the notes.
  C_INIT_InitVec: {
    evidence: 'VRF',
    init(fn, c, s, e) {
      const out = attrIndex(fn.m_nOutputField, A.COLOR);
      if (!VECTOR_ATTRS.has(out)) { report(c, `C_INIT_InitVec output ${out} is not a vector stream`); return; }
      for (let i = s; i < e; i++) {
        let v = evalVec(fn.m_InputValue, c, i, 'init');
        const cur = getV(c, out, i);
        v = [0, 1, 2].map((k) => applySetMethod(fn.m_nSetMethod, v[k], cur[k], cur[k], c.dt));
        if (fn.m_bNormalizedOutput) v = norm(v);
        setV(c, out, i, v);
        if (fn.m_bWritePreviousPosition && out === A.POSITION) setV(c, A.PREV, i, v);
      }
    },
  },

  // RE §11 C_INIT_CreateWithinBox (0x180136ec0).
  C_INIT_CreateWithinBox: {
    evidence: 'RE',
    init(fn, c, s, e) {
      const cp = getCp(c, clamp(fn.m_nControlPointNumber | 0, 0, 63));
      const rp = fn.m_randomnessParameters || {};
      for (let i = s; i < e; i++) {
        const mn = evalVec(fn.m_vecMin, c, i, 'init'), mx = evalVec(fn.m_vecMax, c, i, 'init');
        let r;
        if (!rp.m_bDistributeEvenly) {
          // r_i = T[(c910 + 2*c914 + i) & 0xfff] (c914 is added twice in the code), c910 += 3.
          const b = c.rnd.counter + 2 * c.rnd.offset;
          r = [T(c, b), T(c, b + 1), T(c, b + 2)];
          c.rnd.counter += 3;
        } else {
          // Halton bases 2, 3, 5 at (seed < 0 ? seed + c914 : seed) + particle index, masked
          // 0x7fffffff. UNSETTLED: whether "particle index" is the stream index or the particle ID.
          const seed = rp.m_nSeed < 0 ? rp.m_nSeed + c.rnd.offset : rp.m_nSeed;
          const n = (seed + c.attr[A.ID][i]) & 0x7fffffff;
          r = [halton(n, 2), halton(n, 3), halton(n, 5)];
        }
        const local = add(mn, [(mx[0] - mn[0]) * r[0], (mx[1] - mn[1]) * r[1], (mx[2] - mn[2]) * r[2]]);
        const at = cpPositionAt(c, cp, c.attr[A.CREATION][i]);
        // Without m_bLocalSpace the box is world-axis aligned; with it, x forward, y left, z up.
        const p = fn.m_bLocalSpace ? add(at, toWorld(cp, local)) : add(at, local);
        setV(c, A.POSITION, i, p);
        // Position Previous is written when the init flags request it (flag 4). UNSETTLED: when
        // they do; written here, so the box gives no velocity.
        setV(c, A.PREV, i, p);
      }
    },
  },

  // VRF cross-check, UNSETTLED: no maths in the notes (constructor 0x18017c720 only).
  C_INIT_CreateWithinSphereTransform: {
    evidence: 'VRF',
    init(fn, c, s, e) {
      const out = attrIndex(fn.m_nFieldOutput, A.POSITION);
      const velOut = attrIndex(fn.m_nFieldVelocity, A.PREV);
      for (let i = s; i < e; i++) {
        const cp = transformOf(c, fn.m_TransformInput);
        const z = 2 * drawVarying(c) - 1, az = drawVarying(c) * 2 * Math.PI, frac = Math.cbrt(drawVarying(c));
        const sz = Math.sqrt(Math.max(0, 1 - z * z));
        const rv = [sz * Math.cos(az) * frac, sz * Math.sin(az) * frac, z * frac];
        const abs = fn.m_vecDistanceBiasAbs || [0, 0, 0];
        for (let k = 0; k < 3; k++) if (abs[k]) rv[k] = Math.abs(rv[k]);
        const b = evalVec(fn.m_vecDistanceBias, c, i, 'init');
        const dir = norm([rv[0] * b[0], rv[1] * b[1], rv[2] * b[2]]);
        const r0 = evalFloat(fn.m_fRadiusMin, c, i, 'init'), r1 = evalFloat(fn.m_fRadiusMax, c, i, 'init');
        const dist = r0 + (r1 - r0) * frac;
        const sp0 = evalFloat(fn.m_fSpeedMin, c, i, 'init'), sp1 = evalFloat(fn.m_fSpeedMax, c, i, 'init');
        const speed = sp0 + (sp1 - sp0) * Math.pow(drawVarying(c), clamp(fn.m_fSpeedRandExp ?? 1, -255, 255));
        const l0 = evalVec(fn.m_LocalCoordinateSystemSpeedMin, c, i, 'init'), l1 = evalVec(fn.m_LocalCoordinateSystemSpeedMax, c, i, 'init');
        const lsp = [0, 1, 2].map((k) => l0[k] + (l1[k] - l0[k]) * drawVarying(c));
        const off = mul(dir, dist);
        const p = add(cp.position, fn.m_bLocalCoords ? toWorld(cp, off) : off);
        setV(c, out, i, p);
        const vel = add(mul(fn.m_bLocalCoords ? toWorld(cp, dir) : dir, speed), toWorld(cp, lsp));
        // Velocity lives in Position Previous (prev = pos - v*dt).
        if (out === A.POSITION && velOut === A.PREV) setV(c, A.PREV, i, sub(p, mul(vel, c.prevDt)));
        else if (VECTOR_ATTRS.has(velOut)) setV(c, velOut, i, vel);
      }
    },
  },

  // VRF cross-check, UNSETTLED: no maths in the notes. Moves the previous position with the
  // position, so the offset adds no velocity (VRF recomputes it from velocity after init).
  C_INIT_PositionOffset: {
    evidence: 'VRF',
    init(fn, c, s, e) {
      for (let i = s; i < e; i++) {
        const lo = evalVec(fn.m_OffsetMin, c, i, 'init'), hi = evalVec(fn.m_OffsetMax, c, i, 'init');
        let off = [0, 1, 2].map((k) => lo[k] + (hi[k] - lo[k]) * drawVarying(c));
        if (fn.m_bProportional) off = mul(off, getF(c, A.RADIUS, i));
        if (fn.m_bLocalCoords) off = toWorld(transformOf(c, fn.m_TransformInput), off);
        setV(c, A.POSITION, i, add(getV(c, A.POSITION, i), off));
        setV(c, A.PREV, i, add(getV(c, A.PREV, i), off));
      }
    },
  },

  // VRF cross-check, UNSETTLED. The tint path samples scene lighting, which a preview has not.
  C_INIT_RandomColor: {
    evidence: 'VRF',
    init(fn, c, s, e) {
      const out = attrIndex(fn.m_nFieldOutput, A.COLOR);
      if (fn.m_flTintPerc > 0) report(c, 'C_INIT_RandomColor light tint not implemented');
      const lo = (fn.m_ColorMin || [255, 255, 255]).map((x) => x / 255), hi = (fn.m_ColorMax || [255, 255, 255]).map((x) => x / 255);
      for (let i = s; i < e; i++) setV(c, out, i, lerp3(lo, hi, drawVarying(c)));
    },
  },

  // VRF cross-check, UNSETTLED.
  C_INIT_RandomSequence: {
    evidence: 'VRF',
    init(fn, c, s, e, _k, st) {
      const lo = fn.m_nSequenceMin | 0, hi = fn.m_nSequenceMax | 0;
      const list = fn.m_WeightedList || [];
      for (let i = s; i < e; i++) {
        let seq = lo;
        if (list.length) {
          const total = list.reduce((a, w) => a + Math.max(0, +w.m_flRelativeWeight || 0), 0);
          let pick = fn.m_bLinear ? (st.cursor ??= 0) : total * drawVarying(c);
          for (const w of list) { if (!(w.m_flRelativeWeight > 0)) continue; pick -= w.m_flRelativeWeight; seq = w.m_nSequence | 0; if (pick < 0) break; }
          if (fn.m_bLinear) st.cursor = st.cursor + 1 >= Math.ceil(total) ? 0 : st.cursor + 1;
        } else if (fn.m_bShuffle || fn.m_bLinear) {
          const n = Math.max(hi - lo + 1, 1);
          if (!st.list || st.at >= st.list.length) {
            st.list = Array.from({ length: n }, (_, k) => lo + k);
            if (fn.m_bShuffle) for (let k = n - 1; k > 0; k--) { const j = Math.min(Math.floor(drawVarying(c) * (k + 1)), k); [st.list[k], st.list[j]] = [st.list[j], st.list[k]]; }
            st.at = 0;
          }
          seq = st.list[st.at++];
        } else if (hi > lo) seq = Math.min(lo + Math.floor(drawVarying(c) * (hi - lo + 1)), hi);
        setF(c, A.SEQUENCE, i, seq);
      }
    },
  },

  // RE §11 C_INIT_RingWave (0x1801251c0).
  C_INIT_RingWave: {
    evidence: 'RE',
    init(fn, c, s, e, _k, st) {
      let ppo = evalFloat(fn.m_flParticlesPerOrbit, c, -1);
      if (!fn.m_bEvenDistribution || ppo === -1) ppo = c.count; // active particle count (coll+0x74)
      const step = (2 * Math.PI) / Math.max(1, ppo);
      const cp = transformOf(c, fn.m_TransformInput);
      st.counter ??= 0;
      for (let i = s; i < e; i++) {
        if (st.counter >= 0xffffffff - (e - i)) st.counter = 0; // reset before it would overflow
        st.counter++; // incremented before use
        const R = evalFloat(fn.m_flInitialRadius, c, i, 'init');
        const th = evalFloat(fn.m_flThickness, c, i, 'init');
        // UNSETTLED: the draw order (thickness draws, then angle, then speed) is from the decompile only.
        const b = c.rnd.counter + c.rnd.offset;
        const u = [T(c, b) * 0.9999 + 0.0001, T(c, b + 1) * 0.9999 + 0.0001, T(c, b + 2) * 0.9999 + 0.0001];
        c.rnd.counter += 3;
        const ang = fn.m_bEvenDistribution ? st.counter * step : drawVarying(c) * 2 * Math.PI;
        const m = angleVectors(evalFloat(fn.m_flPitch, c, i, 'init'), evalFloat(fn.m_flYaw, c, i, 'init'), evalFloat(fn.m_flRoll, c, i, 'init'));
        let q = [R * Math.cos(ang), R * Math.sin(ang), 0];
        // AngleMatrix (0x18035c380): columns forward, left, up.
        q = add(add(mul(m.forward, q[0]), mul(m.left, q[1])), mul(m.up, q[2]));
        const z = 2 * u[0] - 1, phi = 2 * Math.PI * u[1], rr = th * Math.cbrt(u[2]), sz = Math.sqrt(Math.max(0, 1 - z * z));
        q = add(q, [rr * sz * Math.cos(phi), rr * sz * Math.sin(phi), rr * z]);
        const p = add(toWorld(cp, q), cp.position); // CP scale 1
        const dir = norm(sub(p, cp.position));
        const v0 = evalFloat(fn.m_flInitialSpeedMin, c, i, 'init'), v1 = evalFloat(fn.m_flInitialSpeedMax, c, i, 'init');
        const v = v0 + (v1 - v0) * drawVarying(c);
        const prev = sub(p, mul(dir, v * c.prevDt)); // scaled by the previous non-zero dt (coll+0x68)
        if (fn.m_bXYVelocityOnly) prev[2] = p[2];
        setV(c, A.POSITION, i, p);
        setV(c, A.PREV, i, prev);
      }
    },
  },

  // RE §11 C_INIT_CreateSequentialPathV2 (0x18014e4b0, step setup 0x18014ddb0).
  C_INIT_CreateSequentialPathV2: {
    evidence: 'RE',
    init(fn, c, s, e, _k, st) {
      const pp = fn.m_PathParams || {};
      if (fn.m_bCPPairs) report(c, 'C_INIT_CreateSequentialPathV2 m_bCPPairs not implemented (one segment)');
      const N = evalFloat(fn.m_flNumToAssign, c, -1);
      if (st.cachedN !== N) { st.cachedN = N; st.step = N > 1 ? 1 / (N - 1) : 0; st.t ??= 0; }
      const P = 1;
      const cpS = getCp(c, pp.m_nStartControlPointNumber | 0), cpE = getCp(c, pp.m_nEndControlPointNumber | 0);
      for (let i = s; i < e; i++) {
        const ct = c.attr[A.CREATION][i];
        const S = add(cpPositionAt(c, cpS, ct), pp.m_vStartPointOffset || [0, 0, 0]);
        const E = add(cpPositionAt(c, cpE, ct), pp.m_vEndOffset || [0, 0, 0]);
        let M;
        if ((pp.m_nMidControlPointNumber ?? -1) < 0) {
          M = add(S, mul(sub(E, S), pp.m_flMidPoint ?? 0.5));
          const bulge = +pp.m_flBulge || 0;
          if ((pp.m_nBulgeControl | 0) === 0) {
            // Per-axis bulge from T[c914 + 0..2], fixed per collection.
            M = add(M, [0, 1, 2].map((k) => (T(c, c.rnd.offset + k) * 2 - 1) * bulge));
          } else {
            const f = getCp(c, pp.m_nBulgeControl === 1 ? pp.m_nStartControlPointNumber | 0 : pp.m_nEndControlPointNumber | 0).forward;
            const d = len(sub(E, S));
            M = add(M, mul(norm(f), d * bulge * (1 - Math.abs(dot(norm(sub(E, S)), norm(f))))));
          }
        } else {
          // A given mid CP becomes 2*Mid - (S+E)/2 so the curve passes through it.
          M = sub(mul(cpPositionAt(c, getCp(c, pp.m_nMidControlPointNumber), ct), 2), mul(add(S, E), 0.5));
        }
        M = add(M, pp.m_vMidPointOffset || [0, 0, 0]);
        const u = st.t;
        let p = lerp3(lerp3(S, M, u), lerp3(M, E, u), u);
        const D = evalFloat(fn.m_fMaxDistance, c, i, 'init');
        const b = c.rnd.counter + c.rnd.offset;
        p = add(p, [0, 1, 2].map((k) => -D + 2 * D * T(c, b + k)));
        c.rnd.counter += 3;
        setV(c, A.POSITION, i, p);
        setV(c, A.PREV, i, p);
        if (fn.m_bSaveOffset) setV(c, A.HITBOX_OFFSET, i, [u, pp.m_nStartControlPointNumber | 0, pp.m_nEndControlPointNumber | 0]);
        // Advance, snap near the ends, then loop or bounce.
        const prevT = st.t;
        st.t += st.step;
        if (st.step > 1e-5) { if (Math.abs(st.t - P) < 1e-5) st.t = P; else if (Math.abs(st.t) < 1e-5) st.t = 0; }
        if (st.t < 0 || st.t > P) {
          const over = st.step <= 0 ? -st.t : st.t - P;
          if (fn.m_bLoop) st.t = prevT === P && (S[0] !== E[0] || S[1] !== E[1] || S[2] !== E[2]) ? 0 : over;
          else { st.t = st.step >= 0 ? P - over : over; st.step = -st.step; }
        }
      }
    },
  },
};
