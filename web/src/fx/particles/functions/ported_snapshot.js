// Ported from CS2's particles.dll (tools/particles/PORTING.md), md5 63babcbf3245e56855a777134323e74a ("63babcbf").
// The snapshot group: the class that writes a control point snapshot (C_OP_LightningSnapshotGenerator), the one that
// reads it into new particles (C_INIT_InitFromCPSnapshot) and the operator that aims the tesla children
// (C_OP_ConnectParentParticleToNearest). The snapshot store is snapshot.js. Constants: tools/particles/consts.py.
import { A, FLT_MAX, add, sub, mul, dot, cross, len, clamp, getCp, getV, setV, attrIndex, report, toWorld,
  setCpPosition, setCpOrientation, frameFromNormal, tableAt as T } from './common.js';
import { evalFloat } from '../inputs.js';
import { attrType, cpSnapshot, makeSnapshot, setCpSnapshot, snapshotStream } from './snapshot.js';

const ev = (inp, c) => evalFloat(inp, c, -1);
const cpIndex = (i) => clamp(i | 0, 0, 63);
// FUN_1800522b0: normalise; a zero vector stays zero (the callers test the returned length).
const norm0 = (v) => { const l = len(v); return l > 0 ? mul(v, 1 / l) : null; };

// The unit-ball draw FUN_180049160(coll, counter): u_k = T[c914 + counter + k] * 0.9999 + 0.0001 (DAT_1805341f8,
// DAT_18053414c), z = 2*u0 - 1, phi = u1 * 2pi (DAT_1805342c8), r = u2^(1/3) (DAT_1805341b0); (r*s*cos, r*s*sin,
// r*z) with s = sqrt(1 - z^2). It does not advance the counter. (ported_forces.js randomInBall is the same draw
// with c910 += 3 folded in.)
const ballAt = (c, counter) => {
  const b = c.rnd.offset + counter;
  const u0 = T(c, b) * 0.9999 + 0.0001, u1 = T(c, b + 1) * 0.9999 + 0.0001, u2 = T(c, b + 2) * 0.9999 + 0.0001;
  const z = 2 * u0 - 1, phi = u1 * 6.28318548, r = Math.pow(u2, 0.333333343);
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * s * Math.cos(phi), r * s * Math.sin(phi), r * z];
};
const lerpSigned = (off, t) => (off - -off) * t + -off; // (off - (off ^ sign)) * T + (off ^ sign), DAT_180534be0

// One lightning bolt: positions P with radius B, alpha-2 C (1 = a point the rope joins, 0 = a separator),
// texture coordinate D and recursion level L, as the five CUtlVectors of 0x18028c960.
function bolt(fn, c, S, E) {
  const segments = Math.min(8, Math.max(0, ev(fn.m_flSegments, c))); // [0, DAT_1805342d0 8]
  let offset = ev(fn.m_flOffset, c);
  const decay = ev(fn.m_flOffsetDecay, c);
  const split = Math.min(0.25, Math.max(0, ev(fn.m_flSplitRate, c))); // DAT_1805341ac
  const recSplit = Math.min(10, Math.max(0, ev(fn.m_flRecursionSplitScale, c))); // DAT_1805342d8
  const bDist = Math.min(100, Math.max(1e-4, ev(fn.m_flBranchDistanceScale, c))); // DAT_18053414c, DAT_18053432c
  const bOff = Math.min(100, Math.max(0, ev(fn.m_flBranchOffsetScale, c)));
  const uvOffset = ev(fn.m_flUVOffset, c), uvEnd = uvOffset + ev(fn.m_flUVScale, c);
  const twist = ev(fn.m_flBranchTwist, c);
  const endDir = fn.m_nBranchBehavior === 1 || fn.m_nBranchBehavior === 'PARTICLE_LIGHTNING_BRANCH_ENDPOINT_DIR';
  // FUN_18028b4a0: start, end and two separators at the end
  const P = [S, E, E, E], B = [ev(fn.m_flRadiusStart, c), ev(fn.m_flRadiusEnd, c), 0, 0], C = [1, 1, 0, 0];
  const D = [uvOffset, uvEnd, uvEnd, uvEnd], L = [1, 1, -1, -1];
  // FUN_18028c030: a branch from the new midpoint at i + 1, appended after a separator pair
  const branch = (i, off, mid) => {
    const depth = L[i + 1] + 1, b1 = B[i + 1], d1 = D[i + 1];
    const k = fn.m_bScaleBranchOffset ? depth * bOff : 1;
    const r = ballAt(c, c.rnd.counter);
    c.rnd.counter += 3;
    P.push(mid, mid, mid); B.push(0, 0, b1); C.push(0, 0, 1); D.push(d1, d1, d1); L.push(-1, -1, depth);
    // length: (|(P[i+1] - E) * 0.25| * 0.75 + |P[0] - P[1]| * 0.75) * 0.5 (DAT_1805341c4 0.75, DAT_1805341b8)
    const reach = (len(mul(sub(P[i + 1], E), 0.25)) * 0.75 + len(sub(P[0], P[1])) * 0.75) * 0.5;
    const dir = norm0(sub(P[i + 1], P[i])) || [0, 0, 0]; // FUN_180122c90 with the zero default
    const t = lerpSigned(off, T(c, c.rnd.offset + c.rnd.counter++));
    let p;
    if (!endDir) p = add(add(mul(dir, reach), mid), mul(r, twist * t * k));
    else {
      const toEnd = norm0(sub(E, mid)) || [0, 0, 0];
      p = add(add(mul(add(toEnd, mul(sub(dir, toEnd), twist)), reach), mid), mul(r, t * k));
    }
    const uv = (uvEnd - d1) * 0.5 + d1;
    P.push(p, p, p); B.push(0, 0, 0); C.push(1, 0, 0); D.push(uv, uv, uv); L.push(depth, -1, -1);
  };
  for (let iter = 0; iter < segments; iter++, offset *= decay) {
    for (let i = 0; i < P.length; i++) {
      const j = i + 1;
      if (P.length <= j) break;
      if (C[i] === 0 || C[j] === 0) continue;
      const off = fn.m_bScaleBranchDistance ? offset / (bDist * L[i]) : offset;
      const d = norm0(sub(P[j], P[i])) || [0, 0, 1];
      const n = norm0(cross(d, P[i])) || [0, 0, 0];
      const counter = c.rnd.counter;
      const r = ballAt(c, counter);
      c.rnd.counter += 4;
      const t = lerpSigned(off, T(c, c.rnd.offset + counter + 3)) / L[i];
      const mid = add(add(mul(sub(mul(r, off), mul(n, t)), 0.5), mul(n, t)), mul(add(P[j], P[i]), 0.5));
      P.splice(j, 0, mid); B.splice(j, 0, (B[i] + B[j]) * 0.5); C.splice(j, 0, 1);
      D.splice(j, 0, (D[i] + D[j]) * 0.5); L.splice(j, 0, L[i]);
      const k = recSplit !== 1 ? (1 - L[i] / segments) * recSplit : 1;
      if (T(c, c.rnd.offset + c.rnd.counter++) < split * k / L[i]) branch(i, off, mid);
      i++; // past the new midpoint
    }
  }
  return { P, B, C, D };
}

export const ported_snapshot = {
  // particles.dll 63babcbf: C_OP_LightningSnapshotGenerator (vtable 0x180519f18) pre-emission Operate slot 34
  // 0x18028c960; state slot 11 0x18028b240 / restart slot 21 0x18028b480: next time 0x800000 (FLT_MIN), pool -1.
  // When time > next: next = time + m_flRecalcRate, or FLT_MAX (DAT_1805343a4) for a negative rate; the bolt runs
  // m_flSegments subdivision passes from CP m_nCPStartPnt to m_nCPEndPnt: every joined pair gets the midpoint
  // + 0.5 * (ball * offset + t * n), n = normalize(cross(dir, P[i])), t = lerp(-offset, offset, T) / level, and with
  // probability m_flSplitRate * k / level a branch (0x18028c030); offset *= m_flOffsetDecay per pass. The pool
  // (m_flDedicatedPool, else the first bolt's count) is fixed on the first bolt; a shorter bolt is padded with
  // separators at the end point. The count is clamped to the collection's capacity (coll+0x7c) and the snapshot
  // (position, radius, alpha 2 = joined, scratch = texture coordinate) set on CP m_nCPSnapshot (0x180036770).
  C_OP_LightningSnapshotGenerator: {
    evidence: 'RE',
    pre(fn, c, _s, st) {
      if (st.next === undefined) { st.next = 1.17549435e-38; st.pool = -1; }
      if (!(c.time > st.next)) return;
      const rate = ev(fn.m_flRecalcRate, c);
      st.next = rate >= 0 ? c.time + rate : FLT_MAX;
      const S = getCp(c, cpIndex(fn.m_nCPStartPnt)).position.slice();
      const E = getCp(c, cpIndex(fn.m_nCPEndPnt)).position.slice();
      const { P, B, C, D } = bolt(fn, c, S, E);
      if (st.pool === -1) { const p = Math.trunc(ev(fn.m_flDedicatedPool, c)); st.pool = p > 0 ? p : P.length; }
      while (P.length < st.pool) { P.push(E); B.push(0); C.push(0); D.push(0); }
      const n = Math.min(P.length, c.capacity);
      const pos = new Float32Array(3 * n);
      for (let k = 0; k < n; k++) pos.set(P[k], 3 * k);
      setCpSnapshot(c, cpIndex(fn.m_nCPSnapshot), makeSnapshot(n, { [A.POSITION]: pos, [A.RADIUS]: B, [A.ALPHA2]: C, [A.SCRATCH]: D }));
    },
  },

  // particles.dll 63babcbf: C_INIT_InitFromCPSnapshot (vtable 0x1804eaf38) slot 34 0x18015bfd0, class init slot 6
  // 0x18015aed0 (CP clamped 0..63, local-space CP -1..63, read attribute = written one when -1), state slot 11
  // 0x18015af30 {copied, seed counter, index}. Nothing is written unless the CP's snapshot has particles and carries
  // the read attribute with the written attribute's type (0x18015b480). Per particle the snapshot index is the
  // running index (state, clamped to count - 1, +1 and wrapped), or with m_bReverse count - index - 1, with
  // m_nSnapShotIncrement != 1 the index steps by it, with m_bRandom count * T[c914 + (seed ? seed + n++ : c910++)],
  // with m_nManualSnapshotIndex (not literal -1, DAT_1805343cc) that per-particle value mod count. Vectors: written
  // to previous position they are a velocity (times prev dt, 1/30 when 0: DAT_180534180) and prev = pos - v;
  // writing position also writes previous position. m_nLocalSpaceCP != -1 transforms position / previous position
  // / normal (mask 0x200005) through that CP, without translation for previous position and normal (0x200004).
  // UNSETTLED: m_strSnapshotSubset (named subsets; no snapshot here carries any) and m_bLocalSpaceAngles (the
  // angle path 0x18035e810) are reported and skipped / read plain; the local CP is read at the current time.
  C_INIT_InitFromCPSnapshot: {
    evidence: 'RE',
    init(fn, c, s, e, _str, st) {
      const write = attrIndex(fn.m_nAttributeToWrite, 0);
      if (write < 0 || write === A.NONE || !c.attr[write]) return;
      let read = attrIndex(fn.m_nAttributeToRead, -1);
      if (read === -1) read = write;
      const type = attrType(write);
      const snap = cpSnapshot(c, cpIndex(fn.m_nControlPointNumber));
      const src = snapshotStream(snap, read, type);
      if (!src) return;
      if (fn.m_strSnapshotSubset) { report(c, 'C_INIT_InitFromCPSnapshot m_strSnapshotSubset not implemented (skipped)'); return; }
      if (fn.m_bLocalSpaceAngles && [4, 12, 20, 43].includes(write)) report(c, 'C_INIT_InitFromCPSnapshot m_bLocalSpaceAngles not implemented (read plain)');
      const count = snap.count;
      const localCp = clamp(fn.m_nLocalSpaceCP ?? 0, -1, 63);
      const local = localCp !== -1 && (write === 0 || write === 2 || write === 21) ? getCp(c, localCp) : null;
      const inc = Math.max(1, Math.trunc(ev(fn.m_nSnapShotIncrement, c)));
      const mi = fn.m_nManualSnapshotIndex;
      const manual = !!mi && !(mi.m_nType === 'PF_TYPE_LITERAL' && mi.m_flLiteralValue === -1);
      const per = fn.m_bReverse || fn.m_bRandom || inc !== 1 || manual;
      const seed = fn.m_nRandomSeed | 0;
      let idx = Math.min(st.idx | 0, count - 1);
      const dt = c.prevDt || 0.0333333351;
      for (let i = s; i < e; i++) {
        let j;
        if (manual) { const v = Math.trunc(evalFloat(mi, c, i, 'init')); j = (v < 1 ? 0 : v) % count; }
        else if (fn.m_bRandom) j = Math.trunc(count * T(c, c.rnd.offset + (seed === 0 ? c.rnd.counter++ : seed + (st.seeded = (st.seeded | 0) + 1) - 1)));
        else { j = fn.m_bReverse ? count - idx - 1 : idx; idx = ((per ? inc : 1) + idx) % count; }
        if (type !== 1) { c.attr[write][i] = src[j]; continue; }
        let v = [src[3 * j], src[3 * j + 1], src[3 * j + 2]];
        if (write === A.PREV) {
          v = mul(v, dt);
          if (local) v = toWorld(local, v);
          v = sub(getV(c, A.POSITION, i), v);
        } else if (local) v = write === A.NORMAL ? toWorld(local, v) : add(local.position, toWorld(local, v));
        setV(c, write, i, v);
        if (write === A.POSITION) setV(c, A.PREV, i, v);
      }
      st.copied = (st.copied | 0) + (e - s);
      st.idx = idx;
    },
  },

  // particles.dll 63babcbf: C_OP_ConnectParentParticleToNearest Operate slot 34 0x18026ba10 -> 0x180271e50 when
  // m_bUseRadius is off. For every parent particle u (coll+0x28, +0x74 count) and this collection's u-th child
  // (coll+0x20, next +0x30; stops when the children run out): the nearest particle k of this collection to the parent
  // particle (squared distance, strict <, from FLT_MAX); child CP m_nFirstControlPoint = the parent particle's
  // position, CP m_nSecondControlPoint = particle k's position (0x1800364e0); when they differ the first CP faces
  // from the parent particle to k, and when k moved (pos - prev) the second CP faces along that motion
  // (FUN_1800522b0, VectorVectors 0x18035ed10, 0x18003ec90). UNSETTLED: with no particle here the SIMD search
  // returns its initial lanes; the CPs are left unset. The m_bUseRadius path (0x18026ba10 body) is not ported.
  C_OP_ConnectParentParticleToNearest: {
    evidence: 'RE',
    op(fn, c) {
      if (fn.m_bUseRadius) report(c, 'C_OP_ConnectParentParticleToNearest m_bUseRadius not implemented (nearest by centre)');
      const par = c.parent;
      if (!par || !par.count || !c.count) return;
      const first = fn.m_nFirstControlPoint | 0, second = fn.m_nSecondControlPoint | 0;
      for (let u = 0; u < par.count; u++) {
        const child = c.children[u];
        if (!child) return;
        const p = getV(par, A.POSITION, u);
        let best = FLT_MAX, k = -1;
        for (let i = 0; i < c.count; i++) {
          const d = sub(getV(c, A.POSITION, i), p), d2 = dot(d, d);
          if (d2 < best) { best = d2; k = i; }
        }
        if (k < 0) continue;
        const q = getV(c, A.POSITION, k);
        setCpPosition(child, first, p);
        setCpPosition(child, second, q);
        const a = norm0(sub(q, p));
        if (a) { const [f, l, up] = frameFromNormal(a); setCpOrientation(child, first, f, l, up); }
        const b = norm0(sub(q, getV(c, A.PREV, k)));
        if (b) { const [f, l, up] = frameFromNormal(b); setCpOrientation(child, second, f, l, up); }
      }
    },
  },
};
