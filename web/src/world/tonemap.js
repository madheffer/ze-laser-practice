// CS2's post-processing for the frame, from the map's post_processing_volume entities and their .vpost files
// (lasers-bake --lighting exports each .vpost to lighting/post/). Truth source: VRF's post_processing.frag +
// PostProcessRenderer.cs:
//   color *= exposure * 2^m_flExposureBias        (exposure: the volume's, see below)
//   tonemap: x = min(x * 2.8, white); f(x) = (x(Sx + L*LA) + TN*TS) / (x(Sx + L) + TD*TS) - TN/TD; out = f(x) / f(2^m_flWhitePoint)
//            (m_toneMapParams when m_bHasTonemapParams, else CS2's defaults 0.15 0.5 0.1 0.2 0.02 0.3, white 4)
//   then sRGB, then the colour-correction lookup (m_colorCorrectionVolumeData, dim^3 RGBA8) on the sRGB values,
//   then r_fullscreen_gamma (ui/gamma.js, over the canvas)
// The renderer's HDR blit calls these: cs2Tonemap(hdr) -> sRGB -> cs2ColorCorrect(srgb).
// Which volume: the map's own I/O picks it at runtime (world/entities/classes/post.js: the master, or the enabled
// volume you touched last); update() follows it every frame, fading from what is on screen to the new volume's
// settings over its fadetime (the tone-curve numbers, the exposure and the lookup table each blended linearly).
// Without an engine (no run yet) the map-wide pick stands: the enabled master, else the first enabled volume.
// A volume whose .vpost the bake did not export (a stock CS2 one) is skipped: the map-wide pick shows instead.
// Not yet: auto exposure (CS2 meters the frame and clamps to the volume's min / max exposure; here the exposure is 1
// clamped into that range, which is what every baked map so far asks for at rest), vignette. Bloom: the volume's
// m_bloomParams ride along here (cleanBloom, blended in a fade) and world/bloom.js draws them.
// UNSETTLED: CS2's client blend between two volumes (parameter lerp vs a blend of the two results) is not
// decompiled; the lerp here matches both at the ends of a fade.
import * as THREE from 'three';
import { fetchJson, fetchBuffer } from '../lib/fetch.js';
import { versioned, assetKey } from '../lib/paths.js';

const DEFAULTS = { m_flExposureBias: 0, m_flShoulderStrength: 0.15, m_flLinearStrength: 0.5, m_flLinearAngle: 0.1, m_flToeStrength: 0.2, m_flToeNum: 0.02, m_flToeDenom: 0.3, m_flWhitePoint: 4 };
const MAX_LUT = 64;

export const CS2_POST_GLSL = `
uniform float cs2Exposure;
uniform vec4 cs2ToneA; // shoulder strength, linear strength, linear angle, toe strength
uniform vec4 cs2ToneB; // toe numerator, toe denominator, 1 / f(white point), the white point
uniform sampler3D cs2Lut;
uniform float cs2LutWeight;
uniform float cs2LutDim;
vec3 cs2Curve(vec3 x) {
  return (x * (cs2ToneA.x * x + cs2ToneA.y * cs2ToneA.z) + cs2ToneB.x * cs2ToneA.w)
       / (x * (cs2ToneA.x * x + cs2ToneA.y) + cs2ToneB.y * cs2ToneA.w) - cs2ToneB.x / cs2ToneB.y;
}
vec3 cs2Tonemap(vec3 hdr) { return cs2Curve(min(max(hdr, vec3(0.0)) * cs2Exposure * 2.8, vec3(cs2ToneB.w))) * cs2ToneB.z; }
vec3 cs2ColorCorrect(vec3 srgb) {
  if (cs2LutWeight <= 0.0) return srgb;
  vec3 uvw = clamp(srgb, 0.0, 1.0) * (1.0 - 1.0 / cs2LutDim) + 0.5 / cs2LutDim;
  return mix(srgb, texture(cs2Lut, uvw).rgb, cs2LutWeight);
}
`;

const curve = (x, p) => {
  const S = p.m_flShoulderStrength, L = p.m_flLinearStrength, LA = p.m_flLinearAngle, TS = p.m_flToeStrength, TN = p.m_flToeNum, TD = p.m_flToeDenom;
  return (x * (S * x + L * LA) + TN * TS) / (x * (S * x + L) + TD * TS) - TN / TD;
};
const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1;
const cleanParams = (p) => {
  const q = {};
  for (const k of Object.keys(DEFAULTS)) q[k] = finite(p?.[k], DEFAULTS[k]);
  if (q.m_flToeDenom === 0) q.m_flToeDenom = DEFAULTS.m_flToeDenom;
  return q;
};
// a .vpost's bloom block (lasers-bake --post): null without one
const cleanBloom = (b) => (b && typeof b === 'object' ? {
  strength: finite(b.strength, 0), screenStrength: finite(b.screenStrength, 0), blurStrength: finite(b.blurStrength, 0),
  threshold: finite(b.threshold, 0), thresholdWidth: finite(b.thresholdWidth, 0),
  weights: Array.from({ length: 5 }, (_, k) => finite(b.weights?.[k], 0.2)),
  tints: Array.from({ length: 5 }, (_, k) => [0, 1, 2].map((q) => finite(b.tints?.[k]?.[q], 1))),
} : null);
const NO_BLOOM = cleanBloom({});
const lerp = (a, b, w) => a + (b - a) * w;
// a fade between two volumes blends the bloom numbers like the rest (no bloom = zero strengths)
const mixBloom = (a, b, w) => {
  if (!a && !b) return null;
  const x = a || NO_BLOOM, y = b || NO_BLOOM;
  const o = {};
  for (const k of ['strength', 'screenStrength', 'blurStrength', 'threshold', 'thresholdWidth']) o[k] = lerp(x[k], y[k], w);
  o.weights = x.weights.map((v, k) => lerp(v, y.weights[k], w));
  o.tints = x.tints.map((t, k) => t.map((v, q) => lerp(v, y.tints[k][q], w)));
  return o;
};
const vpostKey = (vol) => assetKey(vol?.postprocessing).replace(/_c$/, '');

// the volume's exposure: 1 clamped into its min / max (when it controls exposure)
function volumeExposure(vol) {
  if (!vol || !truthy(vol.enableexposure ?? 'true')) return 1;
  const lo = parseFloat(vol.minexposure), hi = parseFloat(vol.maxexposure);
  return Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi >= lo ? Math.min(hi, Math.max(lo, 1)) : 1;
}

// a dim^3 RGBA8 lookup as floats at `dim` (trilinear resample when the sizes differ); null -> the identity
function lutAt(src, srcDim, dim) {
  const out = new Float32Array(dim * dim * dim * 4);
  const s = srcDim - 1, n = dim - 1;
  const at = (r, g, b, c) => src[((b * srcDim + g) * srcDim + r) * 4 + c];
  for (let b = 0, i = 0; b < dim; b++) for (let g = 0; g < dim; g++) for (let r = 0; r < dim; r++, i += 4) {
    if (!src) { out[i] = r / n * 255; out[i + 1] = g / n * 255; out[i + 2] = b / n * 255; out[i + 3] = 255; continue; }
    const fr = r / n * s, fg = g / n * s, fb = b / n * s;
    const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
    const r1 = Math.min(s, r0 + 1), g1 = Math.min(s, g0 + 1), b1 = Math.min(s, b0 + 1);
    const tr = fr - r0, tg = fg - g0, tb = fb - b0;
    for (let c = 0; c < 4; c++) {
      const x00 = at(r0, g0, b0, c) + (at(r1, g0, b0, c) - at(r0, g0, b0, c)) * tr;
      const x10 = at(r0, g1, b0, c) + (at(r1, g1, b0, c) - at(r0, g1, b0, c)) * tr;
      const x01 = at(r0, g0, b1, c) + (at(r1, g0, b1, c) - at(r0, g0, b1, c)) * tr;
      const x11 = at(r0, g1, b1, c) + (at(r1, g1, b1, c) - at(r0, g1, b1, c)) * tr;
      const y0 = x00 + (x10 - x00) * tg, y1 = x01 + (x11 - x01) * tg;
      out[i + c] = y0 + (y1 - y0) * tb;
    }
  }
  return out;
}

export class PostProcess {
  constructor() {
    const empty = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1);
    empty.needsUpdate = true;
    this.uniforms = {
      cs2Exposure: { value: 1 }, cs2ToneA: { value: new THREE.Vector4() }, cs2ToneB: { value: new THREE.Vector4() },
      cs2Lut: { value: empty }, cs2LutWeight: { value: 0 }, cs2LutDim: { value: 1 },
    };
    this.profiles = new Map(); // .vpost path -> { params, lut: Uint8Array | null, dim }
    this.dim = 0; // the shared lookup size (0: no volume has one)
    this.targets = new WeakMap(); // volume entity -> its settings (see target())
    this.fade = null;
    this.setParams(DEFAULTS);
  }

  setParams(p) {
    const q = cleanParams(p);
    this.uniforms.cs2ToneA.value.set(q.m_flShoulderStrength, q.m_flLinearStrength, q.m_flLinearAngle, q.m_flToeStrength);
    const white = curve(2 ** q.m_flWhitePoint, q);
    // signed: some maps' curves are negative for every x > 0 (dreamin.vpost: f(white) = -0.211), and dividing by the
    // negative f(white) flips them back to a near-linear curve; clamping that to 1 left every pixel negative (black)
    this.uniforms.cs2ToneB.value.set(q.m_flToeNum, q.m_flToeDenom, Math.abs(white) > 1e-6 ? 1 / white : 1, 2 ** q.m_flWhitePoint);
    this.bias = 2 ** q.m_flExposureBias;
  }

  // per map: entities (every post_processing_volume) + the lighting bake's post index (world/lightmaps.js)
  async setMap(base, entities, lightmaps) {
    this.profiles = new Map();
    this.targets = new WeakMap();
    this.fade = null;
    this.dim = 0;
    this.identity = null;
    const vols = Object.values(entities?.lumps || {}).flat().filter((e) => e?.kv?.classname === 'post_processing_volume');
    const paths = new Set(vols.map((e) => vpostKey(e.kv)).filter(Boolean));
    await Promise.all([...paths].map(async (path) => {
      const hash = lightmaps?.post ? lightmaps.post[path] : null;
      if (!hash) return;
      try {
        const post = await fetchJson(versioned(`${base}lighting/post/${hash}.json`, lightmaps.version));
        const prof = { params: cleanParams(post?.tonemap), bloom: cleanBloom(post?.bloom), lut: null, dim: 0 };
        const dim = post?.lutDim;
        if (Number.isInteger(dim) && dim >= 2 && dim <= MAX_LUT) {
          const buf = await fetchBuffer(versioned(`${base}lighting/post/${hash}.lut`, lightmaps.version));
          if (buf.byteLength === dim * dim * dim * 4) { prof.lut = new Uint8Array(buf); prof.dim = dim; }
        }
        this.profiles.set(path, prof);
      } catch { /* this volume stays unbaked */ }
    }));
    for (const p of this.profiles.values()) this.dim = Math.max(this.dim, p.dim);
    this.lutTex = null;
    if (this.dim) {
      const d = this.dim;
      const lut = new THREE.Data3DTexture(new Uint8Array(d * d * d * 4), d, d, d);
      lut.format = THREE.RGBAFormat;
      lut.minFilter = lut.magFilter = THREE.LinearFilter;
      lut.wrapS = lut.wrapT = lut.wrapR = THREE.ClampToEdgeWrapping;
      lut.colorSpace = THREE.NoColorSpace;
      this.lutTex = lut;
      this.uniforms.cs2Lut.value = lut;
      this.uniforms.cs2LutDim.value = d;
    }
    // the map-wide pick (before a run, and for volumes the bake has no settings for)
    const vol = (vols.find((e) => truthy(e.kv.master) && !truthy(e.kv.startdisabled)) || vols.find((e) => !truthy(e.kv.startdisabled)))?.kv;
    this.fallback = this.settingsOf(vol);
    this.show(this.fallback);
  }

  // a volume's settings: tone curve, exposure, lookup (floats at the shared size, null = none)
  settingsOf(vol) {
    const prof = vol ? this.profiles.get(vpostKey(vol)) : null;
    const params = prof?.params || cleanParams(DEFAULTS);
    const lut = this.dim && prof?.lut ? (prof.dim === this.dim ? Float32Array.from(prof.lut) : lutAt(prof.lut, prof.dim, this.dim)) : null;
    return { params, exposure: volumeExposure(vol) * 2 ** params.m_flExposureBias, lut, bloom: prof?.bloom || null };
  }

  target(e) {
    if (!e) return this.settingsOf(null);
    let t = this.targets.get(e);
    if (!t) {
      const key = vpostKey(e.kv);
      t = key && !this.profiles.has(key) ? this.fallback : this.settingsOf(e.kv);
      this.targets.set(e, t);
    }
    return t;
  }

  // put settings on screen (the uniforms + the lookup texture)
  show(s) {
    if (!s) return;
    this.setParams(s.params);
    this.uniforms.cs2Exposure.value = s.exposure;
    this.bloom = s.bloom || null; // world/bloom.js reads it each frame
    this.shown = s;
    if (!this.lutTex) { this.uniforms.cs2LutWeight.value = 0; return; }
    if (!s.lut) { this.uniforms.cs2LutWeight.value = 0; return; }
    const data = this.lutTex.image.data;
    for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(s.lut[i])));
    this.lutTex.needsUpdate = true;
    this.uniforms.cs2LutWeight.value = 1;
  }

  // every frame: the volume the map's I/O has the player in (engine.postState(), classes/post.js), faded in
  update(engine) {
    const st = engine?.postState ? engine.postState() : null;
    if (!st || !this.fallback) return;
    const f = this.fade;
    if (!f || f.vol !== st.vol || f.t0 !== st.t0) {
      this.fade = { vol: st.vol, t0: st.t0, dur: st.dur, from: this.shown || this.fallback, to: this.target(st.vol), step: -1 };
    }
    const g = this.fade;
    const w = g.dur > 0 ? Math.min(1, Math.max(0, (st.time - g.t0) / g.dur)) : 1;
    const step = Math.round(w * 255); // the lookup is 8-bit: no finer steps to show
    if (step === g.step) return;
    g.step = step;
    if (step >= 255 || g.from === g.to) { this.show(g.to); return; }
    this.show(this.mix(g.from, g.to, step / 255));
  }

  mix(a, b, w) {
    const params = {};
    for (const k of Object.keys(DEFAULTS)) params[k] = a.params[k] + (b.params[k] - a.params[k]) * w;
    let lut = null;
    if (a.lut || b.lut) {
      const id = a.lut && b.lut ? null : (this.identity ||= lutAt(null, 0, this.dim)); // no lookup = the identity
      const la = a.lut || id, lb = b.lut || id;
      lut = new Float32Array(la.length); // its own array: the next fade may start from this
      for (let i = 0; i < la.length; i++) lut[i] = la[i] + (lb[i] - la[i]) * w;
    }
    return { params, exposure: a.exposure + (b.exposure - a.exposure) * w, lut, bloom: mixBloom(a.bloom, b.bloom, w) };
  }
}
