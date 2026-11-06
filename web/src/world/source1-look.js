// A Source 1 map's look as its I/O changes it, every frame: its env_smoketrail puffs (smoketrail-source1.js), the
// 2D sky a skybox_swapper set (manifest sky2dSets,
// entities/classes/skybox-swapper.js) and the color_correction lookups blended into the post pass's colour lookup
// (manifest correction: correction.json + the .raw files, entities/classes/color-correction.js).
// Source's material system blends the active lookups by weight: a weight sum over 1 is scaled back to 1, and what is
// left under 1 goes to the identity (UNSETTLED: from the SDK's colorcorrection mgr behaviour as remembered, not
// decompiled from CS:GO's materialsystem.dll). The lookup is applied to the frame's gamma-space colour, after the tone
// map: the same place world/tonemap.js applies CS2's (cs2ColorCorrect), whose uniforms this drives for a Source 1 map
// (which has no post_processing_volume of its own).
import * as THREE from 'three';
import { safeRelPath } from '../lib/paths.js';
import { fetchJson, fetchBuffer } from '../lib/fetch.js';
import { source1Sky } from './source1-light.js';
import { colorCorrections } from './entities/classes/color-correction.js';
import { swappedSky } from './entities/classes/skybox-swapper.js';
import { SmokeTrails } from './smoketrail-source1.js';

const SKY_FACE = /^sky\/[a-z0-9_-]{1,64}\/(rt|bk|lf|ft|up|dn)\.png$/;
const RAW_FILE = /^[a-z0-9_]{1,120}\.raw$/;

export class Source1Look {
  // data: loadMap's result. Null for a CS2 map
  static async load(data) {
    const m = data?.manifest;
    if (m?.engine !== 'source1') return null;
    const skies = new Map();
    for (const [name, faces] of Object.entries(m.sky2dSets && typeof m.sky2dSets === 'object' ? m.sky2dSets : {})) {
      if (faces && typeof faces === 'object' && Object.values(faces).every((f) => typeof f === 'string' && SKY_FACE.test(f))) skies.set(name.toLowerCase(), faces);
    }
    const luts = new Map(); // filename -> Uint8Array (dim^3 RGB)
    let dim = 0;
    const path = m.correction;
    if (typeof path === 'string' && safeRelPath(path) != null) {
      const index = await fetchJson(data.url(path)).catch(() => null);
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
      await Promise.all(Object.entries(index && typeof index === 'object' ? index : {}).map(async ([name, v]) => {
        const d = Number(v?.dim);
        if (!RAW_FILE.test(String(v?.file)) || !Number.isInteger(d) || d < 2 || d > 64 || (dim && d !== dim)) return;
        const buf = await fetchBuffer(data.url(dir + v.file)).catch(() => null);
        if (!buf || buf.byteLength !== d * d * d * 3) return;
        dim = d;
        luts.set(name.toLowerCase(), new Uint8Array(buf));
      }));
    }
    return new Source1Look(data, skies, luts, dim);
  }

  constructor(data, skies, luts, dim) {
    this.data = data;
    this.skies = skies;
    this.skyCache = new Map();
    this.skyKey = null;
    this.luts = luts;
    this.dim = dim;
    this.ccKey = null;
    if (dim) {
      this.tex = new THREE.Data3DTexture(new Uint8Array(dim * dim * dim * 4), dim, dim, dim);
      this.tex.format = THREE.RGBAFormat;
      this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
      this.tex.wrapS = this.tex.wrapT = this.tex.wrapR = THREE.ClampToEdgeWrapping;
      this.tex.colorSpace = THREE.NoColorSpace;
      this.mix = new Float32Array(dim * dim * dim * 3);
    }
  }

  // engine: the run's entity engine (null between runs: the map's own sky, no lookup); eye: the view position
  update(renderer, engine, eye) {
    this.updateSky(renderer, engine);
    this.updateCorrection(renderer.post, engine, eye);
    (this.smoke ||= new SmokeTrails(this.data.sprites, renderer.scene)).update(engine, renderer.camera);
  }

  dispose() { this.smoke?.dispose(); this.smoke = null; }

  updateSky(renderer, engine) {
    const name = swappedSky(engine);
    const key = name && this.skies.has(name) ? name : '';
    if (key === this.skyKey) return;
    this.skyKey = key;
    if (!key) { renderer.setSky(this.data.sky2d); return; }
    if (!this.skyCache.has(key)) this.skyCache.set(key, source1Sky(this.skies.get(key), this.data.url, 'source1'));
    renderer.setSky(this.skyCache.get(key));
  }

  updateCorrection(post, engine, eye) {
    if (!post || !this.tex) return;
    const list = engine ? colorCorrections(engine, eye).filter((c) => this.luts.has(c.file)) : [];
    const key = list.map((c) => `${c.file}:${c.weight.toFixed(3)}`).join('|');
    const u = post.uniforms;
    if (key === this.ccKey) { if (list.length) { u.cs2Lut.value = this.tex; u.cs2LutDim.value = this.dim; u.cs2LutWeight.value = 1; } return; }
    this.ccKey = key;
    if (!list.length) { u.cs2LutWeight.value = 0; return; }
    const total = list.reduce((s, c) => s + c.weight, 0);
    const scale = 1;
    const ident = 1 - total;
    const d = this.dim, mix = this.mix, out = this.tex.image.data;
    // the identity's share: the lookup's own coordinates (red fastest, then green, then blue)
    for (let b = 0, i = 0; b < d; b++) for (let g = 0; g < d; g++) for (let r = 0; r < d; r++, i += 3) {
      mix[i] = (r / (d - 1)) * 255 * ident; mix[i + 1] = (g / (d - 1)) * 255 * ident; mix[i + 2] = (b / (d - 1)) * 255 * ident;
    }
    for (const c of list) {
      const lut = this.luts.get(c.file), w = c.weight * scale;
      for (let i = 0; i < mix.length; i++) mix[i] += lut[i] * w;
    }
    for (let i = 0, j = 0; i < mix.length; i += 3, j += 4) {
      out[j] = Math.min(255, Math.max(0, Math.round(mix[i]))); out[j + 1] = Math.min(255, Math.max(0, Math.round(mix[i + 1]))); out[j + 2] = Math.min(255, Math.max(0, Math.round(mix[i + 2]))); out[j + 3] = 255;
    }
    this.tex.needsUpdate = true;
    u.cs2Lut.value = this.tex;
    u.cs2LutDim.value = d;
    u.cs2LutWeight.value = 1;
  }
}
