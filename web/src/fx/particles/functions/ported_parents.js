// Ported from CS2's particles.dll (tools/particles/PORTING.md), split from ported_children.js: particles created from or
// copying the parent collection's particles, per-child control points, CP-to-CP distances and model volumes. Every
// address is particles.dll md5 63babcbf3245e56855a777134323e74a.
import { A, INT_ATTRS, VECTOR_ATTRS, add, attrIndex, clamp, cpPositionAt, getCp, getInitF, getV, kill, len, lerp3,
  mul, norm, report, setCpField, setCpOrientation, setCpPosition, setF, setV, sub, toWorld, transformOf, vec3,
  isZero, frameFromNormal } from './common.js';
import { evalFloat, evalVec } from '../inputs.js';
import { T, groupOf, traceFraction, setMethod, ALPHA_MASK } from './ported_children.js';

// Parent links. CreateFromParentParticles / InheritFromParentParticles write attribute 46 (the parent particle's
// ID) and attribute 33 (its index) when m_nBehaviorVersion > 8; InheritFromParentParticlesV2 reads them, -1 =
// unassigned, INT_MIN = the parent particle is gone. The runtime keeps neither stream, so the link lives in a map
// keyed by the child's particle ID (which survives compaction), and the parent's current index is looked up from
// its ID each frame: the engine-side remap. UNSETTLED: where the engine remaps / marks INT_MIN.
const INT_MIN = -0x80000000;

const links = (c) => (c.parentLinks ||= new Map());

const setLink = (c, i, idx, pid) => {
  if (c.attr[33] && c.attr[46]) { c.attr[33][i] = idx; c.attr[46][i] = pid; return; }
  links(c).set(c.attr[A.ID][i], { idx, pid });
};

const getLink = (c, i) => {
  if (c.attr[33] && c.attr[46]) return { idx: c.attr[33][i], pid: c.attr[46][i] };
  const l = links(c).get(c.attr[A.ID][i]);
  if (!l) return { idx: -1, pid: -1 };
  if (l.pid >= 0 && c.parent) {
    const at = parentIndexOf(c.parent).get(l.pid);
    if (at === undefined) l.pid = INT_MIN; else l.idx = at;
  }
  return l;
};

const pruneLinks = (c) => {
  const m = c.parentLinks;
  if (!m || m.size <= 2 * c.count + 64) return;
  const live = new Set(Array.from(c.attr[A.ID].subarray(0, c.count)));
  for (const k of m.keys()) if (!live.has(k)) m.delete(k);
};

const writeLinks = (c) => (c.def.m_nBehaviorVersion | 0) > 8;

const COLOUR_MASK = new Set([A.COLOR, A.GLOW_RGB]); // 0xc100c0 (6, 7, 16, 22, 23) on the vector path

const BBOX = ['BBOX_VOLUME', 'BBOX_DIMENSIONS', 'BBOX_MINS_MAXS', 'BBOX_RADIUS', 'BBOX_SURFACE_AREA'];

const parentIndexOf = (p) => {
  if (p.idIndexAt !== p.time || p.idIndexCount !== p.count) {
    p.idIndex = new Map();
    for (let j = 0; j < p.count; j++) p.idIndex.set(p.attr[A.ID][j], j);
    p.idIndexAt = p.time; p.idIndexCount = p.count;
  }
  return p.idIndex;
};

export const ported_parents = {
  // C_OP_InheritFromParentParticlesV2, Operate 0x1801f24f0, copy 0x1801f20e0. No parent particles: with
  // MISSING_PARENT_KILL every particle dies. Else the walk index starts at 0 (m_bReverse: last) and per particle
  // (random: trunc((last + 1) * T[c914 + c910++]), else wrapped back when out of [0, last]) gives an unlinked
  // particle its parent; a particle whose parent is gone follows m_nMissingParentBehavior (KILL, FIND_NEW = random
  // parent, SAME_INDEX = clamped old index, DO_NOTHING). The copy: field = scale * parent value (lerped toward the
  // next / previous parent by the sub-sample fraction), then cur + interpolation * (v - cur) (clamped [0,1] on
  // scalars; alpha clamped), colour clamped [0,1]; int streams copied raw. The walk advances by trunc(+-increment),
  // or with m_bSubSample and increment < 1 by one whenever the accumulated fraction passes 1.
  C_OP_InheritFromParentParticlesV2: {
    evidence: 'RE',
    op(fn, c) {
      const p = c.parent;
      if (!p) return;
      const out = attrIndex(fn.m_nFieldOutput, A.COLOR);
      const mb = fn.m_nMissingParentBehavior ?? 'MISSING_PARENT_KILL';
      if (p.count === 0) {
        if (mb === 'MISSING_PARENT_KILL') for (let i = 0; i < c.count; i++) kill(c, i);
        return;
      }
      // Field 33 (the parent index itself, an int stream the runtime does not keep) is common: the copy is then
      // skipped, and the links and the missing-parent rule (the point of such an entry) still run.
      const has = !!(c.attr[out] && p.attr[out]);
      pruneLinks(c);
      const last = Math.max(0, p.count - 1), rev = !!fn.m_bReverse;
      let idx = rev ? p.count - 1 : 0, frac = 0;
      const vec = VECTOR_ATTRS.has(out), intAttr = INT_ATTRS.has(out);
      const copy = (i, pi, scale, interp) => {
        if (!has) return;
        const q = frac > 0 ? (rev ? Math.max(0, pi - 1) : Math.min(pi + 1, p.count - 1)) : pi;
        if (intAttr) { c.attr[out][i] = p.attr[out][pi]; return; }
        if (vec) {
          const cl = (v) => (COLOUR_MASK.has(out) ? v.map((x) => clamp(x, 0, 1)) : v);
          let v = cl(mul(getV(p, out, pi), scale));
          if (frac > 0) v = lerp3(v, cl(mul(getV(p, out, q), scale)), frac);
          const cur = getV(c, out, i);
          setV(c, out, i, add(cur, mul(sub(v, cur), interp)));
          return;
        }
        let v = scale * p.attr[out][pi];
        if (frac > 0) v += (scale * p.attr[out][q] - v) * clamp(frac, 0, 1);
        const cur = c.attr[out][i];
        let o = cur + clamp(interp, 0, 1) * (v - cur);
        if (ALPHA_MASK.has(out)) o = clamp(o, 0, 1);
        c.attr[out][i] = o;
      };
      for (let i = 0; i < c.count; i++) {
        if (!fn.m_bRandomDistribution) { if (last < idx || idx < 0) idx = rev ? p.count - 1 : 0; }
        else idx = Math.trunc((last + 1) * T(c, c.rnd.offset + c.rnd.counter++));
        const inc = evalFloat(fn.m_nIncrement, c, i);
        const sub1 = !!fn.m_bSubSample && inc < 1;
        let l = getLink(c, i);
        if (l.pid < 0 && l.pid !== INT_MIN && l.idx < 0) { setLink(c, i, idx, p.attr[A.ID][idx]); l = { idx, pid: p.attr[A.ID][idx] }; }
        const scale = evalFloat(fn.m_flScale, c, i), interp = evalFloat(fn.m_flInterpolation, c, i);
        if (l.pid === INT_MIN) {
          if (mb === 'MISSING_PARENT_KILL') kill(c, i);
          else if (mb === 'MISSING_PARENT_FIND_NEW') {
            const r = Math.trunc(p.count * T(c, c.rnd.offset + c.rnd.counter++));
            setLink(c, i, r, p.attr[A.ID][r]);
            copy(i, r, scale, interp);
          } else if (mb === 'MISSING_PARENT_SAME_INDEX') {
            const r = l.idx < 0 ? 0 : Math.min(l.idx, p.count - 1);
            setLink(c, i, r, p.attr[A.ID][r]);
            copy(i, r, scale, interp);
          }
        } else copy(i, clamp(l.idx, 0, p.count - 1), scale, interp);
        if (sub1) {
          frac += inc;
          if (1 <= frac) { frac -= Math.floor(frac); idx += rev ? -1 : 1; }
        } else idx += Math.trunc((rev ? -1 : 1) * inc);
      }
    },
  },

  // C_OP_SetPerChildControlPoint, Operate 0x1801dcca0, orientation-field helper 0x180122c90 (normalise, (0,0,1) if
  // zero). n = min(children, count - first, num (particle count with m_bNumBasedOnParticleCount)); each child of
  // the group, while n lasts, gets CP m_nFirstControlPoint = position of particle p (p from trunc(first source),
  // stepping by sign(inc) * (|inc| % count), wrapped only below 0). Without m_bSetOrientation a set
  // m_nOrientationField gives the frame VectorVectors(normalize(field)); with it the velocity direction does
  // (zero velocity: frame untouched).
  C_OP_SetPerChildControlPoint: {
    evidence: 'RE',
    op(fn, c) {
      const num = fn.m_bNumBasedOnParticleCount ? c.count : fn.m_nNumControlPoints | 0;
      let p = Math.trunc(evalFloat(fn.m_nFirstSourcePoint, c, -1));
      const inc = Math.trunc(evalFloat(fn.m_nParticleIncrement, c, -1));
      let n = Math.min(c.children.length, c.count - p, num);
      if (n === 0 || c.count === 0) return;
      const cp = fn.m_nFirstControlPoint | 0;
      const of = attrIndex(fn.m_nOrientationField, A.NONE);
      for (const k of c.children) {
        if (groupOf(k) !== (fn.m_nChildGroupID | 0) || n === 0) continue;
        if (p >= 0 && p < c.capacity) {
          const pos = getV(c, A.POSITION, p);
          setCpPosition(k, cp, pos);
          let dir = null;
          if (!fn.m_bSetOrientation) {
            if (of !== A.NONE && VECTOR_ATTRS.has(of)) { const v = getV(c, of, p); dir = isZero(v) ? [0, 0, 1] : norm(v); }
          } else {
            const v = sub(pos, getV(c, A.PREV, p));
            if (!isZero(v)) dir = norm(v);
          }
          if (dir) { const [f, l, u] = frameFromNormal(dir); setCpOrientation(k, cp, f, l, u); }
        }
        n--;
        p += (Math.abs(inc) % c.count) * (inc < 0 ? -1 : 1);
        if (p < 0) p += c.count;
      }
    },
  },

  // C_INIT_CreateFromParentParticles, Init 0x180151bc0. No parent: position = previous = 0; an empty parent: life 0
  // too. Else the parent index (context float) walks by m_flIncrement (wrapping to 0 past the last), or is random:
  // integral increments trunc((last + 1) * r), fractional last * r, r = T[c914 + c910++] (m_nRandomSeed 0) or
  // T[seed + c914 + n++]. A fractional index lerps between floor and min(ceil, last). Position = prev + (pos - prev)
  // * f with f = 1, or with m_bSubFrame the new particle's place in the frame; previous = pos + (prev - pos) *
  // m_flVelocityScale. Version > 8 links the particle to its parent.
  C_INIT_CreateFromParentParticles: {
    evidence: 'RE',
    init(fn, c, s, e, _k, st) {
      const p = c.parent;
      if (!p || p.count === 0) {
        for (let i = s; i < e; i++) {
          setV(c, A.POSITION, i, [0, 0, 0]); setV(c, A.PREV, i, [0, 0, 0]);
          if (p) setF(c, A.LIFE, i, 0);
        }
        return;
      }
      st.at ??= 0; st.n ??= 0;
      const last = Math.max(0, p.count - 1), incr = +fn.m_flIncrement || 0;
      const integral = incr - Math.floor(incr) === 0;
      const seed = fn.m_nRandomSeed | 0;
      for (let i = s; i < e; i++) {
        if (!fn.m_bRandomDistribution) { if (last < st.at) st.at = 0; }
        else {
          const k = seed === 0 ? c.rnd.offset + c.rnd.counter++ : st.n++ + seed + c.rnd.offset;
          st.at = integral ? Math.trunc((last + 1) * T(c, k)) : last * T(c, k);
        }
        const fl = Math.floor(st.at);
        let P = getV(p, A.POSITION, fl), Q = getV(p, A.PREV, fl);
        if (!integral) {
          const hi = Math.min(Math.ceil(st.at), last), fr = st.at - fl;
          P = lerp3(P, getV(p, A.POSITION, hi), fr); Q = lerp3(Q, getV(p, A.PREV, hi), fr);
        }
        let f = 1;
        if (fn.m_bSubFrame) {
          const now = c.time, prevT = now - c.dt, ct = c.attr[A.CREATION][i];
          if (prevT === now) { if (ct - now < 0) f = 0; } else f = clamp((ct - prevT) / (now - prevT), 0, 1);
        }
        const pos = lerp3(Q, P, f);
        setV(c, A.POSITION, i, pos);
        setV(c, A.PREV, i, lerp3(pos, Q, +fn.m_flVelocityScale || 0));
        if (writeLinks(c)) setLink(c, i, fl, p.attr[A.ID][fl]); // m_bSetRopeSegmentID also writes 47 = parent ID (no stream)
        st.at += incr;
      }
    },
  },

  // C_OP_SetSingleControlPointPosition (pre-emission), Operate 0x18027de00, transform-valid 0x18038ebb0. CP1 =
  // m_vecCP1Pos, or with a valid m_transformInput (type CONTROL_POINT(_RANGE) with CP >= 0, or a named value) that
  // transform applied to it (rotate then translate; scale 1 for a CP). m_bSetOnce runs once.
  C_OP_SetSingleControlPointPosition: {
    evidence: 'RE',
    pre(fn, c, _s, st) {
      const v = evalVec(fn.m_vecCP1Pos, c, -1);
      if (fn.m_bSetOnce) { if (st.once) return; st.once = true; }
      const t = fn.m_transformInput || {};
      const type = t.m_nType ?? 'PT_TYPE_INVALID';
      const valid = (type === 'PT_TYPE_CONTROL_POINT' || type === 'PT_TYPE_CONTROL_POINT_RANGE') ? (t.m_nControlPoint | 0) >= 0
        : type === 'PT_TYPE_NAMED_VALUE' ? !!t.m_NamedValue : false;
      if (!valid) { setCpPosition(c, fn.m_nCP1 | 0, v); return; }
      const T0 = transformOf(c, t);
      setCpPosition(c, fn.m_nCP1 | 0, add(T0.position, toWorld(T0, v)));
    },
  },

  // C_INIT_InheritFromParentParticles, Init 0x180152470. The parent index (context int) walks by m_nIncrement,
  // wrapping to 0 past the last, or is random: trunc((last + 1) * T[c914 + (c910++ | seed + n++)]). The field copies
  // the parent's: vectors x m_flScale (colour / glow clamped [0,1]), int streams raw, floats x m_flScale (alpha
  // clamped [0,1]). Version > 8 links the particle to its parent. No parent particles: nothing happens.
  C_INIT_InheritFromParentParticles: {
    evidence: 'RE',
    init(fn, c, s, e, _k, st) {
      const p = c.parent;
      if (!p || p.count === 0) return;
      const out = attrIndex(fn.m_nFieldOutput, A.COLOR);
      if (!c.attr[out] || !p.attr[out]) { report(c, `C_INIT_InheritFromParentParticles field ${out} is not a stream`); return; }
      st.at ??= 0; st.n ??= 0;
      const last = Math.max(0, p.count - 1), sc = +fn.m_flScale;
      for (let i = s; i < e; i++) {
        if (!fn.m_bRandomDistribution) { if (last < st.at) st.at = 0; }
        else {
          const k = (fn.m_nRandomSeed | 0) === 0 ? c.rnd.counter++ : (fn.m_nRandomSeed | 0) + st.n++;
          st.at = Math.trunc((last + 1) * T(c, c.rnd.offset + k));
        }
        const j = st.at;
        if (VECTOR_ATTRS.has(out)) {
          let v = mul(getV(p, out, j), sc);
          if (COLOUR_MASK.has(out)) v = v.map((x) => clamp(x, 0, 1));
          setV(c, out, i, v);
        } else if (INT_ATTRS.has(out)) c.attr[out][i] = p.attr[out][j];
        else {
          const v = sc * p.attr[out][j];
          c.attr[out][i] = ALPHA_MASK.has(out) ? clamp(v, 0, 1) : v;
        }
        if (writeLinks(c)) setLink(c, i, j, p.attr[A.ID][j]);
        st.at += fn.m_nIncrement | 0;
      }
    },
  },

  // C_INIT_CreateFromCPs, Init 0x180152c40, init 0x180152b60, context 0x180152b90 (= min CP). Max CP is m_nMaxCP
  // (version < 2: 63, then the highest CP in use); trunc(m_nDynamicCPCount) >= 0 limits the count and moves the max.
  // Zero CPs: life 0. Else each particle sits (position and previous) at CP ctx, interpolated to its creation time,
  // ctx += m_nIncrement, back to the min CP past the max.
  C_INIT_CreateFromCPs: {
    evidence: 'RE',
    init(fn, c, s, e, _k, st) {
      let mn = fn.m_nMinCP | 0, mx = fn.m_nMaxCP | 0;
      if ((c.def.m_nBehaviorVersion | 0) < 2) mx = 63;
      if (mn > mx) [mn, mx] = [mx, mn];
      st.at ??= mn;
      if ((c.def.m_nBehaviorVersion | 0) < 2) mx = c.controlPoints.length - 1;
      const dyn = Math.trunc(evalFloat(fn.m_nDynamicCPCount, c, -1));
      let n = mx - mn + 1;
      if (dyn >= 0) { n = Math.min(dyn, n); mx = mn - 1 + n; }
      for (let i = s; i < e; i++) {
        if (n === 0) { setF(c, A.LIFE, i, 0); continue; }
        if (mx < st.at) st.at = mn;
        const p = cpPositionAt(c, getCp(c, st.at), c.attr[A.CREATION][i]);
        setV(c, A.PREV, i, p); setV(c, A.POSITION, i, p);
        st.at += fn.m_nIncrement | 0;
      }
    },
  },

  // C_OP_DistanceBetweenTransforms, Operate 0x1801e1c10. d = |S - E|; m_bLOS traces S -> E (past m_flMaxTraceLength
  // to normalize(E) * maxTrace + S: the end POSITION is normalised, 0x1800522b0), a blocked trace scales d by
  // fraction * m_flLOSScale. Per particle t = clamp((d - inMin) / (inMax - inMin or 1), 0, 1), v = lerp(outMin,
  // outMax, t), set method, then cur + strength * (v - cur).
  C_OP_DistanceBetweenTransforms: {
    evidence: 'RE',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nFieldOutput, A.RADIUS);
      if (VECTOR_ATTRS.has(out) || !c.attr[out]) { report(c, `C_OP_DistanceBetweenTransforms output ${out} is not a scalar stream`); return; }
      const S = transformOf(c, fn.m_TransformStart).position, E = transformOf(c, fn.m_TransformEnd).position;
      let d = len(sub(S, E));
      if (fn.m_bLOS) {
        const mt = +fn.m_flMaxTraceLength;
        const to = mt !== -1 && mt < d ? add(mul(norm(E), mt), S) : E;
        const fr = traceFraction(c, S, to);
        if (fr !== 1) d = d * fr * fn.m_flLOSScale;
      }
      for (let i = 0; i < c.count; i++) {
        const a = evalFloat(fn.m_flInputMin, c, i), b = evalFloat(fn.m_flInputMax, c, i);
        const o0 = evalFloat(fn.m_flOutputMin, c, i), o1 = evalFloat(fn.m_flOutputMax, c, i);
        const t = clamp((d - a) / (b === a ? 1 : b - a), 0, 1);
        const cur = c.attr[out][i];
        const v = setMethod(fn.m_nSetMethod, o0 + (o1 - o0) * t, getInitF(c, out, i), cur, c.dt);
        c.attr[out][i] = cur + s * (v - cur);
      }
    },
  },

  // C_OP_RemapModelVolumetoCP (pre-emission), Operate 0x18027a570, remap 0x180059680 (clamped; equal inputs pick
  // outMin / outMax by side). The box is the in-CP's model / entity bounds, read here from opts.cpBounds(cp) ->
  // { mins, maxs } (a CP without a model asks the game for its entity bounds, +0x1d8 vtable +0x78); without it the
  // box is empty. VOLUME = dx*dy*dz (cube-rooted with m_bCubeRoot, pow 1/3 = DAT_1805341b0), SURFACE_AREA =
  // sqrt(2*(dz*dx + dx*dy + dz*dy)), RADIUS = |mins - (mins + maxs)/2|, then remapped into CP field m_nField of
  // m_nOutControlPointNumber; DIMENSIONS sets the out CP to (dx, dy, dz), MINS_MAXS the out CP to mins and the max CP
  // (when >= 0) to maxs. UNSETTLED: the model paths (hitbox / mesh bounds with m_bBBoxOnly) are not modelled.
  C_OP_RemapModelVolumetoCP: {
    evidence: 'RE',
    pre(fn, c) {
      const outCp = fn.m_nOutControlPointNumber | 0;
      if (outCp < 0) return;
      const b = c.sys.opts.cpBounds ? c.sys.opts.cpBounds(fn.m_nInControlPointNumber | 0) : null;
      if (!b) report(c, 'C_OP_RemapModelVolumetoCP has no opts.cpBounds; the box is empty');
      const mins = vec3(b?.mins), maxs = vec3(b?.maxs);
      const [dx, dy, dz] = sub(maxs, mins);
      const type = typeof fn.m_nBBoxType === 'number' ? BBOX[fn.m_nBBoxType] : fn.m_nBBoxType;
      let v;
      if (type === 'BBOX_DIMENSIONS') { setCpPosition(c, outCp, [dx, dy, dz]); return; }
      if (type === 'BBOX_MINS_MAXS') {
        if ((fn.m_nOutControlPointMaxNumber | 0) < 0) return;
        setCpPosition(c, outCp, mins); setCpPosition(c, fn.m_nOutControlPointMaxNumber | 0, maxs); return;
      }
      if (type === 'BBOX_VOLUME') { v = dy * dx * dz; if (fn.m_bCubeRoot) v = Math.cbrt(v); }
      else if (type === 'BBOX_SURFACE_AREA') v = Math.sqrt(2 * (dz * dx + dx * dy + dz * dy));
      else if (type === 'BBOX_RADIUS') v = len(sub(mins, mul(add(mins, maxs), 0.5)));
      else return;
      const i0 = +fn.m_flInputMin, i1 = +fn.m_flInputMax, o0 = +fn.m_flOutputMin, o1 = +fn.m_flOutputMax;
      const r = i0 === i1 ? (v - i1 >= 0 ? o1 : o0) : o0 + clamp((v - i0) / (i1 - i0), 0, 1) * (o1 - o0);
      setCpField(c, outCp, fn.m_nField | 0, r);
    },
  },

  // Renderers: not simulated, render/* draws them (effects.js). C_OP_RenderTrails (slot 6 0x1802d18c0, slot 31
  // 0x1802d1680, slot 37 0x1802d6190): a streak per particle, not a rope joining particles. Its init writes two
  // collection fields, +0x3ac = m_flMaxLength and +0x3b0 = (m_nPrevPntSource == PREV_POSITION && !m_bIgnoreDT);
  // its read mask (slot 31) is position, life, previous point (m_nPrevPntSource), radius, roll, colour, alpha,
  // creation time, sequence, trail length (10), ... ; the length is scaled by m_flLengthScale (0x1802d6190).
  // Nothing new is simulated: every stream it reads is kept already. UNSETTLED: who reads +0x3ac / +0x3b0, and
  // the exact length rule (min / max length, m_flLengthFadeInTime) for the drawing side.
  C_OP_RenderTrails: { evidence: 'render', renderer: true },
  // The three below are registered so they stop reporting as not implemented; drawing them is not ported (what it
  // would need, from their fields, not their code): RenderModels a mesh per particle from m_ModelList, posed from
  // position / radius / roll-yaw-pitch, tinted by colour and alpha; RenderProjected a projected material per
  // particle (m_vecProjectedMaterials) from position / radius / orientation; RenderSound a sound event per particle
  // (m_pszSoundName) for audio.js.
  C_OP_RenderModels: { evidence: 'render', renderer: true },
  C_OP_RenderProjected: { evidence: 'render', renderer: true },
  C_OP_RenderSound: { evidence: 'render', renderer: true },
};
