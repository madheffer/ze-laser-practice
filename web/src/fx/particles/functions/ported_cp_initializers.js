// Ported from CS2's particles.dll (tools/particles/PORTING.md), md5 63babcbf3245e56855a777134323e74a ("63babcbf").
// Initializers that read what sits at a control point: its model (C_INIT_ModelCull), its transform
// (C_INIT_RemapInitialTransformDirectionToRotation) and the lighting there (C_INIT_RandomColor's tint).
// Constants: DAT_180534344 = 255, DAT_1805341b8 = 0.5, DAT_180534200 = 1, DAT_180534170 = 0.0174532924,
// DAT_180534314 = 57.2957764, DAT_180534150 = 0.001, DAT_180534284 = pi (tools/particles/consts.py).
//
// Host contracts (ParticleSystem opts), both optional:
//  - opts.insideModel(cpIndex, points, { boundBox, hitboxSet, useBones }) -> null (no model at the CP) | false (the
//    query failed) | boolean[] (per point, inside the model's hitboxes / bounding box).
//  - opts.lighting(position) -> [r, g, b] 0..255, the light at a point (the collection's query object, coll+0x1d8
//    vtable +0x18).
import { A, DEG2RAD, attrIndex, clamp, dot, enumIndex, getCp, report, setV, transformOf, VECTOR_ATTRS } from './common.js';

const BLEND = ['PARTICLEBLEND_DEFAULT', 'PARTICLEBLEND_OVERLAY', 'PARTICLEBLEND_DARKEN', 'PARTICLEBLEND_LIGHTEN',
  'PARTICLEBLEND_MULTIPLY'];
const T = (c) => c.table[(c.rnd.offset + c.rnd.counter++) & 0xfff];
const byte = (v, k) => (Array.isArray(v) ? +v[k] : 255) | 0;

// MatrixAngles (FUN_18035e500) on the CP frame (columns forward, left, up): pitch = atan2(-f.z, |f.xy|), yaw =
// atan2(f.y, f.x), roll = atan2(l.z, u.z); |f.xy| <= 0.001 -> yaw = atan2(-l.x, l.y), roll 0. Degrees.
const frameAngles = (t) => {
  const f = t.forward, l = t.left, u = t.up, xy = Math.hypot(f[0], f[1]), D = 57.2957764;
  if (xy <= 0.001) return [Math.atan2(-f[2], xy) * D, Math.atan2(-l[0], l[1]) * D, 0];
  return [Math.atan2(-f[2], xy) * D, Math.atan2(f[1], f[0]) * D, Math.atan2(l[2], u[2]) * D];
};

// FUN_1801438f0: the tint colour. The light is the parent collection's (coll+0x28) when it last queried the same
// tint CP (parent+0xc0 == m_nTintCP, light parent+0xc4); else this collection's cached light, queried again at the
// CP position when this collection never queried (+0xc0 == -1) or the CP moved m_flUpdateThreshold or more from the
// position of the last query (kept in the initializer state). Per channel clamped to [m_TintMin, m_TintMax], then
// * m_flLightAmplification / 255. The query's result starts white (0xffffffff) and stays so without opts.lighting.
function tint(fn, c, st) {
  const cpi = fn.m_nTintCP | 0;
  let light;
  if (c.parent?.tint && c.parent.tint.cp === cpi) light = c.parent.tint.light;
  else {
    const t = (c.tint ||= { cp: -1, light: [255, 255, 255] });
    const p = getCp(c, clamp(cpi, 0, 63)).position, last = st.last || [0, 0, 0];
    const d = [p[0] - last[0], p[1] - last[1], p[2] - last[2]], th = +fn.m_flUpdateThreshold;
    if (th * th <= dot(d, d) || t.cp === -1) {
      const L = c.sys.opts.lighting ? c.sys.opts.lighting(p.slice()) : null;
      if (!c.sys.opts.lighting) report(c, 'C_INIT_RandomColor tint: no opts.lighting, the light reads white');
      t.light = L ? [0, 1, 2].map((k) => clamp(Math.round(+L[k] || 0), 0, 255)) : [255, 255, 255];
      t.cp = cpi;
      st.last = p.slice();
    }
    light = t.light;
  }
  const amp = +fn.m_flLightAmplification / 255;
  return [0, 1, 2].map((k) => Math.max(Math.min(light[k], byte(fn.m_TintMax, k)), byte(fn.m_TintMin, k)) * amp);
}

// FUN_180143570: blend the tint into the base colour, lerp by m_flTintPerc, clamp to at most 1.
const blend = (base, t, perc, mode) => [0, 1, 2].map((k) => {
  const b = base[k], x = t[k];
  const v = mode === 0 ? x : mode === 1 ? (x >= 0.5 ? 1 - 2 * (1 - b) * (1 - x) : 2 * b * x)
    : mode === 2 ? Math.min(b, x) : mode === 3 ? Math.max(b, x) : mode === 4 ? b * x : b;
  return Math.min(1, (v - b) * perc + b);
});

export const ported_cp_initializers = {
  // 63babcbf: C_INIT_RandomColor slot 34 0x180143c90, class init slot 6 0x180143830 (m_ColorMin / m_ColorMax bytes /
  // 255 at +0x1e8 / +0x1f4, m_flUpdateThreshold squared at +0x200), tint FUN_1801438f0, blend FUN_180143570.
  // Per particle: r = T[c914 + c910++], base = lerp(min, max, r) written to m_nFieldOutput; with m_flTintPerc != 0
  // the tint (computed once per call) blends in by m_nTintBlendMode.
  // UNSETTLED: the initializer state's first "last query position" (slot 11 0x180137d20, DAT_1804d2868) is taken as
  // the origin; the never-queried test forces the first query either way.
  C_INIT_RandomColor: {
    evidence: 'RE',
    init(fn, c, s, e, _k, st) {
      const out = attrIndex(fn.m_nFieldOutput, A.COLOR);
      if (!VECTOR_ATTRS.has(out)) { report(c, `C_INIT_RandomColor output ${out} is not a vector stream`); return; }
      const lo = [0, 1, 2].map((k) => byte(fn.m_ColorMin, k) / 255), hi = [0, 1, 2].map((k) => byte(fn.m_ColorMax, k) / 255);
      const perc = +fn.m_flTintPerc || 0;
      const t = perc !== 0 ? tint(fn, c, st) : null, mode = enumIndex(fn.m_nTintBlendMode, BLEND);
      for (let i = s; i < e; i++) {
        const r = T(c);
        const base = [0, 1, 2].map((k) => (hi[k] - lo[k]) * r + lo[k]);
        setV(c, out, i, t ? blend(base, t, perc, mode) : base);
      }
    },
  },

  // 63babcbf: C_INIT_RemapInitialTransformDirectionToRotation slot 34 0x1801615c0 (output mask slot 30: bit
  // m_nFieldOutput). One value for the whole batch, written raw (radians) to m_nFieldOutput:
  //  - behaviour version (definition +8) >= 7: m_flOffsetRot * DEG2RAD - angles[m_nComponent] * DEG2RAD, angles =
  //    MatrixAngles of the transform (FUN_180361000 quaternion -> matrix, FUN_18035e500), the transform from
  //    FUN_1800bad80 (CONTROL_POINT_RANGE through FUN_1800bb230);
  //  - older: m_flOffsetRot * DEG2RAD + atan2(v.y, v.x) (+ pi below version 4), v = the transform's rotation applied
  //    to the vector at 0x1805e4330.
  // UNSETTLED: 0x1805e4330 is runtime-initialised; read as (1, 0, 0), so v is the transform's forward. m_nComponent is
  // clamped to 0..2 (the game indexes the angle triple unchecked).
  C_INIT_RemapInitialTransformDirectionToRotation: {
    evidence: 'RE',
    init(fn, c, s, e) {
      const out = attrIndex(fn.m_nFieldOutput, A.YAW);
      if (VECTOR_ATTRS.has(out) || !c.attr[out]) { report(c, `C_INIT_RemapInitialTransformDirectionToRotation output ${out} is not a scalar stream`); return; }
      const ver = c.def.m_nBehaviorVersion | 0, tr = transformOf(c, fn.m_TransformInput);
      let v = (+fn.m_flOffsetRot || 0) * DEG2RAD;
      if (ver < 7) v += Math.atan2(tr.forward[1], tr.forward[0]) + (ver < 4 ? 3.14159274 : 0);
      else v -= frameAngles(tr)[clamp(fn.m_nComponent | 0, 0, 2)] * DEG2RAD;
      for (let i = s; i < e; i++) c.attr[out][i] = v;
    },
  },

  // 63babcbf: C_INIT_ModelCull slot 34 0x180156480 (output mask slot 30 = 2: life duration). The CP's model is attached
  // to the CP (FUN_18004eb50; m_bUseBones picks the bone path, else m_HitboxSetName hashed with 0x31415926); with no
  // model on the CP (cp+0xa0 model count <= 0) nothing happens. Else, in batches of at most 100 particles, the query
  // (coll+0x1d8 vtable +0x28, with the CP, m_bBoundBox and m_HitboxSetName) tests the positions: a failed query sets
  // every particle's life duration to -1 (0xbf800000); else a particle inside is set to -1 unless m_bCullOutside, one
  // outside is set to -1 with m_bCullOutside.
  // UNSETTLED: the runtime has no models; opts.insideModel answers for the host, and without it the CP has no model.
  C_INIT_ModelCull: {
    evidence: 'RE',
    init(fn, c, s, e) {
      const q = c.sys.opts.insideModel;
      if (!q) { report(c, 'C_INIT_ModelCull: no opts.insideModel, the CP carries no model, nothing culled'); return; }
      const cpi = fn.m_nControlPointNumber | 0, opt = { boundBox: !!fn.m_bBoundBox, hitboxSet: String(fn.m_HitboxSetName ?? ''), useBones: !!fn.m_bUseBones };
      for (let b = s; b < e; b += 100) {
        const n = Math.min(100, e - b), pts = [];
        for (let i = b; i < b + n; i++) pts.push([c.attr[A.POSITION][3 * i], c.attr[A.POSITION][3 * i + 1], c.attr[A.POSITION][3 * i + 2]]);
        const r = q(cpi, pts, opt);
        if (r === null || r === undefined) return; // no model at the CP
        for (let k = 0; k < n; k++) if (r === false || !!r[k] !== !!fn.m_bCullOutside) c.attr[A.LIFE][b + k] = -1;
      }
    },
  },
};
