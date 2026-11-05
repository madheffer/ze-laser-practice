import * as THREE from 'three';
import { createSpritecardMaterial, applyControls, bindTextures, whiteTexture } from './spritecard.js';
import { spritecardControls, makeInputs, normalizeRef } from './controls.js';
import { colorBlend } from './barn.js';
import { sheetSample } from './basis.js';

// C_OP_RenderSprites: one instanced quad per live particle, rebuilt from the attribute streams each frame. The
// vertex shader (spritecard.js SPRITE_VS) does orientation, roll/yaw, size limits and gamma; this side fills the
// TEXCOORD-equivalent instance attributes (RE §2) and samples the JSON sprite sheet.

const CORNERS = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
const INDEX = [0, 1, 2, 0, 2, 3];
const LAYOUT = {
  iPos: 3, iColor: 4, iRot: 4, iNormal: 3, iRect0: 4, iRect1: 4, iBlend: 1,
  iL1a: 4, iL1b: 4, iL2a: 4, iL2b: 4, iL3a: 4, iL3b: 4, iLBlend: 3, // texture layers 1-3: frame rects, blend (VSL)
  iMa: 4, iMb: 4, // the motion-vector texture's frame rects
};

export class SpriteRenderer {
  constructor(shared, assets) {
    this.assets = assets;
    this.capacity = 0;
    this.material = createSpritecardMaterial('sprite', shared, whiteTexture());
    this.mesh = new THREE.Mesh(undefined, this.material);
    this.mesh.frustumCulled = false;
    this._grow(16);
    this._order = [];
    // scratch reused by every particle of every frame (update)
    this._d2 = new Float64Array(16);
    this._tint = [1, 1, 1]; this._rgb = [0, 0, 0]; this._lb = [-1, -1, -1];
    this._s0 = {}; this._sl = {}; this._sm = {};
  }

  // A bigger set of instance buffers goes on a new geometry: three.js sizes an instanced geometry once, at its first
  // draw (_maxInstanceCount, from the attribute counts then), and caps every later draw there. Swapping bigger buffers
  // into the old one drew only its first capacity's worth: a 500-particle laser strip started at 16 drew 16.
  _grow(n) {
    this.capacity = Math.max(n, this.capacity * 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('corner', new THREE.BufferAttribute(CORNERS, 2));
    geo.setIndex(INDEX);
    for (const [name, size] of Object.entries(LAYOUT)) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
    }
    this.geometry?.dispose();
    this.geometry = this.mesh.geometry = geo;
  }

  /** ctx: { time, camPos (Source), report(msg) }. Returns the controls it applied. */
  update(col, p, raw, ctx) {
    const ev = makeInputs(col);
    const sheetOf = (g) => !!(g.m_hTexture && this.assets.sheet(normalizeRef(g.m_hTexture)));
    const ctl = spritecardControls('C_OP_RenderSprites', p, raw, ev, col.time || 0, sheetOf);
    applyControls(this.material, ctl);
    bindTextures(this.material, ctl, this.assets);
    // each layer runs its own texture's sheet on the particle's sequence and age (VSL: one sheet row per layer)
    const sheets = ctl.layers.map((l) => (l.texture ? this.assets.sheet(l.texture) : null));
    const sheet = sheets[0];
    const mvSheet = ctl.motion ? this.assets.sheet(ctl.motion.texture) : null;
    const n = col.count || 0;
    if (n > this.capacity) this._grow(n);
    const A = col.attr || {};
    const g = this.geometry.attributes;
    const scale = ev.evalVec(p.m_vecColorScale, -1, [1, 1, 1]);
    const alphaScale = ev.evalFloat(p.m_flAlphaScale, -1, 1);
    const radiusScale = ev.evalFloat(p.m_flRadiusScale, -1, 1);
    const rollScale = ev.evalFloat(p.m_flRollScale, -1, 1);
    const seqOverride = ev.evalFloat(p.m_nSequenceOverride, -1, -1);
    const alpha2 = A[p.m_nAlpha2Field ?? 16];
    const blendType = ctl.colorBlendType;
    const time = col.time || 0;
    const inFps = !!p.m_bAnimateInFPS, rate = ctl.vc.c1[3];
    // PARTICLE_SORTING_NEAREST is read as far-to-near, the order premultiplied blending needs.
    // UNSETTLED: the sort is C++ side and not in the notes.
    const order = this._order; order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    if ((p.m_nSortMethod ?? 'PARTICLE_SORTING_NEAREST') === 'PARTICLE_SORTING_NEAREST' && A[0]) {
      // each particle's distance once, not twice per comparison
      const c = ctx.camPos, P = A[0];
      if (this._d2.length < n) this._d2 = new Float64Array(Math.max(n, this._d2.length * 2));
      const d2 = this._d2;
      for (let i = 0; i < n; i++) d2[i] = (P[3 * i] - c[0]) ** 2 + (P[3 * i + 1] - c[1]) ** 2 + (P[3 * i + 2] - c[2]) ** 2;
      order.sort((a, b) => d2[b] - d2[a]);
    }
    const tint = this._tint, rgb = this._rgb, lb = this._lb, s0 = this._s0, sl = this._sl, sm = this._sm;
    for (let j = 0; j < n; j++) {
      const i = order[j];
      if (A[6]) { tint[0] = A[6][3 * i]; tint[1] = A[6][3 * i + 1]; tint[2] = A[6][3 * i + 2]; } else tint[0] = tint[1] = tint[2] = 1;
      colorBlend(blendType, scale, tint, rgb);
      const alpha = (A[7]?.[i] ?? 1) * (alpha2 ? alpha2[i] : 1) * alphaScale;
      g.iPos.setXYZ(j, A[0]?.[3 * i] ?? 0, A[0]?.[3 * i + 1] ?? 0, A[0]?.[3 * i + 2] ?? 0);
      g.iColor.setXYZW(j, rgb[0], rgb[1], rgb[2], alpha);
      g.iRot.setXYZW(j, (A[4]?.[i] ?? 0) * rollScale, A[12]?.[i] ?? 0, A[20]?.[i] ?? 0, (A[3]?.[i] ?? 5) * radiusScale);
      g.iNormal.setXYZ(j, A[21]?.[3 * i] ?? 0, A[21]?.[3 * i + 1] ?? 0, A[21]?.[3 * i + 2] ?? 1);
      const age = time - (A[8]?.[i] ?? 0);
      const seq = seqOverride >= 0 ? seqOverride : (A[9]?.[i] ?? 0);
      // FIT_LIFETIME: the vertex age is (time - creation) / lifetime, 0 for a lifetime <= 0 (FUN_180033400, the
      // FIT_LIFETIME vertex writer); the VS then runs the sheet at m_flAnimationRate as for FIXED_RATE (VS0:1693).
      const life = A[1]?.[i] ?? 1;
      const t = ctl.vc.animationType === 1 ? (life > 0 ? age / life : 0) : age;
      const s = sheet ? sheetSample(sheet, seq, t, rate, inFps, s0) : null;
      if (s) {
        g.iRect0.setXYZW(j, s.rect0[0], s.rect0[1], s.rect0[2], s.rect0[3]);
        g.iRect1.setXYZW(j, s.rect1[0], s.rect1[1], s.rect1[2], s.rect1[3]);
        g.iBlend.setX(j, s.blend);
      } else g.iBlend.setX(j, -1);
      lb[0] = lb[1] = lb[2] = -1;
      for (let k = 1; k < sheets.length; k++) {
        const ls = sheets[k] ? sheetSample(sheets[k], seq, t, rate, inFps, sl) : null;
        if (!ls) continue;
        g['iL' + k + 'a'].setXYZW(j, ls.rect0[0], ls.rect0[1], ls.rect0[2], ls.rect0[3]);
        g['iL' + k + 'b'].setXYZW(j, ls.rect1[0], ls.rect1[1], ls.rect1[2], ls.rect1[3]);
        lb[k - 1] = ls.blend;
      }
      g.iLBlend.setXYZ(j, lb[0], lb[1], lb[2]);
      // the motion texture runs its own sheet on the same sequence and age (its frames match the colour sheet's);
      // without one it takes the base layer's frame rects
      const ms = mvSheet ? sheetSample(mvSheet, seq, t, rate, inFps, sm) : s;
      if (ms) { g.iMa.setXYZW(j, ms.rect0[0], ms.rect0[1], ms.rect0[2], ms.rect0[3]); g.iMb.setXYZW(j, ms.rect1[0], ms.rect1[1], ms.rect1[2], ms.rect1[3]); }
    }
    for (const name of Object.keys(LAYOUT)) g[name].needsUpdate = true;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    return ctl;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
