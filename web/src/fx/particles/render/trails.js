import * as THREE from 'three';
import { createSpritecardMaterial, applyControls, whiteTexture } from './spritecard.js';
import { spritecardControls, makeInputs } from './controls.js';
import { colorBlend, srgbToLinear } from './barn.js';
import { ropeSide, screenSizeLimit, sheetSample, vec } from './basis.js';

// C_OP_RenderTrails: every particle is its OWN streak, from its position back along its motion (the spritecard trail
// combo, S_DRAW_AS_TRAIL, RE §6). Ropes join particles into one strip (ropes.js); trails never do.
//
// Length (C_OP_RenderTrails vertex setup, particles.dll FUN_1802d6190 / FUN_1802d4990): the motion is
// position - attribute m_nPrevPntSource; when that is the previous position (2) and !m_bIgnoreDT it is divided by the
// frame's dt (coll +0x64), so it is a velocity; times m_flLengthScale, then capped by m_flMaxLength (both read there).
// UNSETTLED (the clamp and fade sit in the vertex writer, not decompiled): the minimum m_flMinLength, the fade in
// `length *= min(1, age / m_flLengthFadeInTime)` and m_flForwardShift moving the streak forward by that fraction of
// its length are Source 1's CTrailRenderer rules; V runs 0 at the head to 1 at the tail; one sheet frame per
// particle (frame blend not drawn). Radius: the head end x m_flRadiusHeadTaper, the tail end x m_flRadiusTaper; colour
// and alpha x the head / tail scales, lerped along the streak (TVS:2742 COLOR0 / COLOR1).

export class TrailRenderer {
  constructor(shared, assets) {
    this.assets = assets;
    this.geometry = new THREE.BufferGeometry();
    this.material = createSpritecardMaterial('mesh', shared, whiteTexture());
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.capacity = 0;
  }

  _ensure(n) {
    if (n <= this.capacity) return;
    this.capacity = Math.max(n, this.capacity * 2, 16);
    const g = this.geometry, v = this.capacity * 4;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv4', new THREE.BufferAttribute(new Float32Array(v * 4), 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color4', new THREE.BufferAttribute(new Float32Array(v * 4), 4).setUsage(THREE.DynamicDrawUsage));
    const index = new Uint32Array(this.capacity * 6);
    for (let i = 0; i < this.capacity; i++) index.set([4 * i, 4 * i + 1, 4 * i + 3, 4 * i, 4 * i + 3, 4 * i + 2], 6 * i);
    g.setIndex(new THREE.BufferAttribute(index, 1));
  }

  update(col, p, raw, ctx, cls = 'C_OP_RenderTrails') {
    const ev = makeInputs(col);
    const ctl = spritecardControls(cls, p, raw, ev, col.time || 0);
    applyControls(this.material, ctl);
    const tex = ctl.texture ? this.assets.texture(ctl.texture, ctl.clampUVs) : null;
    this.material.uniforms.uBase.value = tex || whiteTexture();
    const sheet = ctl.texture ? this.assets.sheet(ctl.texture) : null;
    const n = col.count || 0;
    if (!n) { this.mesh.visible = false; return ctl; }
    this._ensure(n);
    const A = col.attr || {};
    const at = (k, i) => [A[k]?.[3 * i] ?? 0, A[k]?.[3 * i + 1] ?? 0, A[k]?.[3 * i + 2] ?? 0];
    const vc = ctl.vc, cam = ctx.camPos;
    const scale = ev.evalVec(p.m_vecColorScale, -1, [1, 1, 1]);
    const headC = ev.evalVec(p.m_vecHeadColorScale, -1, [1, 1, 1]), tailC = ev.evalVec(p.m_vecTailColorScale, -1, [1, 1, 1]);
    const alphaScale = ev.evalFloat(p.m_flAlphaScale, -1, 1), radiusScale = ev.evalFloat(p.m_flRadiusScale, -1, 1);
    const alpha2 = A[p.m_nAlpha2Field ?? 16];
    const src = p.m_nPrevPntSource ?? 2;
    const perSecond = src === 2 && !p.m_bIgnoreDT && col.dt > 0 ? 1 / col.dt : 1;
    const k = perSecond * (p.m_flLengthScale ?? 1);
    const maxLen = p.m_flMaxLength ?? 2000, minLen = p.m_flMinLength ?? 0, fadeIn = p.m_flLengthFadeInTime ?? 0;
    const shift = p.m_flForwardShift ?? 0, time = col.time || 0;
    const gamma = vc.c4[2] >= 256;
    const rate = vc.c1[3], inFps = !!p.m_bAnimateInFPS;
    const pos = this.geometry.attributes.position.array, uv = this.geometry.attributes.uv4.array, colr = this.geometry.attributes.color4.array;
    let q = 0;
    for (let i = 0; i < n; i++) {
      const P = at(0, i);
      const d = vec.sub(P, A[src] ? at(src, i) : P);
      const speed = Math.hypot(d[0], d[1], d[2]);
      if (!(speed > 0)) continue;
      const dir = vec.mul(d, 1 / speed);
      const age = time - (A[8]?.[i] ?? 0);
      let len = Math.min(maxLen, Math.max(minLen, speed * k));
      if (fadeIn > 0) len *= Math.min(1, Math.max(0, age / fadeIn));
      const head = vec.add(P, vec.mul(dir, len * shift)), tail = vec.sub(head, vec.mul(dir, len));
      const mid = vec.mul(vec.add(head, tail), 0.5);
      const side = ropeSide(vc.orientation, dir, cam, mid, A[21] ? at(21, i) : [0, 0, 1]);
      if (!side.every(Number.isFinite)) continue;
      const r = (A[3]?.[i] ?? 5) * radiusScale;
      const tint = colorBlend(ctl.colorBlendType, scale, A[6] ? at(6, i) : [1, 1, 1]);
      const a = (A[7]?.[i] ?? 1) * (alpha2 ? alpha2[i] : 1) * alphaScale;
      let rect = [0, 0, 1, 1];
      if (sheet) {
        const life = A[1]?.[i] ?? 1;
        const s = sheetSample(sheet, A[9]?.[i] ?? 0, vc.animationType === 1 ? (life > 0 ? age / life : 0) : age, rate, inFps);
        if (s) rect = s.rect0;
      }
      const ends = [[tail, ev.evalFloat(p.m_flRadiusTaper, i, 1), tailC, ev.evalFloat(p.m_flTailAlphaScale, i, 1), 0],
        [head, ev.evalFloat(p.m_flRadiusHeadTaper, i, 1), headC, ev.evalFloat(p.m_flHeadAlphaScale, i, 1), 1]];
      for (const [e, taper, cs, as, v] of ends) {
        let w = r * taper, cm = 1;
        if (vc.c2[2] > 0) { const lim = screenSizeLimit(w, Math.hypot(...vec.sub(cam, e)), vc.c0); w = lim.r; cm = lim.colorMul; }
        const rgb = [0, 1, 2].map((c) => tint[c] * cs[c]);
        const c4 = [...(gamma ? rgb.map(srgbToLinear) : rgb).map((x) => x * cm), a * as * cm];
        for (const x of [-1, 1]) {
          pos.set(vec.add(e, vec.mul(side, w * x)), q * 3);
          const lu = x * 0.5 + 0.5, lv = 1 - v;
          uv.set([rect[0] + (lu / vc.c5[2] + vc.c5[0]) * (rect[2] - rect[0]), rect[1] + (lv / vc.c5[3] + vc.c5[1]) * (rect[3] - rect[1]), 1, 1], q * 4);
          colr.set(c4, q * 4);
          q++;
        }
      }
    }
    for (const name of ['position', 'uv4', 'color4']) this.geometry.attributes[name].needsUpdate = true;
    this.geometry.setDrawRange(0, (q / 4) * 6);
    this.mesh.visible = q > 0;
    return ctl;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
