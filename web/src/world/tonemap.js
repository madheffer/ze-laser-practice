// CS2's post-processing for the frame, from the map's post_processing_volume and its .vpost (lasers-bake --lighting
// exports each .vpost to lighting/post/). Truth source: VRF's post_processing.frag + PostProcessRenderer.cs:
//   color *= exposure * 2^m_flExposureBias        (exposure: the volume's, see below)
//   tonemap: x = min(x * 2.8, white); f(x) = (x(Sx + L*LA) + TN*TS) / (x(Sx + L) + TD*TS) - TN/TD; out = f(x) / f(2^m_flWhitePoint)
//            (m_toneMapParams when m_bHasTonemapParams, else CS2's defaults 0.15 0.5 0.1 0.2 0.02 0.3, white 4)
//   then sRGB, then the colour-correction lookup (m_colorCorrectionVolumeData, dim^3 RGBA8) on the sRGB values,
//   then r_fullscreen_gamma (ui/gamma.js, over the canvas)
// The renderer's HDR blit calls these: cs2Tonemap(hdr) -> sRGB -> cs2ColorCorrect(srgb).
// Not yet: auto exposure (CS2 meters the frame and clamps to the volume's min / max exposure; here the exposure is 1
// clamped into that range, which is what every baked map so far asks for at rest), bloom, per-area volumes (only the
// master / map-wide volume applies), vignette.
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

export class PostProcess {
  constructor() {
    const empty = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1);
    empty.needsUpdate = true;
    this.uniforms = {
      cs2Exposure: { value: 1 }, cs2ToneA: { value: new THREE.Vector4() }, cs2ToneB: { value: new THREE.Vector4() },
      cs2Lut: { value: empty }, cs2LutWeight: { value: 0 }, cs2LutDim: { value: 1 },
    };
    this.setParams(DEFAULTS);
  }

  setParams(p) {
    const q = {};
    for (const k of Object.keys(DEFAULTS)) q[k] = finite(p?.[k], DEFAULTS[k]);
    if (q.m_flToeDenom === 0) q.m_flToeDenom = DEFAULTS.m_flToeDenom;
    this.uniforms.cs2ToneA.value.set(q.m_flShoulderStrength, q.m_flLinearStrength, q.m_flLinearAngle, q.m_flToeStrength);
    const white = curve(2 ** q.m_flWhitePoint, q);
    this.uniforms.cs2ToneB.value.set(q.m_flToeNum, q.m_flToeDenom, white > 1e-6 ? 1 / white : 1, 2 ** q.m_flWhitePoint);
    this.bias = 2 ** q.m_flExposureBias;
  }

  // per map: entities (the post_processing_volume) + the lighting bake's post index (world/lightmaps.js)
  async setMap(base, entities, lightmaps) {
    this.setParams(DEFAULTS);
    this.uniforms.cs2LutWeight.value = 0;
    let exposure = 1;
    const vols = Object.values(entities?.lumps || {}).flat().filter((e) => e?.kv?.classname === 'post_processing_volume');
    const vol = (vols.find((e) => truthy(e.kv.master) && !truthy(e.kv.startdisabled)) || vols.find((e) => !truthy(e.kv.startdisabled)))?.kv;
    if (vol && truthy(vol.enableexposure ?? 'true')) {
      const lo = parseFloat(vol.minexposure), hi = parseFloat(vol.maxexposure);
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi >= lo) exposure = Math.min(hi, Math.max(lo, 1));
    }
    const hash = vol && lightmaps?.post ? lightmaps.post[assetKey(vol.postprocessing).replace(/_c$/, '')] : null;
    if (hash) {
      try {
        const post = await fetchJson(versioned(`${base}lighting/post/${hash}.json`, lightmaps.version));
        if (post?.tonemap) this.setParams(post.tonemap);
        const dim = post?.lutDim;
        if (Number.isInteger(dim) && dim >= 2 && dim <= MAX_LUT) {
          const buf = await fetchBuffer(versioned(`${base}lighting/post/${hash}.lut`, lightmaps.version));
          if (buf.byteLength === dim * dim * dim * 4) {
            const lut = new THREE.Data3DTexture(new Uint8Array(buf), dim, dim, dim);
            lut.format = THREE.RGBAFormat;
            lut.minFilter = lut.magFilter = THREE.LinearFilter;
            lut.wrapS = lut.wrapT = lut.wrapR = THREE.ClampToEdgeWrapping;
            lut.colorSpace = THREE.NoColorSpace;
            lut.needsUpdate = true;
            this.uniforms.cs2Lut.value = lut;
            this.uniforms.cs2LutDim.value = dim;
            this.uniforms.cs2LutWeight.value = 1;
          }
        }
      } catch { /* the defaults stay */ }
    }
    this.uniforms.cs2Exposure.value = exposure * this.bias;
  }
}
