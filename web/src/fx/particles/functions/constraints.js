// Constraints: run after the operators each step.
import { evalFloat, evalVec } from '../inputs.js';
import { A, add, getV, len, mul, report, setV, sub, toWorld, transformOf } from './common.js';

export const constraints = {
  // VRF cross-check, UNSETTLED: particles pushed back inside [min, max] of the centre.
  C_OP_ConstrainDistance: {
    evidence: 'VRF',
    constrain(fn, c) {
      const off = evalVec(fn.m_CenterOffset, c, -1);
      const cp = transformOf(c, fn.m_nControlPointNumber);
      const centre = fn.m_bGlobalCenter ? off : add(cp.position, toWorld(cp, off));
      const lo = evalFloat(fn.m_fMinDistance, c, -1);
      let hi = evalFloat(fn.m_fMaxDistance, c, -1);
      if (hi < 0) hi = Infinity;
      for (let i = 0; i < c.count; i++) {
        const d = sub(getV(c, A.POSITION, i), centre), l = len(d);
        if ((l >= lo && l <= hi) || l === 0) continue;
        setV(c, A.POSITION, i, add(centre, mul(d, (l < lo ? lo : hi) / l)));
      }
    },
  },

  // No evidence in the notes and no VRF implementation: a reported no-op.
  C_OP_BoxConstraint: {
    evidence: 'none',
    noop: 'no evidence in the RE notes and none in VRF',
    constrain(fn, c) { report(c, 'C_OP_BoxConstraint is a no-op (no evidence)'); },
  },
};
