import * as THREE from 'three';
import { createSpritecardMaterial, applyControls, bindTextures, whiteTexture } from './spritecard.js';
import { spritecardControls, makeInputs } from './controls.js';
import { colorBlend, srgbToLinear, smoothstep } from './barn.js';
import { catmullRom, catmullRomTangent, ropeSide, ropeV, screenSizeLimit, vec } from './basis.js';

// C_OP_RenderRopes / C_OP_RenderTrails: the spritecard trail combo (S_DRAW_AS_TRAIL=1, RE §6) tessellated on the
// CPU from basis.js, so the strip drawn is the one node tests check. Particles join in collection order
// (reversed with m_bReverseOrder); a closed loop wraps.

// UNSETTLED (RE §6: tessellation counts are C++ side): a fixed 8 segments per span, inside the
// renderer's own min/max.
const SEGMENTS = 8;

export class RopeRenderer {
  constructor(shared, assets) {
    this.assets = assets;
    this.geometry = new THREE.BufferGeometry();
    this.material = createSpritecardMaterial('mesh', shared, whiteTexture());
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.capacity = 0;
  }

  _ensure(verts, tris) {
    if (verts <= this.capacity) return;
    this.capacity = Math.max(verts, this.capacity * 2, 64);
    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv4', new THREE.BufferAttribute(new Float32Array(this.capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color4', new THREE.BufferAttribute(new Float32Array(this.capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(Math.max(tris, this.capacity * 3) * 3), 1));
  }

  update(col, p, raw, ctx, cls = 'C_OP_RenderRopes') {
    const ev = makeInputs(col);
    const ctl = spritecardControls(cls, p, raw, ev, col.time || 0);
    applyControls(this.material, ctl);
    bindTextures(this.material, ctl, this.assets);
    if (ctl.texture && this.assets.sheet(ctl.texture)) ctx.report?.('sprite sheet on a rope (sampled as the whole texture)');
    const n = col.count || 0;
    const closed = !!p.m_bClosedLoop && n > 2;
    const spans = n < 2 ? 0 : (closed ? n : n - 1);
    const S = Math.min(Math.max(SEGMENTS, p.m_nMinTesselation ?? 1), p.m_nMaxTesselation ?? 128);
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = spans > 0;
    if (!spans) return ctl;
    const verts = spans * (S + 1) * 2;
    this._ensure(verts, spans * S * 2);
    const A = col.attr || {};
    const idx = []; for (let i = 0; i < n; i++) idx.push(i);
    if (p.m_bReverseOrder) idx.reverse();
    const at = (k, i) => [A[k]?.[3 * i] ?? 0, A[k]?.[3 * i + 1] ?? 0, A[k]?.[3 * i + 2] ?? 0];
    const scale = ev.evalVec(p.m_vecColorScale, -1, [1, 1, 1]);
    const alphaScale = ev.evalFloat(p.m_flAlphaScale, -1, 1);
    const radiusScale = ev.evalFloat(p.m_flRadiusScale, -1, 1);
    const alpha2 = A[p.m_nAlpha2Field ?? 16];
    const gamma = ctl.vc.c4[2] >= 256;
    const P = idx.map((i) => at(0, i));
    const Rr = idx.map((i) => (A[3]?.[i] ?? 5) * radiusScale);
    const N = idx.map((i) => (A[21] ? at(21, i) : [0, 0, 1]));
    // COLOR0 / COLOR1, each sRGB-decoded when the gamma bit is set, then lerped (TVS:2742).
    const C = idx.map((i) => {
      const rgb = colorBlend(ctl.colorBlendType, scale, A[6] ? at(6, i) : [1, 1, 1]);
      return [...(gamma ? rgb.map(srgbToLinear) : rgb), (A[7]?.[i] ?? 1) * (alpha2 ? alpha2[i] : 1) * alphaScale];
    });
    // Running length at each particle (UNSETTLED: what feeds T2.z / T7.x, RE §1-4 #6).
    const D = [0];
    for (let j = 1; j <= n; j++) D.push(D[j - 1] + Math.hypot(...vec.sub(P[j % n], P[j - 1])));
    const wrap = (j) => (closed ? ((j % n) + n) % n : Math.min(Math.max(j, 0), n - 1));  // UNSETTLED: open ends repeat
    const cam = ctx.camPos, vc = ctl.vc;
    const pos = this.geometry.attributes.position.array, uv = this.geometry.attributes.uv4.array, colr = this.geometry.attributes.color4.array;
    const index = this.geometry.index.array;
    const rot = vc.c4[3], cr = Math.cos(rot), sr = Math.sin(rot);
    const frac = (x) => x - Math.floor(x);
    let v = 0, t3 = 0;
    for (let s = 0; s < spans; s++) {
      const j0 = wrap(s - 1), j1 = wrap(s), j2 = wrap(s + 1), j3 = wrap(s + 2);
      const fadeDot = (a, b) => 1 - smoothstep(vc.c2[0], vc.c2[1], Math.abs(vec.dot(vec.normalize(vec.sub(P[a], P[b])), vec.normalize(vec.sub(cam, P[a])))));
      const f0 = fadeDot(j0, j1), f1 = fadeDot(j1, j2);                           // TVS:2768-2775
      const base = v;
      for (let k = 0; k <= S; k++) {
        const t = k / S;
        const sp = catmullRom(P[j0], P[j1], P[j2], P[j3], t);
        const tan = catmullRomTangent(P[j0], P[j1], P[j2], P[j3], t);
        let w = catmullRom(Rr[j0], Rr[j1], Rr[j2], Rr[j3], t);                    // TVS:2784
        const nrm = vec.normalize(vec.add(vec.mul(N[j1], 1 - t), vec.mul(N[j2], t)));
        const side = ropeSide(vc.orientation, tan, cam, sp, nrm);
        const c = [0, 1, 2, 3].map((q) => C[j1][q] + (C[j2][q] - C[j1][q]) * t);
        c[3] *= f0 + (f1 - f0) * t;
        if (vc.c2[2] > 0) {
          const lim = screenSizeLimit(w, Math.hypot(...vec.sub(cam, sp)), vc.c0);
          w = lim.r; for (let q = 0; q < 4; q++) c[q] *= lim.colorMul;
        }
        const vv = vc.c3[3] > 0 ? ropeV(D[s], D[s + 1], t, vc.c3[2], vc.c3[3]) : 1 - t;   // TVS:173
        for (const x of [-1, 1]) {
          const p3 = vec.add(sp, vec.mul(side, w * x));                           // TVS:3041
          pos.set(p3, v * 3);
          const u0 = x * 0.5 + 0.5 - 0.5, v0 = vv - 0.5;
          uv.set([(u0 * cr - v0 * sr) / vc.c5[2] + frac(vc.c5[0] + 0.5), (u0 * sr + v0 * cr) / vc.c5[3] + frac(vc.c5[1] + 0.5), 1, 1], v * 4);
          colr.set(c, v * 4);
          v++;
        }
      }
      for (let k = 0; k < S; k++) {
        const a = base + k * 2;
        index.set([a, a + 1, a + 3, a, a + 3, a + 2], t3); t3 += 6;
      }
    }
    for (const name of ['position', 'uv4', 'color4']) this.geometry.attributes[name].needsUpdate = true;
    this.geometry.index.needsUpdate = true;
    this.geometry.setDrawRange(0, t3);
    return ctl;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
