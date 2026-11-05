// Ported from CS2's particles.dll (tools/particles/PORTING.md), md5 63babcbf3245e56855a777134323e74a ("63babcbf").
// C_OP_PinParticleToCP: one particle of the collection held at a control point until a break rule fires.
// Constants: DAT_180534200 = 1, DAT_1805343cc = -1, DAT_1805343a4 = FLT_MAX (read with tools/particles/consts.py).
import { A, FLT_MAX, add, clamp, enumIndex, getCp, getInitV, getV, len, setV, sub, toLocal, toWorld } from './common.js';
import { evalFloat, evalVec } from '../inputs.js';

const SELECTION = ['PARTICLE_SELECTION_FIRST', 'PARTICLE_SELECTION_LAST', 'PARTICLE_SELECTION_NUMBER'];
// ParticlePinDistance_t: NONE -1, NEIGHBOR 0, FARTHEST 1, FIRST 2, LAST 3, CENTER 5, CP 6, CP_PAIR_EITHER 7,
// CP_PAIR_BOTH 8, SPEED 9, COLLECTION_AGE 10, FLOAT_VALUE 11.
const PIN = { PARTICLE_PIN_DISTANCE_NONE: -1, PARTICLE_PIN_DISTANCE_NEIGHBOR: 0, PARTICLE_PIN_DISTANCE_FARTHEST: 1,
  PARTICLE_PIN_DISTANCE_FIRST: 2, PARTICLE_PIN_DISTANCE_LAST: 3, PARTICLE_PIN_DISTANCE_CENTER: 5,
  PARTICLE_PIN_DISTANCE_CP: 6, PARTICLE_PIN_DISTANCE_CP_PAIR_EITHER: 7, PARTICLE_PIN_DISTANCE_CP_PAIR_BOTH: 8,
  PARTICLE_PIN_SPEED: 9, PARTICLE_PIN_COLLECTION_AGE: 10, PARTICLE_PIN_FLOAT_VALUE: 11 };
const pinType = (v) => (typeof v === 'number' ? v : PIN[v] ?? 0);
// "x > limit" as the game tests it (!(x < limit) && !(x == limit)): a NaN ratio breaks the pin.
const above = (x, limit) => !(x < limit) && x !== limit;
const cpPos = (c, i) => getCp(c, clamp(i | 0, 0, 63)).position;
// The collection bounds (coll+0x210 min, +0x21c max) as the bounds pass 0x18004b040 builds them: position -+ radius.
const evalBounds = (c) => {
  const min = [FLT_MAX, FLT_MAX, FLT_MAX], max = [-FLT_MAX, -FLT_MAX, -FLT_MAX], P = c.attr[A.POSITION], R = c.attr[A.RADIUS];
  for (let i = 0; i < c.count; i++) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], P[3 * i + k] - R[i]); max[k] = Math.max(max[k], P[3 * i + k] + R[i]);
  }
  return { min, max };
};

// Slot 11 0x1801deba0: the operator state. broken +0, initial distance +4 (-1), selected +8, other +0xc, last ID
// +0x10 (-1), retained local velocity +0x14 (DAT_1804d81e0, FLT_MAX: not captured).
const init = (st) => {
  if (st.sel !== undefined) return;
  Object.assign(st, { broken: false, initDist: -1, sel: -1, other: 0, lastId: -1, vel: [FLT_MAX, FLT_MAX, FLT_MAX] });
};

// FUN_1801df160: pick the particle (m_nParticleSelection, m_nParticleNumber truncated) and its break partner.
function select(fn, c, st) {
  const n = c.count, num = Math.trunc(evalFloat(fn.m_nParticleNumber, c, -1));
  const mode = enumIndex(fn.m_nParticleSelection, SELECTION);
  const cpi = clamp(fn.m_nControlPointNumber | 0, 0, 63);
  if (mode === 0) st.sel = num < 0 ? 0 : Math.min(num, n - 1);
  else if (mode === 1) {
    const s = n - num - 1;
    st.sel = s < 0 ? 0 : Math.min(s, n - 1);
    const id = c.attr[A.ID][st.sel];
    if (id !== st.lastId) {
      // The particle that carried the last ID (searched from the end) is let go: force scale 1.0; with
      // m_bRetainInitialVelocity (+0x11a8) it takes the retained velocity (CP-local, rotated by the CP frame), and the
      // new particle's velocity (pos - prev) / prev dt goes into the CP frame as the next one to retain.
      let j = -1;
      for (let k = n - 1; k >= 0; k--) if (c.attr[A.ID][k] === st.lastId) { j = k; break; }
      st.lastId = id;
      const cp = getCp(c, cpi);
      if (j >= 0 && j < n) {
        c.attr[A.FORCE_SCALE][j] = 1;
        if (fn.m_bRetainInitialVelocity) {
          const old = st.vel;
          st.vel = toLocal(cp, sub(getV(c, A.POSITION, st.sel), getV(c, A.PREV, st.sel)).map((x) => x * (1 / c.prevDt)));
          const w = toWorld(cp, old);
          setV(c, A.PREV, j, sub(getV(c, A.PREV, j), w.map((x) => x * c.dt)));
        }
      } else if (j < 0 && n > 0 && fn.m_bRetainInitialVelocity && st.vel.every((x) => x === FLT_MAX)) {
        // never captured: from the selected particle's initial streams (coll+0x4c8 / +0x4d8)
        st.vel = toLocal(cp, sub(getInitV(c, A.POSITION, st.sel), getInitV(c, A.PREV, st.sel)).map((x) => x * (1 / c.prevDt)));
      }
    }
  } else {
    const old = st.sel;
    st.sel = num < -1 ? -1 : Math.min(num, n - 1);
    if (old !== -1 && st.sel !== old && old < n) c.attr[A.FORCE_SCALE][old] = 1;
  }
  const t = pinType(fn.m_nPinBreakType);
  if (t === 0) st.other = mode === 0 ? st.sel + 1 : st.sel - 1;
  else if (t === 1) st.other = n - st.sel <= Math.trunc(n / 2) ? 0 : n - 1;
  else if (t === 2) st.other = 0;
  else if (t === 3) st.other = n - 1;
  st.sel = st.sel < -1 ? -1 : Math.min(st.sel, n);
  st.other = st.other < 0 ? 0 : Math.min(st.other, n);
}

// FUN_1801debe0: the break distance for the type, from the current (initial = false) or initial streams.
function pinDistance(fn, c, st, initial) {
  const t = pinType(fn.m_nPinBreakType);
  const P = (i) => (initial ? getInitV(c, A.POSITION, i) : getV(c, A.POSITION, i));
  const cp = cpPos(c, fn.m_nControlPointNumber), b1 = fn.m_nBreakControlPointNumber | 0, b2 = fn.m_nBreakControlPointNumber2 | 0;
  switch (t) {
    case 0: case 1: case 2: case 3: return len(sub(P(st.sel), P(st.other)));
    case 5: { const b = evalBounds(c); return len(sub(P(st.sel), add(b.min, b.max).map((x) => x * 0.5))); }
    case 6: return b1 >= 0 ? len(sub(cp, cpPos(c, b1))) : 0;
    case 7: return b1 >= 0 && b2 >= 0 ? Math.max(len(sub(cp, cpPos(c, b1))), len(sub(cp, cpPos(c, b2)))) : 0;
    case 8: return b1 >= 0 && b2 >= 0 ? Math.min(len(sub(cp, cpPos(c, b1))), len(sub(cp, cpPos(c, b2)))) : 0;
    default: return 0;
  }
}

export const ported_pin = {
  // 63babcbf: C_OP_PinParticleToCP Operate slot 34 0x1801dfd00, selection FUN_1801df160, distance FUN_1801debe0,
  // state slot 11 0x1801deba0, class init slot 6 0x1801de300 (m_nControlPointNumber clamped 0..63), output masks
  // slot 30 0x400000005 (position, previous position, attribute 34) / slot 31 0x801.
  // Per frame, once broken nothing runs again. Else select; no particle (index < 0) stops. Break rules: SPEED
  // |cp - cp prev| / dt > m_flBreakSpeed; COLLECTION_AGE time > m_flAge; FLOAT_VALUE m_flBreakValue >= 1; NONE never;
  // a distance type breaks when m_flBreakDistance > -1 and distance / initial distance > m_flBreakDistance (the initial
  // one measured once, from the initial streams). Pinned: attribute 34 (force scale, coll+0x3e8) = 0, target =
  // CP + m_vecOffset (through the CP frame with m_bOffsetLocal), pos = prev = lerp(pos, target, m_flInterpolation of
  // that particle). Broken this frame: attribute 34 = 1.0.
  // UNSETTLED: the CENTER bounds (coll+0x210 / +0x21c) are min / max of position -+ radius over the live particles (the
  // runtime keeps no bounds; the game's bounds pass 0x18004b040 does this); a CP pair with a negative break CP reads
  // distance 0 (FUN_1801debe0 returns no value there).
  C_OP_PinParticleToCP: {
    evidence: 'RE',
    op(fn, c, _s, st) {
      init(st);
      if (st.broken) return;
      select(fn, c, st);
      const i = st.sel;
      if (i < 0 || i >= c.count) return;
      const t = pinType(fn.m_nPinBreakType);
      if (t === 9) {
        const cp = getCp(c, clamp(fn.m_nControlPointNumber | 0, 0, 63));
        if (above(len(sub(cp.position, cp.prevPosition)) / c.dt, evalFloat(fn.m_flBreakSpeed, c, -1))) st.broken = true;
      } else if (t === 10) st.broken = c.time > evalFloat(fn.m_flAge, c, -1);
      else if (t === 11) st.broken = evalFloat(fn.m_flBreakValue, c, -1) >= 1;
      else if (t !== -1) {
        const d = evalFloat(fn.m_flBreakDistance, c, -1);
        if (d > -1) {
          if (st.initDist === -1) st.initDist = pinDistance(fn, c, st, true);
          if (above(pinDistance(fn, c, st, false) / st.initDist, d)) st.broken = true;
        }
      }
      if (st.broken) { c.attr[A.FORCE_SCALE][i] = 1; return; }
      c.attr[A.FORCE_SCALE][i] = 0;
      const cp = getCp(c, clamp(fn.m_nControlPointNumber | 0, 0, 63));
      const off = evalVec(fn.m_vecOffset, c, -1);
      const target = add(cp.position, fn.m_bOffsetLocal ? toWorld(cp, off) : off);
      const k = evalFloat(fn.m_flInterpolation, c, i);
      const p = getV(c, A.POSITION, i);
      const q = [p[0] + (target[0] - p[0]) * k, p[1] + (target[1] - p[1]) * k, p[2] + (target[2] - p[2]) * k];
      setV(c, A.POSITION, i, q);
      setV(c, A.PREV, i, q);
    },
  },
};
