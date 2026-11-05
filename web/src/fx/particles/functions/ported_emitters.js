// Ported from CS2's particles.dll (tools/particles/PORTING.md), md5 63babcbf3245e56855a777134323e74a ("63babcbf").
// The two stock emitters and C_OP_RestartAfterDuration. An emitter entry returns the age at spawn of every particle
// it adds this frame (system.js emitParticles); `restart` is the emitter's slot 21, which the collection restart
// (0x18003ffb0, system.js rearm) calls on its state. Constants: tools/particles/consts.py.
import { FLT_MAX, clamp, getCp, report, tableAt as T } from './common.js';
import { evalFloat } from '../inputs.js';
import { attrType, cpSnapshot, snapshotStream } from './snapshot.js';
import { rearm } from '../system.js';

const ev = (inp, c) => evalFloat(inp, c, -1);
const CREATION = 8;
const refTime = (c) => c.emitterOrigin ?? c.startTime ?? 0; // UNSETTLED: who first calls slot 21 (collection start)

// FUN_180384ac0: whether an input settles to a final value, the time it does and that value. A literal settles at
// 0 on its value; the other types are taken as not settling. UNSETTLED: the timed map types (cases 2..7, 10).
const settleOf = (inp) => (inp && inp.m_nType === 'PF_TYPE_LITERAL'
  ? { settles: true, time: 0, value: +inp.m_flLiteralValue || 0 } : { settles: false, time: 0, value: 0 });

// particles.dll 63babcbf: C_OP_ContinuousEmitter (vtable at RTTI C_OP_ContinuousEmitter) emit slot 34 0x180106ca0,
// class init slot 6 0x180104bd0 (m_flEmissionScale zeroed when the definition's m_nBehaviorVersion > 1, clamped >= 0;
// snapshot CP -1..64; +0x676 / +0x678 / +0x677 = the rate settles / at time / not to <= 0), state slot 11 0x180104e40
// {accumulated, emitted, start -1, duration, ref time, active 1, force-last}, restart slot 21 0x180104e60 (nothing
// when the duration is 0 and the rate does not settle to <= 0; else zeroes the counts and re-reads start and
// duration with ref time = now). Per frame: start = ref + m_flStartTime, none before it; rate = max(0, strength *
// m_flEmitRate), times (highest CP + 1) * m_flEmissionScale, or with m_flScalePerParentParticle > 0 times that times
// the parent's particle count (that alone without a parent), times the snapshot's count when m_nSnapshotControlPoint
// >= 0 (0 without one). It emits while time - dt <= start + duration (duration 0: forever), over the window
// [time - dt, time] clamped to [start, start + duration] (and to dt); accumulated += rate * window,
// n = floor(accumulated + 0.001) (DAT_1805341d0) - emitted, at least 1 on the first frame with
// m_bForceEmitOnFirstUpdate, capped by m_nLimitPerUpdate; emitted += n before the capacity clamp. Creation times
// step evenly: start of window + step * (k + 1), clamped to its end. The fade-out test of 0x180106ca0 is system.js
// runStrength (strength 0 past m_flOpEndFadeOutTime). UNSETTLED: m_bInitFromKilledParentParticles (the killed-parent
// path, coll+0xa0) is reported and emits nothing; coll+0x944 (highest CP index) is the runtime's maxCp; the last
// update (StopEmission slot 36, m_bForceEmitOnLastUpdate) does not run: system.js skips stopped emitters.
const continuous = {
  evidence: 'RE',
  emit(fn, c, strength, st) {
    if (!st.init) Object.assign(st, { init: true, acc: 0, emitted: 0, start: -1, dur: 0, ref: refTime(c), active: true, forceLast: false });
    const settle = settleOf(fn.m_flEmitRate);
    const live = !(settle.settles && settle.value <= 0);
    const dur = ev(fn.m_flEmissionDuration, c);
    st.dur = dur;
    const win = !live && dur !== 0 ? Math.min(settle.time, dur) : !live ? settle.time : dur;
    const start = st.ref + ev(fn.m_flStartTime, c);
    st.start = start;
    if (start > c.time) return null;
    st.done = dur !== 0 && c.time - c.dt > dur + start;
    let rate = Math.max(0, strength * ev(fn.m_flEmitRate, c));
    if (!(rate > 0)) return null;
    if (fn.m_bInitFromKilledParentParticles) { report(c, 'C_OP_ContinuousEmitter m_bInitFromKilledParentParticles not implemented'); return null; }
    const perParent = +fn.m_flScalePerParentParticle || 0;
    const scale = (c.def.m_nBehaviorVersion | 0) > 1 ? 0 : Math.max(0, +fn.m_flEmissionScale || 0);
    if (perParent <= 0) { if (scale > 0) rate *= ((c.maxCp ?? 0) + 1) * scale; }
    else rate *= c.parent ? c.parent.count * perParent : perParent;
    const snapCp = fn.m_nSnapshotControlPoint < 0 ? -1 : Math.min(64, fn.m_nSnapshotControlPoint | 0);
    if (snapCp >= 0) {
      if (fn.m_strSnapshotSubset) report(c, 'C_OP_ContinuousEmitter m_strSnapshotSubset not implemented (whole snapshot)');
      const snap = cpSnapshot(c, snapCp);
      rate *= snap ? snap.count : 0;
    }
    if (!(rate > 0) || !(st.active || st.forceLast) || c.time === -FLT_MAX) return null;
    if (start !== -1) {
      if (!(dur === 0 || c.time - c.dt <= dur + start)) return null;
      if (!(!settle.settles || c.time <= settle.time + start || live)) return null;
    }
    let lo = c.time - c.dt, hi = c.time;
    if (dur !== 0 || !live) { lo = Math.max(lo, start); hi = Math.min(hi, start + win); }
    const span = Math.min(hi - lo, c.dt);
    st.acc += Math.max(0, rate * span);
    let total = Math.floor(st.acc + 0.001);
    if (total >= 9.223372036854776e18) total -= 9.223372036854776e18; // DAT_180534358
    let n = Math.max(0, total - st.emitted);
    if (fn.m_bForceEmitOnFirstUpdate && c.time - c.dt === 0 && n < 1) n = 1;
    if (st.forceLast) { st.forceLast = false; if (n < 1) n = 1; }
    if (fn.m_nLimitPerUpdate > 0 && fn.m_nLimitPerUpdate <= n) n = fn.m_nLimitPerUpdate | 0;
    if (n < 1) return null;
    st.emitted += n;
    n = Math.min(n, c.capacity - c.count);
    if (n <= 0) return null;
    const step = span / n, ages = new Array(n);
    for (let k = 0, t = lo + step; k < n; k++, t += step) ages[k] = c.time - Math.min(t, hi);
    return ages;
  },
  restart(fn, c, st) {
    if (!st.init) return;
    if (st.dur === 0 && !(settleOf(fn.m_flEmitRate).settles && settleOf(fn.m_flEmitRate).value <= 0)) return;
    st.acc = 0; st.emitted = 0; st.ref = c.time; st.done = false;
  },
};

// particles.dll 63babcbf: C_OP_InstantaneousEmitter emit slot 34 0x1801046f0, its count step FUN_180103880, class
// init slot 6 0x180102cf0 (m_nMaxEmittedPerFrame < 0 -> min(20000, the definition's particle limit); snapshot CP
// -1..64), state slot 11 0x1801036c0 {remaining, count, snapshot index, resolved, start -1, ref time, active}, restart
// slot 21 0x1801036f0 (ref time = now). Count step, once per start (resolved): start = ref + m_flStartTime; from then
// on, without a snapshot CP, n = m_nParticlesToEmit * (m_flParentParticleScale != -1 and a parent: the parent's
// count * that scale); with one, the snapshot's count, or, when the snapshot has a creation-time stream, the entries
// up to now - ref (emitted over several frames). Emit: none before start; min(remaining, per-frame cap) leaves
// `remaining`, int(that * strength) clamped to the free capacity is added (coll+0x8c); creation time = start (+ the
// snapshot's creation time of each entry). UNSETTLED: m_flInitFromKilledParentParticles (reported, emits nothing);
// the base restart call (vtable +0x2c0) is taken to clear `resolved`; the 100000 cap (definition +0x334) is not read.
const instantaneous = {
  evidence: 'RE',
  emit(fn, c, strength, st) {
    if (!st.init) Object.assign(st, { init: true, remaining: 0, n: 0, idx: 0, resolved: false, start: -1, ref: refTime(c), active: true });
    if (!st.active) return null;
    if (fn.m_flInitFromKilledParentParticles > 0) { report(c, 'C_OP_InstantaneousEmitter m_flInitFromKilledParentParticles not implemented'); return null; }
    const snapCp = fn.m_nSnapshotControlPoint < 0 ? -1 : Math.min(64, fn.m_nSnapshotControlPoint | 0);
    const snap = snapCp >= 0 ? cpSnapshot(c, snapCp) : null;
    const times = snapshotStream(snap, CREATION, attrType(CREATION));
    st.start = st.ref + ev(fn.m_flStartTime, c);
    if (st.start <= c.time && !st.resolved) {
      if (snapCp < 0) {
        let scale = 1;
        if (c.parent) { const p = ev(fn.m_flParentParticleScale, c); if (p !== -1) scale = c.parent.count * p; }
        st.n = Math.max(0, Math.trunc(scale * ev(fn.m_nParticlesToEmit, c)));
        st.remaining = st.n; st.resolved = true;
      } else {
        if (fn.m_strSnapshotSubset) report(c, 'C_OP_InstantaneousEmitter m_strSnapshotSubset not implemented (whole snapshot)');
        const count = snap ? snap.count : 0;
        if (times) {
          let k = st.idx, added = 0;
          while (k < count && !(c.time - st.ref < times[k])) { k++; added++; }
          if (st.idx < count) { st.remaining += added; st.resolved = false; } else { st.remaining = 0; st.resolved = true; }
        } else { st.remaining = count; st.resolved = true; }
      }
    }
    st.done = st.resolved && st.remaining <= 0;
    if (st.start > c.time || st.remaining === 0) return null;
    const cap = fn.m_nMaxEmittedPerFrame >= 0 ? fn.m_nMaxEmittedPerFrame : Math.min(20000, c.capacity);
    const n = Math.min(st.remaining, cap);
    st.remaining -= n;
    st.done = st.resolved && st.remaining <= 0;
    const m = Math.min(Math.trunc(n * strength), c.capacity - c.count);
    if (m < 1) return null;
    const ages = new Array(m);
    for (let k = 0; k < m; k++) ages[k] = c.time - (st.start + (times ? times[st.idx++] : 0));
    return ages;
  },
  restart(fn, c, st) {
    if (!st.init) return;
    st.ref = c.time; st.resolved = false; st.remaining = 0; st.idx = 0; st.done = false;
  },
};

// particles.dll 63babcbf: C_OP_RestartAfterDuration Operate slot 34 0x1801f5080, class init slot 6 0x1801f4fe0
// (m_nCP -1..64, m_nCPField -1..2), state slot 11 0x1801f5030 {last restart 0, duration lerp(min, max, T[c914 +
// c910++])}. Unless coll+0x8c1 & 2: duration *= CP m_nCP's position component m_nCPField (when both >= 0); once
// last + duration < time the collection restarts (0x18003ffb0 mode 0), or with m_bOnlyChildren every child whose
// definition m_nGroupID (+0x260) equals m_nChildGroupID; then last = time and a new duration is drawn.
// UNSETTLED: the 0x8c1 & 2 flag (taken clear).
const restartAfterDuration = {
  evidence: 'RE',
  op(fn, c, _s, st) {
    const draw = () => fn.m_flDurationMin + (fn.m_flDurationMax - fn.m_flDurationMin) * T(c, c.rnd.offset + c.rnd.counter++);
    if (st.last === undefined) { st.last = 0; st.d = draw(); }
    let d = st.d;
    const cp = clamp(fn.m_nCP | 0, -1, 64), field = clamp(fn.m_nCPField | 0, -1, 2);
    if (cp >= 0 && field >= 0) d *= getCp(c, cp).position[field];
    if (!(st.last + d < c.time)) return;
    if (!fn.m_bOnlyChildren) rearm(c);
    else for (const k of c.children) if ((k.def.m_nGroupID | 0) === (fn.m_nChildGroupID | 0)) rearm(k);
    st.last = c.time;
    st.d = draw();
  },
};

export const ported_emitters = {
  C_OP_ContinuousEmitter: continuous,
  C_OP_InstantaneousEmitter: instantaneous,
  C_OP_RestartAfterDuration: restartAfterDuration,
};
