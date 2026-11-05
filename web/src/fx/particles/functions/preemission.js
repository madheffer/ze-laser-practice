// Pre-emission operators: run once per step before the emitters, and write control points.
import { applyMap, evalFloat } from '../inputs.js';
import {
  add, clamp, cross, getCp, len, mul, norm, report, setCpField, setCpOrientation, setCpPosition, sub, vec3, isZero,
  frameFromNormal,
} from './common.js';


// One world trace through the stage's callback: opts.trace(from, dir, length) -> { hit, position,
// normal } | null. A miss ends at from + dir*length with fraction 1. UNSETTLED: the normal a miss
// carries; taken as zero.
const trace = (c, from, dir, length) => {
  const r = c.sys.opts.trace ? c.sys.opts.trace(from.slice(), dir.slice(), length) : null;
  if (r && r.hit) {
    const pos = vec3(r.position);
    return { hit: true, pos, normal: vec3(r.normal, [0, 0, 0]), fraction: length > 0 ? len(sub(pos, from)) / length : 0 };
  }
  return { hit: false, pos: add(from, mul(dir, length)), normal: [0, 0, 0], fraction: 1 };
};

const rootOf = (c) => { let r = c; while (r.parent) r = r.parent; return r; };

export const preemission = {
  // RE §11 C_OP_SetControlPointToPlayer (0x1802811e0; client CParticleSystemQuery 0x180a47d10,
  // 0x180a47ac0). The player comes from opts.player() -> { origin, center, eyes, forward, left, up }
  // (eye frame). Without that callback the operator leaves the CP to the stage.
  C_OP_SetControlPointToPlayer: {
    evidence: 'RE',
    pre(fn, c) {
      const pl = c.sys.opts.player ? c.sys.opts.player() : null;
      if (!pl) { report(c, 'C_OP_SetControlPointToPlayer has no opts.player; the stage sets the CP'); return; }
      const mode = fn.m_nPosition;
      // ABS_ORIGIN, WORLDSPACE_CENTER, EYES; PARTICLE_FLASHLIGHT and anything else read (0,0,0).
      const pos = mode === 'PARTICLE_ABS_ORIGIN' ? vec3(pl.origin) : mode === 'PARTICLE_WORLDSPACE_CENTER' ? vec3(pl.center)
        : mode === 'PARTICLE_EYES' ? vec3(pl.eyes) : [0, 0, 0];
      const cp = fn.m_nCP1 | 0;
      setCpPosition(c, cp, add(pos, vec3(fn.m_vecCP1Pos)));
      // The radius out-parameter is never written, so FLASHLIGHT sets the radius field to 0.
      if (mode === 'PARTICLE_FLASHLIGHT') setCpField(c, fn.m_nRadiusCP | 0, fn.m_nRadiusCPField | 0, 0);
      let f = vec3(pl.forward, [1, 0, 0]), l = vec3(pl.left, [0, 1, 0]), u = vec3(pl.up, [0, 0, 1]);
      if (!fn.m_bOrientToEyes) {
        // Re-based on world up: heading kept, pitch and roll dropped (0x181748070). UNSETTLED in detail.
        f = norm([f[0], f[1], 0]);
        if (isZero(f)) f = [1, 0, 0];
        u = [0, 0, 1];
        l = cross(u, f);
      }
      setCpOrientation(c, cp, f, l, u);
    },
  },

  // RE §11 C_OP_SetControlPointToImpactPoint (0x180283f50).
  C_OP_SetControlPointToImpactPoint: {
    evidence: 'RE',
    pre(fn, c, _s, st) {
      // At most once per m_flUpdateRate; a negative rate runs once. The next-update time starts at 0
      // (a zeroed instance context; UNSETTLED).
      if (c.time < (st.next ?? 0)) return;
      st.next = fn.m_flUpdateRate >= 0 ? c.time + fn.m_flUpdateRate : Infinity;
      const cin = getCp(c, fn.m_nCPIn | 0);
      const traceDir = vec3(fn.m_vecTraceDir);
      const dir = isZero(traceDir) ? cin.forward.slice() : traceDir;
      const length = evalFloat(fn.m_flTraceLength, c, -1);
      const so = +fn.m_flStartOffset || 0;
      let r;
      if (fn.m_bTraceToClosestSurface) {
        // Six axis traces from the CP (+StartOffset along each), the closest hit kept (table 0x1805c0450).
        for (const ax of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const t = trace(c, add(cin.position, mul(ax, so)), ax, length);
          if (t.hit && (!r || len(sub(t.pos, cin.position)) < len(sub(r.pos, cin.position)))) r = { ...t, dir: ax };
        }
        r ||= { hit: false, pos: cin.position.slice(), normal: [0, 0, 0], dir };
      } else {
        r = { ...trace(c, add(cin.position, mul(dir, so)), dir, length), dir };
      }
      const out = fn.m_nCPOut | 0;
      if (r.hit || fn.m_bSetToEndpoint) {
        setCpPosition(c, out, sub(r.pos, mul(r.dir, +fn.m_flOffset || 0)));
        const [f, l, u] = frameFromNormal(r.normal);
        setCpOrientation(c, out, f, l, u);
      } else if (!isZero(traceDir)) {
        const [f, l, u] = frameFromNormal(mul(traceDir, -1));
        setCpOrientation(c, out, f, l, u);
      }
    },
  },

  // RE §11 C_OP_DistanceBetweenCPsToCP (0x180280be0, CP field write 0x1802744e0).
  C_OP_DistanceBetweenCPsToCP: {
    evidence: 'RE',
    pre(fn, c, _s, st) {
      if (fn.m_bSetOnce && st.done) return;
      st.done = true;
      const target = fn.m_nSetParent === 'PARTICLE_SET_PARENT_IMMEDIATE' ? c.parent || c
        : fn.m_nSetParent === 'PARTICLE_SET_PARENT_ROOT' ? rootOf(c) : c;
      const S = getCp(c, fn.m_nStartCP | 0).position, E = getCp(c, fn.m_nEndCP | 0).position;
      let d = len(sub(S, E));
      if (fn.m_bLOS) {
        // The code normalises the END POSITION vector, not end - start.
        const mt = fn.m_flMaxTraceLength;
        const to = mt !== -1 && mt < d ? add(S, mul(norm(E), mt)) : E;
        const L = len(sub(to, S));
        const t = trace(c, S, L > 0 ? mul(sub(to, S), 1 / L) : [1, 0, 0], L);
        if (t.fraction !== 1) d = d * t.fraction * fn.m_flLOSScale;
      }
      const i0 = fn.m_flInputMin, i1 = fn.m_flInputMax, o0 = fn.m_flOutputMin, o1 = fn.m_flOutputMax;
      const out = i0 === i1 ? (d - i1 < 0 ? o0 : o1) : o0 + clamp((d - i0) / (i1 - i0), 0, 1) * (o1 - o0);
      setCpField(target, fn.m_nOutputCP | 0, fn.m_nOutputCPField | 0, out);
    },
  },

  // RE §11 C_OP_SetControlPointFieldToScalarExpression (0x180277070).
  C_OP_SetControlPointFieldToScalarExpression: {
    evidence: 'RE',
    pre(fn, c) {
      const a = evalFloat(fn.m_flInput1, c, -1), b = evalFloat(fn.m_flInput2, c, -1);
      let r;
      switch (fn.m_nExpression) {
        case 'SCALAR_EXPRESSION_ADD': r = a + b; break;
        case 'SCALAR_EXPRESSION_SUBTRACT': r = a - b; break;
        case 'SCALAR_EXPRESSION_MUL': r = a * b; break;
        case 'SCALAR_EXPRESSION_DIVIDE': r = b === 0 ? 0 : a / b; break;
        case 'SCALAR_EXPRESSION_INPUT_1': r = a; break;
        case 'SCALAR_EXPRESSION_MIN': r = a < b ? a : b; break; // minss
        case 'SCALAR_EXPRESSION_MAX': r = a > b ? a : b; break; // maxss
        case 'SCALAR_EXPRESSION_MOD': r = a % b; break; // fmodf
        case 'SCALAR_EXPRESSION_EQUAL': r = a === b ? 1 : 0; break;
        case 'SCALAR_EXPRESSION_GT': r = a > b ? 1 : 0; break;
        case 'SCALAR_EXPRESSION_LT': r = a < b ? 1 : 0; break;
        default: r = 0;
      }
      // m_flOutputRemap applies its map type alone, as for float inputs.
      r = applyMap(fn.m_flOutputRemap || {}, r);
      const cp = fn.m_nOutputCP | 0, field = fn.m_nOutVectorField | 0;
      const i = evalFloat(fn.m_flInterpolation, c, -1);
      if (i !== 1) {
        const cur = field >= 0 && field <= 2 ? getCp(c, cp).position[field] : 0;
        r = cur + clamp(i, 0, 1) * (r - cur);
      }
      setCpField(c, cp, field, r);
    },
  },
};
