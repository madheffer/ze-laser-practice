// Operators: run every step over every live particle, with the run strength from system.js.
import { evalFloat, evalVec } from '../inputs.js';
import {
  A, ANGLE_ATTRS, FLT_EPSILON, RAD, VECTOR_ATTRS, add, applySetMethod, attrIndex, clamp, cross, drawConstant, getCp,
  getF, getInitF, getInitV, getV, kill, len, lerp3, mul, norm, outputClamp, report, sat, setF, setV, sub, toLocal,
  toWorld, transformOf, vectorAngles,
} from './common.js';

const age = (c, i) => c.time - c.attr[A.CREATION][i];
const nage = (c, i) => { const l = c.attr[A.LIFE][i]; return l <= 0 ? 0 : age(c, i) / l; };
const smooth = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const num = (v, c) => (typeof v === 'number' ? v : evalFloat(v, c, -1));

export const operators = {
  // RE §11 C_OP_Decay (0x1801d0f70): kill when lifetime <= 0 or lifetime <= age.
  C_OP_Decay: {
    evidence: 'RE',
    op(fn, c) {
      if (fn.m_bRopeDecay) report(c, 'C_OP_Decay m_bRopeDecay variant is not decoded (plain decay used)');
      for (let i = 0; i < c.count; i++) { const l = c.attr[A.LIFE][i]; if (l <= 0 || l <= age(c, i)) kill(c, i); }
    },
  },

  // RE §11 C_OP_AlphaDecay (0x1801d3330): kill when alpha*alphaAlternate <= m_flMinAlpha + FLT_EPSILON.
  C_OP_AlphaDecay: {
    evidence: 'RE',
    op(fn, c) {
      const lim = (+fn.m_flMinAlpha || 0) + FLT_EPSILON;
      for (let i = 0; i < c.count; i++) if (c.attr[A.ALPHA][i] * c.attr[A.ALPHA2][i] <= lim) kill(c, i);
    },
  },

  // RE §11 C_OP_SetFloat (0x18020bd30, init 0x18020bbc0).
  C_OP_SetFloat: {
    evidence: 'RE',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nOutputField, A.RADIUS);
      if (VECTOR_ATTRS.has(out) || !c.attr[out]) { report(c, `C_OP_SetFloat output ${out} is not a scalar stream`); return; }
      const m = fn.m_nSetMethod;
      const [lo, hi] = outputClamp(out);
      const k = ANGLE_ATTRS.has(out) && m !== 'PARTICLE_SET_SCALE_INITIAL_VALUE' && m !== 'PARTICLE_SET_SCALE_CURRENT_VALUE' ? RAD : 1;
      for (let i = 0; i < c.count; i++) {
        const v = evalFloat(fn.m_InputValue, c, i);
        const L = clamp(evalFloat(fn.m_Lerp, c, i), 0, 1);
        const cur = c.attr[out][i], init = c.init[out][i];
        let o;
        switch (m) {
          case 'PARTICLE_SET_RAMP_CURRENT_VALUE': c.attr[out][i] = clamp(cur + L * v * (s * k * c.dt), lo, hi); continue;
          case 'PARTICLE_SET_SCALE_INITIAL_VALUE': o = clamp(cur + L * (k * v * init - cur), lo, hi); if (s < 1) o = o * s + init * (1 - s); break;
          case 'PARTICLE_SET_ADD_TO_INITIAL_VALUE': o = clamp(cur + L * ((k * v + init) - cur), lo, hi); if (s < 1) o = o * s + init * (1 - s); break;
          case 'PARTICLE_SET_SCALE_CURRENT_VALUE': o = clamp(cur + L * (k * v * cur - cur), lo, hi); if (s < 1) o = o * s + cur * (1 - s); break;
          case 'PARTICLE_SET_ADD_TO_CURRENT_VALUE': o = clamp(cur + L * ((k * v + cur) - cur), lo, hi); if (s < 1) o = o * s + cur * (1 - s); break;
          default: o = clamp(cur + L * (k * v - cur), lo, hi); if (s < 1) o = o * s + cur * (1 - s);
        }
        c.attr[out][i] = o;
      }
    },
  },

  // RE §11 C_OP_SetVectorAttributeToVectorExpression (0x180203ec0).
  C_OP_SetVectorAttributeToVectorExpression: {
    evidence: 'RE',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nOutputField, A.NORMAL);
      if (!VECTOR_ATTRS.has(out)) { report(c, `C_OP_SetVectorAttributeToVectorExpression output ${out} is not a vector stream`); return; }
      // Colour/alpha outputs clamp to per-op bounds set at init (op+0x1120/+0x1150). UNSETTLED: the
      // bounds; [0,1] here, as C_OP_SetFloat uses for alpha.
      const clampOut = out === A.COLOR || out === A.GLOW_RGB;
      // DIVIDE: a tiny |b| has FLT_EPSILON OR-ed into its bits, so b = 0 reads 1.19e-7.
      const guard = (b) => (Math.abs(b) < 1.1754944e-38 ? (b < 0 ? -FLT_EPSILON : FLT_EPSILON) : b);
      for (let i = 0; i < c.count; i++) {
        const a = evalVec(fn.m_vInput1, c, i), b = evalVec(fn.m_vInput2, c, i);
        let r;
        switch (fn.m_nExpression) {
          case 'VECTOR_EXPRESSION_SUBTRACT': r = sub(a, b); break;
          case 'VECTOR_EXPRESSION_MUL': r = [a[0] * b[0], a[1] * b[1], a[2] * b[2]]; break;
          // rcpps plus one Newton step: within float rounding of a/b, taken as exact. UNSETTLED: last bits.
          case 'VECTOR_EXPRESSION_DIVIDE': r = [a[0] / guard(b[0]), a[1] / guard(b[1]), a[2] / guard(b[2])]; break;
          case 'VECTOR_EXPRESSION_INPUT_1': r = a; break;
          case 'VECTOR_EXPRESSION_MIN': r = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])]; break;
          case 'VECTOR_EXPRESSION_MAX': r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])]; break;
          case 'VECTOR_EXPRESSION_CROSSPRODUCT': r = cross(a, b); break;
          case 'VECTOR_EXPRESSION_LERP': r = lerp3(a, b, clamp(evalFloat(fn.m_flLerp, c, i), 0, 1)); break;
          case 'VECTOR_EXPRESSION_ADD': r = add(a, b); break;
          default: r = [0, 0, 0];
        }
        r = mul(r, s); // every expression times the operator strength, before the set method
        const cur = getV(c, out, i), init = getInitV(c, out, i);
        r = [0, 1, 2].map((k) => applySetMethod(fn.m_nSetMethod, r[k], init[k], cur[k], c.dt));
        if (clampOut) r = r.map(sat);
        // rsqrtps without a Newton step: about 12 bits. UNSETTLED: those bits; exact here.
        if (fn.m_bNormalizedOutput) r = norm(r);
        setV(c, out, i, r);
      }
    },
  },

  // RE §11 C_OP_PositionLock (0x1801d8e90), default path (m_flStartTime_min >= 1). UNSETTLED (RE §11 #2): the
  // m_bLockRot carry is applied as p' = P + Rcur*Rprev^-1*(p - Pprev) (VRF cross-check), and the age-window path
  // is reported and runs as the default path.
  C_OP_PositionLock: {
    evidence: 'RE',
    op(fn, c, s, st) {
      const t = fn.m_TransformInput || {};
      if ((t.m_nType ?? 'PT_TYPE_CONTROL_POINT') === 'PT_TYPE_CONTROL_POINT' && !getCp(c, t.m_nControlPoint | 0).set) return;
      const cp = transformOf(c, t);
      const P = cp.position;
      if (!st.init) { st.init = true; st.P = P.slice(); st.f = cp.forward.slice(); st.l = cp.left.slice(); st.u = cp.up.slice(); }
      if (fn.m_flStartTime_min < 1) report(c, 'C_OP_PositionLock age-window path is UNSETTLED (default path used)');
      const delta = mul(sub(P, st.P), s);
      const scale = evalVec(fn.m_vecScale, c, -1);
      const out = attrIndex(fn.m_nFieldOutput, A.POSITION), outPrev = attrIndex(fn.m_nFieldOutputPrev, A.PREV);
      const range = +fn.m_flRange || 0;
      const rb = range !== 0 ? evalFloat(fn.m_flRangeBias, c, -1) : 0;
      const prevFrame = { forward: st.f, left: st.l, up: st.u };
      const rot = (v) => toWorld(cp, toLocal(prevFrame, v)); // Rcur * Rprev^-1
      for (let i = 0; i < c.count; i++) {
        const f = c.dt > 0 ? Math.min(age(c, i), c.dt) / c.dt : 1;
        if (f <= 0) continue;
        let d = mul(delta, f);
        const pos = getV(c, out, i);
        if (range !== 0) {
          const g = Math.min(1, len(sub(add(pos, d), P)) / range);
          // Schlick bias of g by m_flRangeBias: b <= 0 -> 0, b >= 1 -> 1.
          const bg = rb <= 0 ? 0 : rb >= 1 ? 1 : g / ((1 - g) * (1 / rb - 2) + 1);
          d = mul(d, 1 - bg);
        }
        d = [d[0] * scale[0], d[1] * scale[1], d[2] * scale[2]];
        const movePrev = fn.m_flPrevPosScale !== 0 && outPrev !== A.NONE;
        if (!fn.m_bLockRot) {
          setV(c, out, i, add(pos, d));
          if (movePrev) setV(c, outPrev, i, add(getV(c, outPrev, i), mul(d, fn.m_flPrevPosScale)));
        } else {
          const w = s * f;
          const target = add(st.P, add(rot(sub(pos, st.P)), d));
          setV(c, out, i, add(pos, mul(sub(target, pos), w)));
          if (movePrev) {
            const q = getV(c, outPrev, i);
            const tq = add(st.P, add(rot(sub(q, st.P)), d));
            setV(c, outPrev, i, add(q, mul(sub(tq, q), w * fn.m_flPrevPosScale)));
          }
        }
      }
      st.P = P.slice(); st.f = cp.forward.slice(); st.l = cp.left.slice(); st.u = cp.up.slice();
    },
  },

  // VRF cross-check, UNSETTLED: radius = initial radius * lerp(start, end, t) over the window.
  C_OP_InterpolateRadius: {
    evidence: 'VRF',
    op(fn, c) {
      const t0 = +fn.m_flStartTime || 0, t1 = +fn.m_flEndTime;
      if (!(t1 > t0)) return;
      const bs = fn.m_flBias === 0 ? 0.5 : +fn.m_flBias;
      for (let i = 0; i < c.count; i++) {
        const life = c.attr[A.LIFE][i];
        if (life <= 0) continue;
        const t = nage(c, i), ff = c.dt / life;
        const wEnd = life * (t1 - t0) <= c.dt ? t0 + ff : t1;
        if (t < t0 || t > ff + wEnd) continue;
        const a = num(fn.m_flStartScale, c), b = num(fn.m_flEndScale, c);
        let u = (t - t0) / (t1 - t0);
        if (fn.m_bEaseInAndOut) u = u * u * (3 - 2 * u);
        else if (bs !== 0.5) u = bs <= 0 ? 0 : bs >= 1 ? 1 : u / ((1 - u) * (1 / bs - 2) + 1); // Schlick on m_flBias
        c.attr[A.RADIUS][i] = getInitF(c, A.RADIUS, i) * clamp(a + (b - a) * u, Math.min(a, b), Math.max(a, b));
      }
    },
  },

  // VRF cross-check, UNSETTLED: smoothstep fade in and out, killed past its lifetime.
  C_OP_FadeAndKill: {
    evidence: 'VRF',
    op(fn, c, s) {
      for (let i = 0; i < c.count; i++) {
        if (c.attr[A.LIFE][i] < age(c, i)) { kill(c, i); continue; }
        const t = nage(c, i), a0 = getInitF(c, A.ALPHA, i);
        let a = c.attr[A.ALPHA][i];
        if (t >= fn.m_flStartFadeInTime && t < fn.m_flEndFadeInTime) a = a0 * (fn.m_flStartAlpha + (1 - fn.m_flStartAlpha) * smooth(fn.m_flStartFadeInTime, fn.m_flEndFadeInTime, t));
        if (t >= fn.m_flStartFadeOutTime && t < fn.m_flEndFadeOutTime) a = a0 * (1 + (fn.m_flEndAlpha - 1) * smooth(fn.m_flStartFadeOutTime, fn.m_flEndFadeOutTime, t));
        c.attr[A.ALPHA][i] = c.attr[A.ALPHA][i] + (a - c.attr[A.ALPHA][i]) * s;
      }
    },
  },

  // VRF cross-check, UNSETTLED.
  C_OP_ColorInterpolate: {
    evidence: 'VRF',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nFieldOutput, A.COLOR);
      const fade = (fn.m_ColorFade || [255, 255, 255]).map((x) => x / 255);
      for (let i = 0; i < c.count; i++) {
        const t = nage(c, i);
        if (t < fn.m_flFadeStartTime || t > fn.m_flFadeEndTime) continue;
        let u = sat((t - fn.m_flFadeStartTime) / (fn.m_flFadeEndTime - fn.m_flFadeStartTime));
        if (fn.m_bEaseInOut) u = u * u * (3 - 2 * u);
        const c0 = getInitV(c, A.COLOR, i);
        setV(c, out, i, lerp3(c0, lerp3(c0, fade, u), s));
      }
    },
  },

  // VRF cross-check, UNSETTLED (C_OP_FadeIn is VRF's FadeInRandom).
  C_OP_FadeIn: {
    evidence: 'VRF',
    op(fn, c) {
      for (let i = 0; i < c.count; i++) {
        const ft = fadeTime(fn, c, i, 'm_flFadeInTime');
        const t = fn.m_bProportional ? nage(c, i) : age(c, i);
        if (t < ft) c.attr[A.ALPHA][i] = smooth(0, ft, t) * getInitF(c, A.ALPHA, i);
      }
    },
  },

  // VRF cross-check, UNSETTLED (VRF's FadeOutRandom; m_flFadeBias is read and not applied there).
  C_OP_FadeOut: {
    evidence: 'VRF',
    op(fn, c) {
      for (let i = 0; i < c.count; i++) {
        const ft = fadeTime(fn, c, i, 'm_flFadeOutTime');
        const left = fn.m_bProportional ? 1 - nage(c, i) : c.attr[A.LIFE][i] - age(c, i);
        if (left >= ft) continue;
        let u = sat(1 - left / ft);
        if (fn.m_bEaseInAndOut) u = smooth(0, 1, u);
        c.attr[A.ALPHA][i] = (1 - u) * getInitF(c, A.ALPHA, i);
      }
    },
  },

  // VRF cross-check, UNSETTLED.
  C_OP_FadeInSimple: {
    evidence: 'VRF',
    op(fn, c) {
      const out = attrIndex(fn.m_nFieldOutput, A.ALPHA);
      for (let i = 0; i < c.count; i++) { const t = nage(c, i); if (t <= fn.m_flFadeInTime) setF(c, out, i, (t / fn.m_flFadeInTime) * getInitF(c, A.ALPHA, i)); }
    },
  },

  // VRF cross-check, UNSETTLED.
  C_OP_FadeOutSimple: {
    evidence: 'VRF',
    op(fn, c) {
      const out = attrIndex(fn.m_nFieldOutput, A.ALPHA);
      for (let i = 0; i < c.count; i++) { const l = 1 - nage(c, i); if (l <= fn.m_flFadeOutTime) setF(c, out, i, (l / fn.m_flFadeOutTime) * getInitF(c, A.ALPHA, i)); }
    },
  },

  // VRF cross-check, UNSETTLED: sin(pi*x) oscillation, per-particle draws fixed by particle ID.
  C_OP_OscillateScalar: {
    evidence: 'VRF',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nField, A.ALPHA);
      const unit = out === A.ALPHA || out === A.ALPHA2;
      const sys = fn.m_flOscMult * c.time + fn.m_flOscAdd;
      for (let i = 0; i < c.count; i++) {
        if (c.attr[A.LIFE][i] <= 0) continue;
        const pid = c.attr[A.ID][i], rnd = (k, lo, hi) => lo + (hi - lo) * drawConstant(c, k, pid);
        const w = fn.m_bProportionalOp ? nage(c, i) : age(c, i);
        if (w < rnd(11, fn.m_flStartTime_min, fn.m_flStartTime_max) || w >= rnd(12, fn.m_flEndTime_min, fn.m_flEndTime_max)) continue;
        const fq = rnd(0, fn.m_FrequencyMin, fn.m_FrequencyMax), rate = rnd(1, fn.m_RateMin, fn.m_RateMax);
        const d = Math.sin(Math.PI * (fn.m_bProportional ? nage(c, i) * fq * fn.m_flOscMult + fn.m_flOscAdd : fq * sys));
        const v = getF(c, out, i) + d * rate * s * c.dt;
        setF(c, out, i, unit ? sat(v) : v);
      }
    },
  },

  // VRF cross-check, UNSETTLED.
  C_OP_OscillateVector: {
    evidence: 'VRF',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nField, A.POSITION);
      if (!VECTOR_ATTRS.has(out)) { report(c, `C_OP_OscillateVector field ${out} is not a vector stream`); return; }
      const unit = out === A.COLOR || out === A.GLOW_RGB;
      const RO = [3, 7, 9], FO = [8, 12, 15];
      for (let i = 0; i < c.count; i++) {
        if (c.attr[A.LIFE][i] <= 0) continue;
        const pid = c.attr[A.ID][i], rnd = (k, lo, hi) => lo + (hi - lo) * drawConstant(c, k, pid);
        const w = fn.m_bProportionalOp ? nage(c, i) : age(c, i);
        if (w < rnd(11, fn.m_flStartTime_min, fn.m_flStartTime_max) || w >= rnd(12, fn.m_flEndTime_min, fn.m_flEndTime_max)) continue;
        const mult = evalFloat(fn.m_flOscMult, c, i), off = evalFloat(fn.m_flOscAdd, c, i);
        const sc = s * c.dt * evalFloat(fn.m_flRateScale, c, i);
        const val = [0, 1, 2].map((k) => {
          const rate = rnd(RO[k], fn.m_RateMin[k], fn.m_RateMax[k]), fq = rnd(FO[k], fn.m_FrequencyMin[k], fn.m_FrequencyMax[k]);
          const ph = fn.m_bProportional ? nage(c, i) * fq * mult + off : fq * (mult * c.time + off);
          return rate * sc * Math.sin(Math.PI * ph);
        });
        let v = add(getV(c, out, i), val);
        if (unit) v = v.map(sat);
        setV(c, out, i, v);
        if (fn.m_bOffset && out === A.POSITION) setV(c, A.PREV, i, add(getV(c, A.PREV, i), val));
      }
    },
  },

  // VRF cross-check, UNSETTLED: the collection re-arms its emitters every sampled duration.
  C_OP_RestartAfterDuration: {
    evidence: 'VRF',
    op(fn, c) {
      if (fn.m_bOnlyChildren) { report(c, 'C_OP_RestartAfterDuration m_bOnlyChildren not implemented'); return; }
      if (c.restartAt != null) return;
      let d = fn.m_flDurationMin + (fn.m_flDurationMax - fn.m_flDurationMin) * c.table[(c.rnd.offset + c.rnd.counter++) & 0xfff];
      if (fn.m_nCP >= 0 && fn.m_nCPField >= 0) d *= getCp(c, fn.m_nCP).position[fn.m_nCPField] ?? 1;
      c.restartAt = c.time + d;
    },
  },

  // VRF cross-check, UNSETTLED.
  C_OP_DampenToCP: {
    evidence: 'VRF',
    op(fn, c, s) {
      if (!(fn.m_flRange > 0)) return;
      const P = getCp(c, fn.m_nControlPointNumber | 0).position;
      for (let i = 0; i < c.count; i++) {
        const p = getV(c, A.POSITION, i), d = len(sub(p, P));
        if (d > fn.m_flRange) continue;
        const q = getV(c, A.PREV, i);
        const damped = add(q, mul(sub(p, q), Math.pow(d / fn.m_flRange, fn.m_flScale)));
        setV(c, A.POSITION, i, lerp3(p, damped, s));
      }
    },
  },

  // VRF cross-check, UNSETTLED: kills everything once the endcap has run m_flDecayTime.
  C_OP_EndCapTimedDecay: {
    evidence: 'VRF',
    op(fn, c) {
      if (!c.endcap.active || c.time - c.endcap.start <= evalFloat(fn.m_flDecayTime, c, -1)) return;
      for (let i = 0; i < c.count; i++) kill(c, i);
    },
  },

  // VRF cross-check, UNSETTLED.
  C_OP_RemapCPtoVector: {
    evidence: 'VRF',
    op(fn, c, s) {
      const out = attrIndex(fn.m_nFieldOutput, A.POSITION);
      if (!VECTOR_ATTRS.has(out)) return;
      if (fn.m_flStartTime >= 0 && fn.m_flEndTime >= 0 && (c.time < fn.m_flStartTime || c.time > fn.m_flEndTime)) return;
      let v = getCp(c, fn.m_nCPInput | 0).position;
      if (fn.m_nLocalSpaceCP >= 0) v = toWorld(getCp(c, fn.m_nLocalSpaceCP), v);
      const rm = (x, a, b, o0, o1) => (a === b ? (x >= b ? o1 : o0) : o0 + (o1 - o0) * sat((x - a) / (b - a)));
      const r = [0, 1, 2].map((k) => rm(v[k], fn.m_vInputMin[k], fn.m_vInputMax[k], fn.m_vOutputMin[k], fn.m_vOutputMax[k]));
      const w = (fn.m_flInterpRate > 0 ? sat(fn.m_flInterpRate * c.dt) : 1) * s;
      for (let i = 0; i < c.count; i++) {
        let x = r;
        if (fn.m_bOffset) x = add(x, getInitV(c, out, i));
        else if (fn.m_bAccelerate) x = add(getV(c, out, i), mul(x, c.dt));
        const cur = getV(c, out, i), init = getInitV(c, out, i);
        const tgt = [0, 1, 2].map((k) => applySetMethod(fn.m_nSetMethod, x[k], init[k], cur[k], c.dt));
        setV(c, out, i, lerp3(cur, tgt, w));
      }
    },
  },

  // VRF cross-check, UNSETTLED: the transform's forward as pitch/yaw (radians) plus m_vecRotation
  // degrees. The light renderer reads these as the particle's direction (RE §10).
  C_OP_RemapTransformOrientationToRotations: {
    evidence: 'VRF',
    op(fn, c) {
      if (fn.m_bUseQuat) report(c, 'C_OP_RemapTransformOrientationToRotations m_bUseQuat not implemented (forward path used)');
      const cp = transformOf(c, fn.m_TransformInput);
      const r = fn.m_vecRotation || [0, 0, 0];
      const ang = vectorAngles(cp.forward).map((x, k) => (x + r[k]) * Math.PI / 180);
      for (let i = 0; i < c.count; i++) {
        if (fn.m_bWriteNormal) { setV(c, A.NORMAL, i, cp.forward); continue; }
        c.attr[A.PITCH][i] = ang[0]; c.attr[A.YAW][i] = ang[1]; c.attr[A.ROLL][i] = ang[2];
      }
    },
  },
};

const fadeTime = (fn, c, i, k) => {
  const lo = fn[`${k}Min`], hi = fn[`${k}Max`];
  if (lo === hi) return lo;
  return lo + (hi - lo) * Math.pow(drawConstant(c, 0, c.attr[A.ID][i]), fn[`${k}Exp`] ?? 1);
};

