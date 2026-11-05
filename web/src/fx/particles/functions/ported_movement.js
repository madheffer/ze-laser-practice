// Ported from CS2's particles.dll (tools/particles/PORTING.md), md5 63babcbf3245e56855a777134323e74a.
//
// C_OP_BasicMovement, Operate 0x1801c0ba0. m_bUseNewCode (+0xea4) picks the path: false runs the body of 0x1801c0ba0,
// true calls 0x1801c2bb0. Both share:
//  - drag m_fDrag (a collection float input, 0x180036130) clamped [0, 0.9999999] (DAT_1805341fc); the velocity factor
//    is exp(ln(1 - drag) / (1/30) * dt) * dt / prevDt (DAT_180534200 = 1, DAT_180534180 = 1/30; prevDt is coll+0x68,
//    the last non-zero dt, see system.js simulate).
//  - the m_ForceGenerators loop: every entry whose strength (0x18003f820) is above zero gets the raw gravity (slot 35)
//    and adds into the buffer (slot 34). Slot 34 also gets a mass buffer; of the force classes only
//    C_OP_IntraParticleForce (0x180116c20) reads it, so `sub.forces` does not pass it.
//  - Verlet: prev = pos + (pos - prev) * factor + dt^2 * (per-particle scale) * buffer, then the position and
//    previous-position streams swap; then the m_Constraints passes up to m_nMaxConstraintPasses (`sub.constraints`,
//    the same loop in both paths: 0x1801c11c7.. and 0x1801c2e60..).
//  - attribute 34, "Force Scale" (name table 0x1804d7a30), stream coll+0x3e8 (= 0x2d8 + 8*34) with stride byte
//    coll+0x482, one float per particle, multiplies the buffer. Its collection constant is 1.0 (FUN_18003b6f0,
//    common.js FORCE_SCALE_DEFAULT); writers are any float writer with output 34 (C_INIT_CreationNoise in the baked
//    hegrenade embers / snow flakes) and C_OP_PinParticleToCP (writes 0 and 1.0, not ported here).
// Old path (0x1801c0ba0): the buffer starts at the gravity (m_Gravity, collection vec input, 0x1800bfa80/0x1800bf870)
//   and is an acceleration; the forces get a constant mass buffer of 1.0 (_DAT_180534860).
// New path (0x1801c2bb0):
//  1. a mass per particle (0x1801c1930): with no force generators (definition +0x70 == 0) it is the constant 1.0
//     (_DAT_180534860); else m = m_flScale * r^3, or m_flScale * r^2 under PARTICLE_MASSMODE_RADIUS_SQUARED (mode 2),
//     with r = m_flRadius / m_flNominalRadius (divps); the three are per-particle float inputs of m_massControls.
//  2. the buffer (0x1801c2660) starts at gravity * mass (a force) and the force generators add into it.
//  3. the integration (0x1801c2bb0 loop) scales it by attr34 * (1 / mass) * dt^2: gravity stays mass-independent,
//     a force generator's term is divided by the mass. The game's 1/mass is rcpps (12-bit approximate); exact here.
//     A mass of 0 gives rcpps = +inf, so the position goes inf/NaN as in the game (not guarded).
import { A, clamp } from './common.js';
import { evalFloat, evalVec } from '../inputs.js';

const DRAG_MAX = 0.9999999; // DAT_1805341fc
const MASS_SQUARED = 'PARTICLE_MASSMODE_RADIUS_SQUARED'; // ParticleMassMode_t 2

// A Float32Array of `size` floats kept on the operator state, reused each frame.
const scratch = (st, key, c, per) => {
  const n = per * c.count;
  if (!st[key] || st[key].length < n) st[key] = new Float32Array(per * Math.max(c.capacity, c.count));
  return st[key].subarray(0, n);
};

// 0x1801c1930: mass of every particle from m_massControls (CParticleMassCalculationParameters at +0xa30).
function masses(fn, c, st) {
  const mc = fn.m_massControls || {};
  const squared = mc.m_nMassMode === MASS_SQUARED || mc.m_nMassMode === 2;
  const m = scratch(st, 'mass', c, 1);
  for (let i = 0; i < c.count; i++) {
    const r = evalFloat(mc.m_flRadius ?? 1, c, i) / evalFloat(mc.m_flNominalRadius ?? 1, c, i);
    m[i] = evalFloat(mc.m_flScale ?? 1, c, i) * (squared ? r * r : r * r * r);
  }
  return m;
}

export const ported_movement = {
  C_OP_BasicMovement: {
    evidence: 'RE',
    op(fn, c, _s, st, sub) {
      const dt = c.dt, n = c.count;
      if (!(dt > 0) || !n) return;
      const g = evalVec(fn.m_Gravity, c, -1);
      const drag = clamp(evalFloat(fn.m_fDrag, c, -1), 0, DRAG_MAX);
      const k = Math.exp((Math.log(1 - drag) / (1 / 30)) * dt) * (dt / c.prevDt);
      const newCode = !!fn.m_bUseNewCode;
      // New path with force generators: per-particle mass; otherwise the constant 1 (no buffer).
      const mass = newCode && c.def.m_ForceGenerators?.length ? masses(fn, c, st) : null;
      const acc = scratch(st, 'acc', c, 3);
      for (let i = 0; i < n; i++) {
        const w = mass ? mass[i] : 1;
        acc[3 * i] = g[0] * w; acc[3 * i + 1] = g[1] * w; acc[3 * i + 2] = g[2] * w;
      }
      sub?.forces(c, acc, g);
      const P = c.attr[A.POSITION], Q = c.attr[A.PREV], S = c.attr[A.FORCE_SCALE], dt2 = dt * dt;
      for (let i = 0; i < n; i++) {
        const s = (S ? S[i] : 1) * (mass ? 1 / mass[i] : 1) * dt2;
        for (let j = 3 * i; j < 3 * i + 3; j++) {
          const p = P[j];
          P[j] = p + (p - Q[j]) * k + s * acc[j];
          Q[j] = p;
        }
      }
      sub?.constraints(c, fn.m_nMaxConstraintPasses | 0);
    },
  },
};
