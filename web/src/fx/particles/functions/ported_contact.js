// Ported from CS2's particles.dll (tools/particles/PORTING.md), md5 63babcbf3245e56855a777134323e74a ("63babcbf").
// Contact between particles (C_OP_IntraParticleForce) and between particles and the world's planes
// (C_OP_WorldCollideConstraint). Constants: DAT_18053413c = FLT_EPSILON, DAT_180534200 = 1.
import { A, FLT_EPSILON, report } from './common.js';
import { updatePlanes } from './ported_collision.js';

const PLANES = 41; // the plane cache's slots (0x29), as ported_collision.js

// FUN_180116dd0: one pair. d = pos[j] - pos[i]; nothing when |d|^2 <= FLT_EPSILON. Attraction within
// m_flAttractionMaxDistance, repulsion within m_flRepulsionMaxDistance: f = 1 - sat((|d|^2 - min^2) / (max^2 - min^2))
// (min == max: 1 inside, 0 at or past it), k = m_i * m_j * max strength * strength * f; attraction acc[i] += k d,
// acc[j] -= k d; repulsion the opposite. d is not normalised.
function pair(fn, P, acc, mass, step, s, i, j) {
  const dx = P[3 * j] - P[3 * i], dy = P[3 * j + 1] - P[3 * i + 1], dz = P[3 * j + 2] - P[3 * i + 2];
  const d2 = dx * dx + dy * dy + dz * dz;
  if (!(d2 > FLT_EPSILON)) return;
  const dist = Math.sqrt(d2), mm = (mass ? mass[step * i] * mass[step * j] : 1) * s;
  const falloff = (lo, hi) => {
    const a = lo * lo, b = hi * hi;
    if (a === b) return d2 - b >= 0 ? 0 : 1;
    return 1 - Math.min(1, Math.max(0, (d2 - a) / (b - a)));
  };
  const add = (k) => {
    acc[3 * i] += k * dx; acc[3 * i + 1] += k * dy; acc[3 * i + 2] += k * dz;
    acc[3 * j] -= k * dx; acc[3 * j + 1] -= k * dy; acc[3 * j + 2] -= k * dz;
  };
  if (dist < +fn.m_flAttractionMaxDistance) add(mm * fn.m_flAttractionMaxStrength * falloff(+fn.m_flAttractionMinDistance, +fn.m_flAttractionMaxDistance));
  if (dist < +fn.m_flRepulsionMaxDistance) add(-mm * fn.m_flRepulsionMaxStrength * falloff(+fn.m_flRepulsionMinDistance, +fn.m_flRepulsionMaxDistance));
}

export const ported_contact = {
  // 63babcbf: C_OP_IntraParticleForce AddForces slot 34 0x180116c20, pair body FUN_180116dd0; mask slot 31 0x89.
  // Runs when blocks != 0 and coll+0x8c2 bit 8 (set where the collection bounds coll+0x210 / +0x21c are computed,
  // 0x18004aafe / 0x18004b093). The mass buffer is BasicMovement's (its slot-34 argument {buffer, n}: per particle
  // when n > 1, else the one value); this runtime passes it as `mass` (null = the constant 1.0). Without m_bUseAABB
  // every pair i < j in index order; with it (the default) the pairs an AABB tree finds (FUN_18004ba00 builds it over
  // the bounds grown by m_flAttractionMaxDistance, one box per particle of half-size m_flAttractionMaxDistance +
  // radius, quantised to a 0..255 grid; FUN_180120f60 visits overlapping boxes), so repulsion past the attraction
  // range only reaches pairs whose boxes overlap.
  // UNSETTLED: coll+0x8c2 bit 8 is taken as set (the runtime keeps no bounds); the AABB pair test is the exact box
  // overlap |dp| <= 2 * attraction max + r_i + r_j per axis (the grid's quantisation slack is not modelled), visited
  // in index order (the tree's order only changes float rounding).
  C_OP_IntraParticleForce: {
    evidence: 'RE',
    force(fn, c, acc, strength, _st, mass) {
      const n = c.count;
      if (n < 2) return;
      const P = c.attr[A.POSITION], R = c.attr[A.RADIUS], step = mass && mass.length > 1 ? 1 : 0;
      const aabb = fn.m_bUseAABB !== false, h = +fn.m_flAttractionMaxDistance;
      for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
        if (aabb) {
          const reach = 2 * h + R[i] + R[j];
          if (Math.abs(P[3 * j] - P[3 * i]) > reach || Math.abs(P[3 * j + 1] - P[3 * i + 1]) > reach || Math.abs(P[3 * j + 2] - P[3 * i + 2]) > reach) continue;
        }
        pair(fn, P, acc, mass, step, strength, i, j);
      }
    },
  },

  // 63babcbf: C_OP_WorldCollideConstraint (no fields). State slot 11 0x1800ed230 (a zeroed plane cache, 0x21a0 bytes
  // of operator state: this cache is the operator's own, not the root's). Slot 34 (prepare, 0x1800ed2d0) refreshes it
  // with FUN_1800eccf0(state, coll, mode 1 = PER_FRAME_PLANESET, object mask 1, contents 0xc3001, CP 0, no offset,
  // tolerance 0, retest): the first frame traces the 26-direction grid around CP 0, later frames one round-robin slot.
  // Slot 35 (0x1800ed320): for every particle and every valid plane in order, d = (pos - point) . normal - radius;
  // d < 0 moves pos by -normal * d (previous position untouched); returns whether any particle moved. Slot 36
  // (0x18001bc00) is not final.
  C_OP_WorldCollideConstraint: {
    evidence: 'RE',
    prepare(fn, c, st) {
      if (!c.sys.opts.trace) { report(c, 'C_OP_WorldCollideConstraint: no opts.trace, no planes'); return; }
      st.k ||= { count: 0, write: 0, rr: 0, time: -1, last: [0, 0, 0], valid: new Uint8Array(PLANES), point: [], normal: [] };
      const q = { traceSet: 'PARTICLE_TRACE_SET_STATIC', mask: 1, contents: 0xc3001, collisionGroup: 'NONE', ignoreCp: -1,
        worldOnly: false, brushOnly: false, includeWater: false };
      updatePlanes({ m_nCP: 0, m_vecCpOffset: [0, 0, 0], m_flCpMovementTolerance: 0 }, c, st.k, 1, true, q);
    },
    constrain(fn, c, st) {
      const k = st.k;
      if (!k || !k.count) return false;
      const P = c.attr[A.POSITION], R = c.attr[A.RADIUS];
      let moved = false;
      for (let i = 0; i < c.count; i++) for (let p = 0; p < k.count; p++) {
        if (!k.valid[p]) continue;
        const pt = k.point[p], N = k.normal[p];
        const d = (P[3 * i] - pt[0]) * N[0] + (P[3 * i + 1] - pt[1]) * N[1] + (P[3 * i + 2] - pt[2]) * N[2] - R[i];
        if (d < 0) { P[3 * i] -= N[0] * d; P[3 * i + 1] -= N[1] * d; P[3 * i + 2] -= N[2] * d; moved = true; }
      }
      return moved;
    },
  },
};
