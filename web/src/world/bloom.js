// CS2's compute bloom on the HDR frame, before the tone-map blit (render.js). Truth sources: the game's shaders (csgo
// shaders_vulkan_dir.vpk, dumped with VRF 20.1) for each pass, client.dll (Ghidra build 20261015) for the chain:
//   BS1  bloom_cs_vulkan_50_cs, D_BLOOM_MODE=1: the first downsample. 13 taps around the destination texel (+-1
//        diagonals, +-2 ring and corners, in source texels), each x smoothstep(0, g_fThreshold, luma601), averaged in
//        five groups of four with Karis weights 1 / (1 + luma601): the centre group x 0.5, the four corner groups
//        x 0.125; x g_fPreMultiply (+ the effects-bloom layer x g_fEffectsScale), clamped to 65504.
//   BS0  D_BLOOM_MODE=0: the next downsamples, the same 13 taps: corners x 0.03125, edges x 0.0625, centre + the four
//        diagonals x 0.125.
//   BS2  D_BLOOM_MODE=2: the up-sample recombine, dst = mix(dst, tent(upper level), g_fRadius): a 3x3 tent (centre
//        0.25, edges 0.125, corners 0.0625) g_fUpScaleFilterSize destination texels apart. BS3: the copy out.
//   PP   post_process_vulkan_50_ps, D_BLOOM=1 (s0_f24 / f36 with the lookup): c = colour x E; c = c (1 - U.z) +
//        B (N.z E); c += B N.x; tone curve; sRGB; s = saturate(BE / (BE + 0.187) x 1.035) N.y; out = srgb + s - srgb s;
//        then the colour-correction lookup.
// The chain (client.dll):
//   - FUN_1811e88a0 ("New Bloom", r_csgo_use_compute_bloom): the BloomBuffer is half the render size; the bloom
//     renderer (vtable 0x181d2a658) gets +0x18 = 2.0 (FUN_1811cc270) and the volume's m_flComputeBloomRadius (+0x1c),
//     m_flComputeBloomThreshold (+0x20), m_flComputeBloomStrength (+0x24), m_flComputeBloomEffectsScale (+0x28) (field
//     offsets 40 / 36 / 32 / 44 in PostProcessingBloomParameters_t, materialsystem2.dll schema); with no bloom block,
//     the defaults FUN_1811e88a0 starts from (local_3a8 / uStack_3a0): strength 0.03 (0x3cf5c28f), threshold 1,
//     radius 0.6 (0x3f19999a), effects scale 1. A .vpost that leaves the compute fields out gets these (UNSETTLED: the
//     struct's own constructor defaults are assumed to match the client's).
//   - FUN_18120b510 (the renderer's Render): levels = log2(min(BloomBuffer w, h)), at most 12, none below 2; each
//     downsample pass i is mode (i == 0) with g_fThreshold / g_fPreMultiply / g_fEffectsScale = +0x20 / +0x24 / +0x28;
//     the recombine runs every level with mode 2 (the last one mode 3, the copy), g_fRadius and
//     g_fUpScaleFilterSize = +0x1c / +0x18, the same for every level.
//   - the PostProcessing pass (FUN_1811e88a0, after "Gaussian Bloom"): the blend mode zeroes the strengths it does not
//     use (ADD: screen and blur; SCREEN: blur; BLUR: screen), m = max(add, screen, blur) (FUN_1801b9c30), then
//     N = (add, screen, blur) / m and U = (add, screen, blur); m < 1e-5 -> N = (1, 0, 0), U = (1, 0, 0). So an ADD
//     volume adds the whole bloom texture (N.x = 1), whose amount m_flComputeBloomStrength set in the first pass.
//   - m_flBlurWeight / m_vBlurTint / m_flBloomThreshold(Width) feed the Gaussian path only (r_csgo_use_compute_bloom 0).
// UNSETTLED: the level sizes past the first (FUN_181217980 not read; halving, rounded down); the effects-bloom layer
// (QuarterResEffectsColor, particles with m_bOnlyRenderInEffectsBloomPass) is not drawn, so g_fEffectsScale adds 0.
import * as THREE from 'three';

const MAX_LEVELS = 12;
const FILTER = 2.0; // +0x18, FUN_1811cc270
export const COMPUTE_DEFAULTS = { computeStrength: 0.03, computeThreshold: 1, computeRadius: 0.6, computeEffectsScale: 1 };

const VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const LUMA = 'const vec3 LUMA = vec3(0.2989999949932098, 0.5870000123977661, 0.1140000000596046);';

// BS1: threshold + Karis-weighted 13-tap downsample, x g_fPreMultiply
const FIRST = `${LUMA}
uniform sampler2D tSrc; uniform vec2 uSrcTexel; uniform float uThreshold, uPreMultiply; varying vec2 vUv;
vec3 tap(vec2 o) {
  vec3 c = texture2D(tSrc, vUv + o * uSrcTexel).rgb;
  float l = dot(c, LUMA);
  return c * (uThreshold > 0.0 ? smoothstep(0.0, uThreshold, l) : step(0.0, l));
}
float kw(vec3 c) { return 1.0 / (dot(c, LUMA) + 1.0); }
vec3 group(vec3 a, vec3 b, vec3 c, vec3 d) {
  float wa = kw(a), wb = kw(b), wc = kw(c), wd = kw(d);
  return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
}
void main() {
  vec3 nn = tap(vec2(-2.0, -2.0)), cn = tap(vec2(0.0, -2.0)), pn = tap(vec2(2.0, -2.0));
  vec3 nc = tap(vec2(-2.0, 0.0)), cc = tap(vec2(0.0)), pc = tap(vec2(2.0, 0.0));
  vec3 np = tap(vec2(-2.0, 2.0)), cp = tap(vec2(0.0, 2.0)), pp = tap(vec2(2.0, 2.0));
  vec3 d0 = tap(vec2(-1.0, 1.0)), d1 = tap(vec2(1.0, 1.0)), d2 = tap(vec2(-1.0, -1.0)), d3 = tap(vec2(1.0, -1.0));
  vec3 o = group(d2, d3, d0, d1) * 0.5
    + group(nn, cn, nc, cc) * 0.125 + group(cn, pn, cc, pc) * 0.125
    + group(nc, cc, np, cp) * 0.125 + group(cc, pc, cp, pp) * 0.125;
  gl_FragColor = vec4(clamp(o * uPreMultiply, 0.0, 65504.0), 1.0);
}`;

// BS0: 13-tap downsample
const DOWN = `uniform sampler2D tSrc; uniform vec2 uSrcTexel; varying vec2 vUv;
vec3 t(vec2 o) { return texture2D(tSrc, vUv + o * uSrcTexel).rgb; }
void main() {
  vec3 o = (t(vec2(-2.0, 2.0)) + t(vec2(2.0)) + t(vec2(-2.0)) + t(vec2(2.0, -2.0))) * 0.03125
    + (t(vec2(0.0, 2.0)) + t(vec2(-2.0, 0.0)) + t(vec2(2.0, 0.0)) + t(vec2(0.0, -2.0))) * 0.0625
    + (t(vec2(0.0)) + t(vec2(-1.0, 1.0)) + t(vec2(1.0)) + t(vec2(-1.0)) + t(vec2(1.0, -1.0))) * 0.125;
  gl_FragColor = vec4(clamp(o, 0.0, 65504.0), 1.0);
}`;

// BS2: dst = mix(own level, tent(upper), g_fRadius); the tent's taps g_fUpScaleFilterSize destination texels apart
const UP = `uniform sampler2D tOwn, tUp; uniform vec2 uDstTexel; uniform float uRadius, uFilter; varying vec2 vUv;
vec3 u(vec2 o) { return texture2D(tUp, vUv + o * uDstTexel * uFilter).rgb; }
void main() {
  vec3 tent = u(vec2(0.0)) * 0.25
    + (u(vec2(0.0, 1.0)) + u(vec2(-1.0, 0.0)) + u(vec2(1.0, 0.0)) + u(vec2(0.0, -1.0))) * 0.125
    + (u(vec2(-1.0, 1.0)) + u(vec2(1.0)) + u(vec2(-1.0)) + u(vec2(1.0, -1.0))) * 0.0625;
  gl_FragColor = vec4(mix(texture2D(tOwn, vUv).rgb, tent, uRadius), 1.0);
}`;

// PP: the composite, for the tone-map blit (render.js): cs2BloomPre before cs2Tonemap, cs2BloomScreen after sRGB
export const BLOOM_POST_GLSL = `
uniform sampler2D cs2Bloom; uniform vec3 cs2BloomN, cs2BloomU; uniform float cs2BloomOn;
vec3 cs2BloomPre(vec3 hdr, vec2 uv, float exposure) {
  if (cs2BloomOn < 0.5) return hdr;
  vec3 b = texture2D(cs2Bloom, uv).rgb;
  return hdr * (1.0 - cs2BloomU.z) + b * cs2BloomN.z + b * (cs2BloomN.x / max(exposure, 1e-6));
}
vec3 cs2BloomScreen(vec3 srgb, vec2 uv, float exposure) {
  if (cs2BloomOn < 0.5 || cs2BloomN.y <= 0.0) return srgb;
  vec3 be = texture2D(cs2Bloom, uv).rgb * exposure;
  vec3 s = clamp(be / (be + 0.187) * 1.035, 0.0, 1.0) * cs2BloomN.y;
  return srgb + s - srgb * s;
}`;

const MODES = { BLOOM_BLEND_ADD: 0, BLOOM_BLEND_SCREEN: 1, BLOOM_BLEND_BLUR: 2 };
/** The PostProcessing pass's N / U from a volume's bloom block (null: the defaults, add 0 -> N = U = (1, 0, 0)). */
export function bloomStrengths(p) {
  const mode = typeof p?.blendMode === 'number' ? p.blendMode : (MODES[p?.blendMode] ?? 0);
  let add = Math.max(0, p?.strength || 0), screen = Math.max(0, p?.screenStrength || 0), blur = Math.max(0, p?.blurStrength || 0);
  if (!p) { add = 0; screen = 0; blur = 0; }
  if (mode === 0) { screen = 0; blur = 0; } else if (mode === 1) blur = 0; else if (mode === 2) screen = 0;
  const m = Math.max(add, screen, blur);
  if (Math.abs(m) < 1e-5) return { N: [1, 0, 0], U: [1, 0, 0] };
  return { N: [add / m, screen / m, blur / m], U: [add, screen, blur] };
}

/** Level count for a BloomBuffer of w x h (FUN_18120b510): log2 of the shorter side, at most 12, 0 below 2. */
export function bloomLevels(w, h) {
  const n = Math.floor(Math.log2(Math.max(1, Math.min(w, h))));
  return n < 2 ? 0 : Math.min(MAX_LEVELS, n);
}

export class Bloom {
  constructor() {
    this.uniforms = {
      cs2Bloom: { value: null }, cs2BloomN: { value: new THREE.Vector3() }, cs2BloomU: { value: new THREE.Vector3() },
      cs2BloomOn: { value: 0 },
    };
    this.enabled = true;
    this.params = null; // the volume's m_bloomParams (tonemap.js), null = none (the C++ defaults apply)
    this.down = []; this.up = [];
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = (fs, uniforms) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    this.first = mat(FIRST, { tSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uPreMultiply: { value: 0.03 } });
    this.downMat = mat(DOWN, { tSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() } });
    this.upMat = mat(UP, { tOwn: { value: null }, tUp: { value: null }, uDstTexel: { value: new THREE.Vector2() }, uRadius: { value: 0.6 },
      uFilter: { value: FILTER } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.first);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  _size(w, h) {
    const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1); // the BloomBuffer: half the render size
    if (this.w === bw && this.h === bh) return;
    this.w = bw; this.h = bh;
    for (const t of [...this.down, ...this.up]) t.dispose();
    const n = bloomLevels(bw, bh);
    const make = (k) => new THREE.WebGLRenderTarget(Math.max(1, bw >> k), Math.max(1, bh >> k), {
      type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    this.down = Array.from({ length: n }, (_, k) => make(k));
    this.up = Array.from({ length: Math.max(0, n - 1) }, (_, k) => make(k));
  }

  _pass(r, material, target) {
    this.quad.material = material;
    r.setRenderTarget(target);
    r.render(this.scene, this.cam);
  }

  /** Build the bloom texture from the resolved HDR target; sets the composite uniforms. */
  render(r, hdr) {
    const p = this.params;
    const { N, U } = bloomStrengths(p);
    this.uniforms.cs2BloomN.value.set(...N);
    this.uniforms.cs2BloomU.value.set(...U);
    this.uniforms.cs2BloomOn.value = 0;
    if (!this.enabled) return;
    this._size(hdr.width, hdr.height);
    const n = this.down.length;
    if (!n) return;
    const c = { ...COMPUTE_DEFAULTS };
    for (const k of Object.keys(c)) if (Number.isFinite(p?.[k])) c[k] = p[k];
    const prev = r.getRenderTarget(), auto = r.autoClear;
    r.autoClear = false;
    const f = this.first.uniforms;
    f.tSrc.value = hdr.texture; f.uSrcTexel.value.set(1 / hdr.width, 1 / hdr.height);
    f.uThreshold.value = c.computeThreshold; f.uPreMultiply.value = c.computeStrength;
    this._pass(r, this.first, this.down[0]);
    for (let k = 1; k < n; k++) {
      const s = this.down[k - 1], d = this.downMat.uniforms;
      d.tSrc.value = s.texture; d.uSrcTexel.value.set(1 / s.width, 1 / s.height);
      this._pass(r, this.downMat, this.down[k]);
    }
    const u = this.upMat.uniforms;
    u.uRadius.value = c.computeRadius;
    for (let k = n - 2; k >= 0; k--) {
      const dst = this.up[k];
      u.tOwn.value = this.down[k].texture;
      u.tUp.value = k === n - 2 ? this.down[k + 1].texture : this.up[k + 1].texture;
      u.uDstTexel.value.set(1 / dst.width, 1 / dst.height);
      this._pass(r, this.upMat, dst);
    }
    this.uniforms.cs2Bloom.value = (n > 1 ? this.up[0] : this.down[0]).texture;
    this.uniforms.cs2BloomOn.value = 1;
    r.autoClear = auto;
    r.setRenderTarget(prev);
  }

  dispose() {
    for (const t of [...this.down, ...this.up]) t.dispose();
    for (const m of [this.first, this.downMat, this.upMat]) m.dispose();
    this.quad.geometry.dispose();
  }
}
