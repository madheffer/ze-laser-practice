// Ported from CS2's particles.dll (tools/particles/PORTING.md): each entry cites the build and the address it was read
// from. The children group: emitters that keep a count, operators that write child control points, enable child
// collections and copy from the parent collection's particles. Every address is particles.dll md5 63babcbf3245e5…
import {
  A, FLT_EPSILON, INT_ATTRS, VECTOR_ATTRS, add, angleVectors, attrIndex, clamp, cpPositionAt, cross, dot, getCp, getF,
  getInitF, getV, kill, len, lerp3, mul, norm, report, setCpField, setCpOrientation, setCpPosition, setF, setV, sub,
  toWorld, transformOf, vec3, isZero, frameFromNormal,
} from './common.js';
import { evalFloat, evalVec } from '../inputs.js';

const FLT_MAX = 3.4028234663852886e38;
const DEG = 57.2957764; // DAT_180534314
export const T = (c, k) => c.table[k & 0xfff]; // the random table, DAT_180598f60
export const groupOf = (k) => k.def?.m_nGroupID | 0; // child definition +0x260 m_nGroupID

// One world trace through the stage's callback (as preemission.js): opts.trace(from, dir, length) -> { hit,
// position } | null; the result is the hit fraction, 1 on a miss or without a callback.
export const traceFraction = (c, from, to) => {
  const d = sub(to, from), L = len(d);
  const r = c.sys.opts.trace && L > 0 ? c.sys.opts.trace(from.slice(), mul(d, 1 / L), L) : null;
  return r && r.hit ? len(sub(vec3(r.position), from)) / L : 1;
};

// The 0..5 ParticleSetMethod_t value written through the vector streams of DistanceToTransform /
// DistanceBetweenTransforms (0x1801e5010, 0x1801e1c10): init stream for 1/2, current for the rest.
export const setMethod = (m, v, init, cur, dt) => {
  switch (m) {
    case 'PARTICLE_SET_SCALE_INITIAL_VALUE': return v * init;
    case 'PARTICLE_SET_ADD_TO_INITIAL_VALUE': return v + init;
    case 'PARTICLE_SET_RAMP_CURRENT_VALUE': return v * dt + cur;
    case 'PARTICLE_SET_SCALE_CURRENT_VALUE': return v * cur;
    case 'PARTICLE_SET_ADD_TO_CURRENT_VALUE': return v + cur;
    default: return v;
  }
};

// CParticleCollection::StopEmission (0x18004c560) as (coll, infiniteOnly=0, removeAll, wake=1, playEndcap):
// marks the collection stopped (+0x8c1 |= 2), tells each emitter (their slot 36), kills every particle when
// removeAll, and recurses into the children with the same removeAll / endcap. The endcap start (+0x5c) is the
// current time. UNSETTLED: the +0x8c1 bits 0x01/0x10 (force removeAll, no endcap) and 0x20 (endcap children
// restart at time 0) are not modelled.
function stopCollection(c, removeAll, playEndcap) {
  c.emissionStopped = true;
  for (const fn of c.def.m_Emitters || []) {
    const st = c.state.get(fn);
    if (fn._class === 'C_OP_MaintainEmitter' && st) { st.acc = 0; if (fn.m_bFinalEmitOnStop) st.finalEmit = true; else st.active = false; }
  }
  if (removeAll) c.count = 0;
  if (playEndcap && !c.endcap.active) c.endcap = { active: true, start: c.time };
  for (const k of c.children) stopCollection(k, removeAll, playEndcap);
}

// A child collection switched off by C_OP_EnableChildrenFromParentParticleCount: the game sets its time to
// -FLT_MAX (+0x50, +0x40..0x4c) and flag 0x40 (0x1802857e0); on enable the time goes back to 0. In the runtime the
// flag is `disabled` (system.js skips disabled children: see the report) and enabling restarts the clock and the
// emitters at 0. UNSETTLED: whether the game also re-arms the emitter contexts (taken as yes, as a fresh start).
const disable = (k) => { k.disabled = true; };
function enable(k) {
  k.disabled = false;
  k.time = 0; k.startTime = 0; k.emitterOrigin = 0;
  k.emissionStopped = false;
  k.endcap = { active: false, start: 0 };
  for (const fn of [...(k.def.m_Emitters || []), ...(k.def.m_PreEmissionOperators || [])]) k.state.delete(fn);
}
// CParticleCollection "finished" (0x18004c400): no live particles, no emitter still going (each emitter's
// slot 37 via 0x18004c340), every child finished. UNSETTLED: flag bits 0x8bc & 0x41 and +0x91c read as "has
// particles"; the emitter test reads the runtime's own emitter states.
const emittersDone = (k) => k.emissionStopped || (k.def.m_Emitters || []).every((fn) => {
  const st = k.state.get(fn);
  if (!st) return false;
  return fn._class === 'C_OP_MaintainEmitter' ? st.active === false : !!st.done;
});
const finished = (k) => k.count === 0 && emittersDone(k) && k.children.every((g) => g.disabled || finished(g));

// Copy one attribute value from a parent particle, as InheritFromParentParticles' Init (0x180152470): vectors
// scaled (colour / glow clamped to [0,1], mask 0xc100c0), int streams raw, floats scaled (alpha clamped).
export const ALPHA_MASK = new Set([A.ALPHA, A.ALPHA2]); // 0x10080

// CPathParameters at time t (0x18004d170): start / end CP positions (interpolated to t inside the frame) plus their
// offsets; the mid point either the given mid CP (as 2*Mid - (S+E)/2) or the lerp at m_flMidPoint with the bulge
// (random per axis from T[c914 + 0..2], or along the start / end CP's forward scaled by 1 - |dir.f|), plus the
// mid offset. Same maths as initializers.js C_INIT_CreateSequentialPathV2.
const pathAt = (c, pp, t) => {
  const at = (cp) => cpPositionAt(c, getCp(c, cp | 0), t);
  const S = add(at(pp.m_nStartControlPointNumber), vec3(pp.m_vStartPointOffset));
  const E = add(at(pp.m_nEndControlPointNumber), vec3(pp.m_vEndOffset));
  let M;
  if ((pp.m_nMidControlPointNumber ?? -1) < 0) {
    M = lerp3(S, E, pp.m_flMidPoint ?? 0.5);
    const b = +pp.m_flBulge || 0;
    const ctl = pp.m_nBulgeControl | 0; // 0 random, 2 the end CP's forward, anything else the start CP's
    if (ctl === 0) M = add(M, [0, 1, 2].map((k) => (2 * T(c, c.rnd.offset + k) - 1) * b));
    else {
      const f = getCp(c, ctl === 2 ? pp.m_nEndControlPointNumber | 0 : pp.m_nStartControlPointNumber | 0).forward;
      const d = len(sub(E, S)), lf = len(f);
      const k = d > FLT_EPSILON ? 1 - Math.abs(dot(mul(sub(E, S), 1 / d), f)) : 0; // DAT_180534144 guard
      if (lf > FLT_EPSILON) M = add(M, mul(f, (d * b * k) / lf));
    }
  } else {
    M = sub(mul(at(pp.m_nMidControlPointNumber), 2), mul(add(S, E), 0.5));
  }
  return [S, add(M, vec3(pp.m_vMidPointOffset)), E];
};

export const ported_children = {
  // C_OP_MaintainEmitter, Emit slot 34 0x18010aeb0, count 0x180109d10, start 0x1801095c0, stop 0x1801095a0.
  // Target = max(0, trunc(trunc(m_nParticlesToMaintain) * m_flScale)); when the collection holds fewer it emits
  // min(target - count, room), or with m_flEmissionRate > 0 the rate * dt share of it through a float carry
  // (+8). Creation times run from max(prevTime, start + m_flStartTime) in steps of (now - that) / n (0 when
  // m_bEmitInstantaneously and no rate), each clamped to now. It stops once now - dt > duration + m_flStartTime
  // (a nonzero duration). UNSETTLED: m_nSnapshotControlPoint (a snapshot's count replaces the target; no
  // snapshots here); +0x54 read as now - dt; m_bFinalEmitOnStop needs the emitter to run once after a stop, which
  // system.js does not do (it skips the emitters of a stopped collection).
  C_OP_MaintainEmitter: {
    evidence: 'RE',
    emit(fn, c, _s, st) {
      if (st.active === undefined) { st.active = true; st.acc = 0; st.start = c.emitterOrigin ?? c.startTime ?? 0; }
      if (!st.active) return null;
      if (st.finalEmit) { st.finalEmit = false; st.active = false; }
      const now = c.time, startAbs = st.start + (+fn.m_flStartTime || 0);
      if (!(startAbs <= now)) return null;
      if (fn.m_nSnapshotControlPoint >= 0) report(c, 'C_OP_MaintainEmitter snapshot count not implemented (no snapshots)');
      let target = Math.trunc(evalFloat(fn.m_nParticlesToMaintain, c, -1));
      const dur = evalFloat(fn.m_flEmissionDuration, c, -1);
      target = Math.max(0, Math.trunc(target * evalFloat(fn.m_flScale, c, -1)));
      if (!(c.count < target && target > 0)) return null;
      if (dur !== 0 && !(now - c.dt <= dur + (+fn.m_flStartTime || 0))) return null;
      const room = c.capacity - c.count;
      let n = target - c.count;
      const rate = +fn.m_flEmissionRate || 0;
      if (rate > 0) {
        const f = Math.max(0, Math.min(rate * c.dt, n));
        n = Math.trunc(f + st.acc);
        st.acc = f + st.acc - n;
      }
      n = Math.max(0, Math.min(n, room));
      if (!n) return null;
      const t0 = Math.max(now - c.dt, startAbs);
      const step = !fn.m_bEmitInstantaneously || rate > 0 ? (now - t0) / n : 0;
      const ages = [];
      for (let k = 0; k < n; k++) ages.push(now - Math.min(t0 + k * step, now));
      return ages;
    },
  },

  // C_OP_SetChildControlPoints, Operate 0x1801db2e0, init 0x1801db1c0 (count clamped to 64 - first CP).
  // For every child whose definition's m_nGroupID matches, CP (firstCP + j) = position of particle
  // trunc(m_nFirstSourcePoint) + j (reversed: count - 1 - that, floored at 0), j < min(count - first, num, 64 -
  // firstCP). With m_bSetOrientation: VELOCITY = VectorVectors(normalize(pos - prev)), NORMAL = from the normal
  // stream, ROLL = AngleMatrix(pitch, yaw, roll in degrees, x57.2957764); a zero vector leaves the frame.
  C_OP_SetChildControlPoints: {
    evidence: 'RE',
    op(fn, c) {
      const first = Math.trunc(evalFloat(fn.m_nFirstSourcePoint, c, -1));
      const fcp = clamp(fn.m_nFirstControlPoint | 0, 0, 63);
      const num = Math.min(fn.m_nNumControlPoints | 0, 64 - (fn.m_nFirstControlPoint | 0));
      const n = Math.min(c.count - first, num, 64 - fcp);
      if (n <= 0) return;
      for (const k of c.children) {
        if (groupOf(k) !== (fn.m_nChildGroupID | 0)) continue;
        for (let j = 0; j < n; j++) {
          let p = first + j;
          if (fn.m_bReverse) p = Math.max(0, c.count - p - 1);
          if (p < 0 || p >= c.capacity) continue;
          const pos = getV(c, A.POSITION, p);
          setCpPosition(k, fcp + j, pos);
          if (!fn.m_bSetOrientation) continue;
          const o = fn.m_nOrientation;
          if (o === 'PARTICLE_ORIENTATION_VELOCITY' || o === 'PARTICLE_ORIENTATION_NORMAL') {
            const v = o === 'PARTICLE_ORIENTATION_VELOCITY' ? sub(pos, getV(c, A.PREV, p)) : getV(c, A.NORMAL, p);
            if (isZero(v)) continue;
            const [f, l, u] = frameFromNormal(norm(v));
            setCpOrientation(k, fcp + j, f, l, u);
          } else if (o === 'PARTICLE_ORIENTATION_ROTATION') {
            const a = angleVectors(getF(c, A.PITCH, p) * DEG, getF(c, A.YAW, p) * DEG, getF(c, A.ROLL, p) * DEG);
            setCpOrientation(k, fcp + j, a.forward, a.left, a.up);
          }
        }
      }
    },
  },

  // C_OP_MaintainSequentialPath, Operate 0x1801f74c0, context 0x1801f7380, init 0x1801f7430 (tolerance squared),
  // path 0x18004d170. Skips the frame while both end CPs moved less than m_flTolerance from the last run. Each
  // particle in order takes the next path step u = idx * 1/(N - 1) (N = particle count with m_bUseParticleCount,
  // else m_flNumToAssign; a literal N keeps idx across frames, otherwise it restarts at 0), on the quadratic
  // S -> M -> E; out of range it loops to 0 or bounces (direction flips, idx clamped to [1, N - 1]). Position and
  // previous position are pulled to the path point P: P + d/|d| * min(|d|, m_fMaxDistance) * (1 - cohesion), d =
  // p - P (rsqrt with +FLT_EPSILON and one Newton step; exact here). The step is stored as a float (movss
  // [rdi+4] at 0x1801f80f1).
  C_OP_MaintainSequentialPath: {
    evidence: 'RE',
    op(fn, c, _s, st) {
      const pp = fn.m_PathParams || {};
      const tol = (+fn.m_flTolerance || 0) ** 2;
      if (!st.init) {
        st.init = true; st.idx = 0; st.dir = 1;
        const lit = fn.m_flNumToAssign?.m_nType === 'PF_TYPE_LITERAL' ? +fn.m_flNumToAssign.m_flLiteralValue : 0;
        st.step = lit > 1 ? 1 / (lit - 1) : 0;
        st.s = [FLT_MAX, FLT_MAX, FLT_MAX]; st.e = [FLT_MAX, FLT_MAX, FLT_MAX];
      }
      if (tol > 0) {
        const s = getCp(c, clamp(pp.m_nStartControlPointNumber | 0, 0, 63)).position;
        const e = getCp(c, clamp(pp.m_nEndControlPointNumber | 0, 0, 63)).position;
        const d2 = (a, b) => dot(sub(a, b), sub(a, b));
        if (d2(s, st.s) < tol && d2(e, st.e) < tol) return;
        st.s = s.slice(); st.e = e.slice();
      }
      const maxD = evalFloat(fn.m_fMaxDistance, c, -1);
      const keep = 1 - evalFloat(fn.m_flCohesionStrength, c, -1);
      let N = evalFloat(fn.m_flNumToAssign, c, -1);
      if (fn.m_bUseParticleCount || fn.m_flNumToAssign?.m_nType !== 'PF_TYPE_LITERAL') {
        if (fn.m_bUseParticleCount) N = c.count;
        st.step = N > 1 ? 1 / (N - 1) : 0;
        st.idx = 0;
      }
      const [S, M, E] = pathAt(c, pp, c.time);
      const pull = (p, P) => {
        const d = sub(p, P), l = len(d);
        const r = 1 / Math.sqrt(dot(d, d) + FLT_EPSILON);
        return add(P, mul(d, r * Math.min(l, maxD) * keep));
      };
      for (let i = 0; i < c.count; i++) {
        if (st.idx >= N || st.idx < 0) {
          if (!fn.m_bLoop) { st.dir = -st.dir; st.idx = Math.max(1, Math.min(st.idx, Math.trunc(N) - 1)); } else st.idx = 0;
        }
        const u = st.idx * st.step;
        const P = lerp3(lerp3(S, M, u), lerp3(M, E, u), u);
        setV(c, A.POSITION, i, pull(getV(c, A.POSITION, i), P));
        setV(c, A.PREV, i, pull(getV(c, A.PREV, i), P));
        st.idx += st.dir;
      }
    },
  },

  // C_OP_DistanceToTransform, Operate 0x1801e5010. Works on SQUARED distances: d2 = |(p - T) * m_vecComponentScale|^2,
  // inMin2 / inMax2 = the inputs squared; with m_bActiveRange only particles with inMin2 <= d2 <= inMax2 change.
  // m_bLOS traces from T to the particle (or, past m_flMaxTraceLength (compared with d2), to normalize(p) *
  // maxTrace + T: the code normalises the particle POSITION, not p - T); a blocked trace scales d2 by fraction *
  // m_flLOSScale. t = clamp((d2 - inMin2) / (inMax2 - inMin2 or 1), 0, 1), v = lerp(outMin, outMax, t) (outputs
  // clamped to [0,1] for alpha, mask 0x10080), then the set method, then cur + strength * (v - cur); m_bAdditive
  // writes 2*cur + strength*(v - cur) as the code does.
  C_OP_DistanceToTransform: {
    evidence: 'RE',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nFieldOutput, A.RADIUS);
      if (VECTOR_ATTRS.has(out) || !c.attr[out]) { report(c, `C_OP_DistanceToTransform output ${out} is not a scalar stream`); return; }
      const Tp = transformOf(c, fn.m_TransformStart).position;
      const maxT = +fn.m_flMaxTraceLength;
      for (let i = 0; i < c.count; i++) {
        let o0 = evalFloat(fn.m_flOutputMin, c, i), o1 = evalFloat(fn.m_flOutputMax, c, i);
        if (ALPHA_MASK.has(out)) { o0 = clamp(o0, 0, 1); o1 = clamp(o1, 0, 1); }
        const a = evalFloat(fn.m_flInputMin, c, i) ** 2, b = evalFloat(fn.m_flInputMax, c, i) ** 2;
        const sc = evalVec(fn.m_vecComponentScale, c, i);
        const p = getV(c, A.POSITION, i);
        const q = sub(p, Tp);
        let d2 = (q[0] * sc[0]) ** 2 + (q[1] * sc[1]) ** 2 + (q[2] * sc[2]) ** 2;
        if (fn.m_bActiveRange && !(d2 <= b && a <= d2)) continue;
        if (fn.m_bLOS) {
          const end = maxT !== -1 && maxT < d2 ? add(mul(norm(p), maxT), Tp) : p;
          const fr = traceFraction(c, Tp, end);
          if (fr !== 1) d2 *= fr * fn.m_flLOSScale;
        }
        const t = clamp((d2 - a) / (b === a ? 1 : b - a), 0, 1);
        const cur = c.attr[out][i];
        const v = setMethod(fn.m_nSetMethod, o0 + (o1 - o0) * t, getInitF(c, out, i), cur, c.dt);
        c.attr[out][i] = fn.m_bAdditive ? (v - cur) * s + cur + cur : cur + s * (v - cur);
      }
    },
  },

  // C_OP_SetCPtoVector, Operate 0x1801fb6d0: every particle's vector field = CP m_nCPInput's position interpolated
  // at f = (dt - (now - now)) / dt, i.e. the current position (prev + (pos - prev) * 1).
  C_OP_SetCPtoVector: {
    evidence: 'RE',
    op(fn, c) {
      const out = attrIndex(fn.m_nFieldOutput, A.NORMAL);
      if (!VECTOR_ATTRS.has(out)) { report(c, `C_OP_SetCPtoVector output ${out} is not a vector stream`); return; }
      const v = cpPositionAt(c, getCp(c, fn.m_nCPInput | 0), c.time);
      for (let i = 0; i < c.count; i++) setV(c, out, i, v);
    },
  },

  // C_OP_SetControlPointPositions (pre-emission), Operate 0x18027d670. Without m_bUseWorldLocation each of CP1..4
  // = head CP transform (columns forward, left, up, position; VectorTransform 0x18036ac60) applied to its
  // m_vecCPnPos; m_bOrient copies the head's forward / left / up to all four. With world location the offsets are
  // the positions, unrotated and without orientation. m_bSetOnce runs once (state byte).
  C_OP_SetControlPointPositions: {
    evidence: 'RE',
    pre(fn, c, _s, st) {
      if (fn.m_bSetOnce) { if (st.once) return; st.once = true; }
      const cps = [[fn.m_nCP1, fn.m_vecCP1Pos], [fn.m_nCP2, fn.m_vecCP2Pos], [fn.m_nCP3, fn.m_vecCP3Pos], [fn.m_nCP4, fn.m_vecCP4Pos]];
      if (fn.m_bUseWorldLocation) { for (const [cp, v] of cps) setCpPosition(c, cp | 0, vec3(v)); return; }
      const head = getCp(c, fn.m_nHeadLocation | 0);
      for (const [cp, v] of cps) setCpPosition(c, cp | 0, add(head.position, toWorld(head, vec3(v))));
      if (fn.m_bOrient) for (const [cp] of cps) setCpOrientation(c, cp | 0, head.forward, head.left, head.up);
    },
  },

  // C_OP_StopAfterCPDuration (pre-emission), Operate 0x180282260: once the collection is not already stopped
  // (+0x8c1 & 2), when now > m_flDuration (a CP component by default) StopEmission(removeAll = m_bDestroyImmediately,
  // endcap = m_bPlayEndCap) on this collection and its children (0x18004c560).
  C_OP_StopAfterCPDuration: {
    evidence: 'RE',
    pre(fn, c) {
      if (c.emissionStopped) return;
      const d = evalFloat(fn.m_flDuration, c, -1);
      if (d <= c.time && c.time !== d) stopCollection(c, !!fn.m_bDestroyImmediately, !!fn.m_bPlayEndCap);
    },
  },

  // C_OP_EnableChildrenFromParentParticleCount (pre-emission), Operate 0x180285850, context 0x1802857e0. At
  // creation every child of m_nChildGroupID is disabled, and on the first run those from child index m_nFirstChild
  // on. Each run: target = min(count - firstChild, number of children, trunc(m_nNumChildrenToEnable) when >= 0);
  // when nonzero, walking the group's children (group index g): a running child that has finished is disabled
  // again; with m_bDisableChildren a running child outside [firstChild, target) is stopped (m_bDestroyImmediately
  // kills and disables it, m_bPlayEndcapOnStop plays its endcap) and the enabled count drops; then, from g >=
  // firstChild while some remain and enabled < target, a disabled child is enabled (time 0).
  C_OP_EnableChildrenFromParentParticleCount: {
    evidence: 'RE',
    pre(fn, c, _s, st) {
      const gid = fn.m_nChildGroupID | 0, fc = fn.m_nFirstChild | 0;
      const kids = c.children;
      if (!st.ctx) { st.ctx = true; st.enabled = 0; for (const k of kids) if (groupOf(k) === gid) disable(k); }
      if (!st.first) { st.first = true; kids.forEach((k, j) => { if (fc <= j && groupOf(k) === gid) disable(k); }); }
      const n = Math.trunc(evalFloat(fn.m_nNumChildrenToEnable, c, -1));
      let target = Math.min(c.count - fc, kids.length);
      if (n >= 0 && n < target) target = n;
      if (target === 0) return;
      let left = target, g = 0;
      for (const k of kids) {
        if (groupOf(k) !== gid) continue;
        const running = () => !k.disabled && k.time > 0;
        if (!k.disabled && finished(k)) disable(k);
        if (fn.m_bDisableChildren && (g < fc || g >= target) && running() && (fn.m_bDestroyImmediately || !k.emissionStopped)) {
          stopCollection(k, !!fn.m_bDestroyImmediately, !!fn.m_bPlayEndcapOnStop);
          if (fn.m_bDestroyImmediately) disable(k);
          st.enabled--;
        }
        if (fc <= g && left !== 0 && st.enabled < target && k.disabled) { enable(k); left--; st.enabled++; }
        g++;
      }
    },
  },

};
