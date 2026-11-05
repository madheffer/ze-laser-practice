// Emitters. Each returns the age at spawn of every particle it emits this step. Neither emitter's
// maths is in the RE notes (only their constructor defaults, RE §11 InstantaneousEmitter
// 0x18010b720, ContinuousEmitter 0x18010c450), so both follow VRF: VRF cross-check, UNSETTLED.
import { evalFloat } from '../inputs.js';
import { report } from './common.js';

const elapsedOf = (c) => c.time - (c.emitterOrigin ?? c.startTime ?? 0);

export const emitters = {
  C_OP_InstantaneousEmitter: {
    evidence: 'VRF',
    emit(fn, c, strength, st) {
      if (st.done) return null;
      const elapsed = elapsedOf(c);
      const start = evalFloat(fn.m_flStartTime, c, -1);
      if (elapsed < start) return null;
      if (fn.m_flInitFromKilledParentParticles > 0) report(c, 'C_OP_InstantaneousEmitter m_flInitFromKilledParentParticles not implemented');
      if (fn.m_nSnapshotControlPoint >= 0) report(c, 'C_OP_InstantaneousEmitter snapshot emission not implemented');
      if (!st.resolved) {
        st.resolved = true;
        let n = evalFloat(fn.m_nParticlesToEmit, c, -1);
        const scale = evalFloat(fn.m_flParentParticleScale, c, -1);
        if (scale !== -1 && c.parent) n *= c.parent.count * scale;
        st.remaining = Math.trunc(n);
      }
      // An unset per-frame cap means the pool size (VRF), so an oversized burst drips out.
      const cap = fn.m_nMaxEmittedPerFrame >= 0 ? fn.m_nMaxEmittedPerFrame : Math.min(c.capacity, 20000);
      const claimed = Math.min(st.remaining, cap);
      st.remaining -= claimed;
      if (st.remaining <= 0) st.done = true;
      return new Array(Math.max(0, Math.trunc(claimed * strength))).fill(elapsed - start);
    },
  },

  C_OP_ContinuousEmitter: {
    evidence: 'VRF',
    emit(fn, c, strength, st) {
      if (st.done) return null;
      st.pending ??= 0;
      st.flushed ??= 0;
      if (fn.m_flEmissionScale || fn.m_flScalePerParentParticle || fn.m_nSnapshotControlPoint >= 0 || fn.m_bInitFromKilledParentParticles) {
        report(c, 'C_OP_ContinuousEmitter emission scale, parent scaling and snapshots not implemented');
      }
      const elapsed = elapsedOf(c);
      const frameStart = elapsed - c.dt;
      const start = evalFloat(fn.m_flStartTime, c, -1);
      const dur = evalFloat(fn.m_flEmissionDuration, c, -1);
      const ages = [];
      if (start <= elapsed) {
        let w0 = frameStart, w1 = elapsed;
        if (dur !== 0) { w0 = Math.max(start, w0); w1 = Math.min(start + dur, w1); }
        const rate = evalFloat(fn.m_flEmitRate, c, -1) * strength;
        if (w1 > w0 && rate > 0) {
          st.pending += rate * (w1 - w0);
          const to = Math.floor(st.pending + 0.001);
          const n = to - st.flushed;
          if (n > 0) {
            st.flushed = to;
            // Spawn times staggered evenly across the window, so a frame's particles are not coincident.
            const step = (w1 - w0) / n;
            for (let k = 0; k < n; k++) ages.push(elapsed - Math.min(w0 + (k + 1) * step, w1));
          }
        }
      }
      if (dur !== 0 && elapsed > start + dur) st.done = true;
      if (fn.m_nLimitPerUpdate > 0) report(c, 'C_OP_ContinuousEmitter m_nLimitPerUpdate not implemented');
      return ages;
    },
  },
};
