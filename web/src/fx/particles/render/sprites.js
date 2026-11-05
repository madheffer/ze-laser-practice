import * as THREE from 'three';
import { createSpritecardMaterial, applyControls, whiteTexture } from './spritecard.js';
import { spritecardControls, makeInputs } from './controls.js';
import { colorBlend } from './barn.js';
import { sheetSample } from './basis.js';

// C_OP_RenderSprites: one instanced quad per live particle, rebuilt from the attribute streams each frame. The
// vertex shader (spritecard.js SPRITE_VS) does orientation, roll/yaw, size limits and gamma; this side fills the
// TEXCOORD-equivalent instance attributes (RE §2) and samples the JSON sprite sheet.

const CORNERS = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
const INDEX = [0, 1, 2, 0, 2, 3];
const LAYOUT = { iPos: 3, iColor: 4, iRot: 4, iNormal: 3, iRect0: 4, iRect1: 4, iBlend: 1 };

export class SpriteRenderer {
  constructor(shared, assets) {
    this.assets = assets;
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute('corner', new THREE.BufferAttribute(CORNERS, 2));
    this.geometry.setIndex(INDEX);
    this.capacity = 0;
    this.material = createSpritecardMaterial('sprite', shared, whiteTexture());
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this._grow(16);
    this._order = [];
  }

  _grow(n) {
    this.capacity = Math.max(n, this.capacity * 2);
    for (const [name, size] of Object.entries(LAYOUT)) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(name, a);
    }
  }

  /** ctx: { time, camPos (Source), report(msg) }. Returns the controls it applied. */
  update(col, p, raw, ctx) {
    const ev = makeInputs(col);
    const ctl = spritecardControls('C_OP_RenderSprites', p, raw, ev, col.time || 0);
    applyControls(this.material, ctl);
    const tex = ctl.texture ? this.assets.texture(ctl.texture, ctl.clampUVs) : null;
    this.material.uniforms.uBase.value = tex || whiteTexture();
    const sheet = ctl.texture ? this.assets.sheet(ctl.texture) : null;
    if (sheet) this.material.uniforms.PC_c19z.value |= 32768;                   // PS0:106 sheet bit
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
      const c = ctx.camPos, P = A[0];
      const d2 = (i) => (P[3 * i] - c[0]) ** 2 + (P[3 * i + 1] - c[1]) ** 2 + (P[3 * i + 2] - c[2]) ** 2;
      order.sort((a, b) => d2(b) - d2(a));
    }
    for (let j = 0; j < n; j++) {
      const i = order[j];
      const tint = A[6] ? [A[6][3 * i], A[6][3 * i + 1], A[6][3 * i + 2]] : [1, 1, 1];
      const rgb = colorBlend(blendType, scale, tint);
      const alpha = (A[7]?.[i] ?? 1) * (alpha2 ? alpha2[i] : 1) * alphaScale;
      g.iPos.setXYZ(j, A[0]?.[3 * i] ?? 0, A[0]?.[3 * i + 1] ?? 0, A[0]?.[3 * i + 2] ?? 0);
      g.iColor.setXYZW(j, rgb[0], rgb[1], rgb[2], alpha);
      g.iRot.setXYZW(j, (A[4]?.[i] ?? 0) * rollScale, A[12]?.[i] ?? 0, A[20]?.[i] ?? 0, (A[3]?.[i] ?? 5) * radiusScale);
      g.iNormal.setXYZ(j, A[21]?.[3 * i] ?? 0, A[21]?.[3 * i + 1] ?? 0, A[21]?.[3 * i + 2] ?? 1);
      let s = null;
      if (sheet) {
        const age = time - (A[8]?.[i] ?? 0);
        const seq = seqOverride >= 0 ? seqOverride : (A[9]?.[i] ?? 0);
        // FIT_LIFETIME as one pass of the sequence over the particle's life: UNSETTLED.
        s = ctl.vc.animationType === 1
          ? sheetSample(sheet, seq, age, 1 / Math.max(1e-6, A[1]?.[i] ?? 1), false)
          : sheetSample(sheet, seq, age, rate, inFps);
      }
      if (s) {
        g.iRect0.setXYZW(j, s.rect0[0], s.rect0[1], s.rect0[2], s.rect0[3]);
        g.iRect1.setXYZW(j, s.rect1[0], s.rect1[1], s.rect1[2], s.rect1[3]);
        g.iBlend.setX(j, s.blend);
      } else g.iBlend.setX(j, -1);
    }
    for (const name of Object.keys(LAYOUT)) g[name].needsUpdate = true;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    return ctl;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
