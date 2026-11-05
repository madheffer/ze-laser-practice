// CS2's bloom on the HDR frame, before the tone-map blit (render.js). Per pass the maths is the game's own shaders
// (csgo shaders_vulkan_dir.vpk, dumped with VRF 20.1; tools/particles/PORTING.md scratch tools):
//   BS1  bloom_cs_vulkan_50_cs, D_BLOOM_MODE=1: the first downsample. 13 taps around the destination texel (+-1
//        diagonals, +-2 ring and corners, in source texels), each x smoothstep(0, g_fThreshold, luma601), averaged in
//        five groups of four with Karis weights 1 / (1 + luma601): the centre group x 0.5, the four corner groups
//        x 0.125; x g_fPreMultiply (+ the effects-bloom layer x g_fEffectsScale), clamped to 65504.
//   BS0  D_BLOOM_MODE=0: the next downsamples, the same 13 taps: corners x 0.03125, edges x 0.0625, centre + the four
//        diagonals x 0.125.
//   BS2  D_BLOOM_MODE=2: the up-sample recombine, dst = mix(dst, tent(upper level), g_fRadius): a 3x3 tent (centre
//        0.25, edges 0.125, corners 0.0625) g_fUpScaleFilterSize destination texels apart.
//   PP   post_process_vulkan_50_ps, D_BLOOM=1 (s0_f24 / f36 with the lookup): c = colour x E; c = c (1 - U.z) +
//        B (N.z E); c += B N.x; tone curve; sRGB; s = saturate(BE / (BE + 0.187) x 1.035) N.y; out = srgb + s - srgb s;
//        then the colour-correction lookup. N.x / N.y / N.z: add / screen / blur bloom strength.
// client.dll (20261015): r_bloom_tent_filter_radius 3.1 (0x40466666, registered 0x180121a90: "radius in mip level
// texels, 0.0 => box (2x2)"), r_csgo_render_post_bloom_strength -1 (= the volume's, 0x180125b10), compute bloom on.
// The .vpost's m_bloomParams arrive through tonemap.js (blended during a volume fade): world/bloom.js reads
//   { strength, screenStrength, blurStrength, threshold, thresholdWidth, weights[5], tints[5] }.
// UNSETTLED (the render-graph C++ that feeds these passes, FUN_1811e1710 / FUN_18120b510, is not decompiled):
//   - the chain: level 0 at half the render size, then halving, one level per m_flBlurWeight entry (5);
//   - g_fThreshold = m_flBloomThreshold + m_flBloomThresholdWidth (the shader has one edge, at 0);
//   - g_fRadius per level from the weights: the recombine leaves level k at weight w_k (r_0 = 1 - w_0,
//     r_k = 1 - w_k / prod(r_<k)), and each level's m_vBlurTint scales its own term;
//   - g_fPreMultiply 1, no effects-bloom layer (m_bOnlyRenderInEffectsBloomPass particles draw in the main pass);
//   - N = the volume's strengths as they are (every baked vpost's weights sum to 1), U.z = N.z;
//   - m_flBloomStartValue / m_flSkyboxBloomStrength are not applied.
import * as THREE from 'three';

const LEVELS = 5;
const TENT = 3.1; // r_bloom_tent_filter_radius

const VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const LUMA = 'const vec3 LUMA = vec3(0.2989999949932098, 0.5870000123977661, 0.1140000000596046);';

// BS1: threshold + Karis-weighted 13-tap downsample
const FIRST = `${LUMA}
uniform sampler2D tSrc; uniform vec2 uSrcTexel; uniform float uThreshold; varying vec2 vUv;
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
  gl_FragColor = vec4(clamp(o, 0.0, 65504.0), 1.0);
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

// BS2: dst = mix(own level x tint, tent(upper) x upperTint, radius); the tent's taps uDstTexel x TENT apart
const UP = `uniform sampler2D tOwn, tUp; uniform vec2 uDstTexel; uniform float uRadius; uniform vec3 uTint, uUpTint; varying vec2 vUv;
vec3 u(vec2 o) { return texture2D(tUp, vUv + o * uDstTexel * ${TENT.toFixed(1)}).rgb; }
void main() {
  vec3 tent = u(vec2(0.0)) * 0.25
    + (u(vec2(0.0, 1.0)) + u(vec2(-1.0, 0.0)) + u(vec2(1.0, 0.0)) + u(vec2(0.0, -1.0))) * 0.125
    + (u(vec2(-1.0, 1.0)) + u(vec2(1.0)) + u(vec2(-1.0)) + u(vec2(1.0, -1.0))) * 0.0625;
  gl_FragColor = vec4(mix(texture2D(tOwn, vUv).rgb * uTint, tent * uUpTint, uRadius), 1.0);
}`;

// PP: the composite, for the tone-map blit (render.js): cs2BloomPre before cs2Tonemap, cs2BloomScreen after sRGB
export const BLOOM_POST_GLSL = `
uniform sampler2D cs2Bloom; uniform vec3 cs2BloomN; // add, screen, blur strengths (0 = no bloom)
vec3 cs2BloomPre(vec3 hdr, vec2 uv, float exposure) {
  if (cs2BloomN.x + cs2BloomN.z <= 0.0) return hdr;
  vec3 b = texture2D(cs2Bloom, uv).rgb;
  return hdr * (1.0 - cs2BloomN.z) + b * cs2BloomN.z + b * (cs2BloomN.x / max(exposure, 1e-6));
}
vec3 cs2BloomScreen(vec3 srgb, vec2 uv, float exposure) {
  if (cs2BloomN.y <= 0.0) return srgb;
  vec3 be = texture2D(cs2Bloom, uv).rgb * exposure;
  vec3 s = clamp(be / (be + 0.187) * 1.035, 0.0, 1.0) * cs2BloomN.y;
  return srgb + s - srgb * s;
}`;

/** The level radii that leave level k at weight w_k after the recombine (see UNSETTLED above). */
export function bloomRadii(weights) {
  const r = [];
  let rest = 1;
  for (let k = 0; k < LEVELS - 1; k++) {
    const w = Math.max(0, weights[k] ?? 0);
    const rk = rest > 1e-6 ? Math.min(1, Math.max(0, 1 - w / rest)) : 0;
    r.push(rk);
    rest *= rk;
  }
  return r;
}

export class Bloom {
  constructor() {
    this.uniforms = { cs2Bloom: { value: null }, cs2BloomN: { value: new THREE.Vector3() } };
    this.enabled = true;
    this.params = null; // the volume's m_bloomParams (tonemap.js), null = none
    this.down = []; this.up = [];
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = (fs, uniforms) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    this.first = mat(FIRST, { tSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0 } });
    this.downMat = mat(DOWN, { tSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() } });
    this.upMat = mat(UP, { tOwn: { value: null }, tUp: { value: null }, uDstTexel: { value: new THREE.Vector2() }, uRadius: { value: 0 },
      uTint: { value: new THREE.Vector3(1, 1, 1) }, uUpTint: { value: new THREE.Vector3(1, 1, 1) } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.first);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  // the add / screen / blur strengths this frame (0 when off)
  strengths() {
    const p = this.params;
    if (!this.enabled || !p) return [0, 0, 0];
    return [Math.max(0, p.strength || 0), Math.max(0, p.screenStrength || 0), Math.min(1, Math.max(0, p.blurStrength || 0))];
  }

  _size(w, h) {
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    for (const t of [...this.down, ...this.up]) t.dispose();
    const make = (k) => new THREE.WebGLRenderTarget(Math.max(1, w >> (k + 1)), Math.max(1, h >> (k + 1)), {
      type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    this.down = Array.from({ length: LEVELS }, (_, k) => make(k));
    this.up = Array.from({ length: LEVELS - 1 }, (_, k) => make(k));
  }

  _pass(r, material, target) {
    this.quad.material = material;
    r.setRenderTarget(target);
    r.render(this.scene, this.cam);
  }

  /** Build the bloom texture from the resolved HDR target; sets the composite uniforms. */
  render(r, hdr) {
    const [nAdd, nScreen, nBlur] = this.strengths();
    this.uniforms.cs2BloomN.value.set(nAdd, nScreen, nBlur);
    if (nAdd + nScreen + nBlur <= 0) return;
    const p = this.params;
    this._size(hdr.width, hdr.height);
    const prev = r.getRenderTarget(), auto = r.autoClear;
    r.autoClear = false;
    const thr = (p.threshold || 0) + Math.max(0, p.thresholdWidth || 0);
    const f = this.first.uniforms;
    f.tSrc.value = hdr.texture; f.uSrcTexel.value.set(1 / hdr.width, 1 / hdr.height); f.uThreshold.value = thr;
    this._pass(r, this.first, this.down[0]);
    for (let k = 1; k < LEVELS; k++) {
      const s = this.down[k - 1], d = this.downMat.uniforms;
      d.tSrc.value = s.texture; d.uSrcTexel.value.set(1 / s.width, 1 / s.height);
      this._pass(r, this.downMat, this.down[k]);
    }
    const radii = bloomRadii(p.weights || []);
    const tint = (k) => { const t = p.tints?.[k]; return Array.isArray(t) && t.length === 3 ? t : [1, 1, 1]; };
    for (let k = LEVELS - 2; k >= 0; k--) {
      const u = this.upMat.uniforms, dst = this.up[k];
      u.tOwn.value = this.down[k].texture;
      u.tUp.value = k === LEVELS - 2 ? this.down[k + 1].texture : this.up[k + 1].texture;
      u.uDstTexel.value.set(1 / dst.width, 1 / dst.height);
      u.uRadius.value = radii[k];
      u.uTint.value.set(...tint(k));
      u.uUpTint.value.set(...(k === LEVELS - 2 ? tint(k + 1) : [1, 1, 1]));
      this._pass(r, this.upMat, dst);
    }
    this.uniforms.cs2Bloom.value = this.up[0].texture;
    r.autoClear = auto;
    r.setRenderTarget(prev);
  }

  dispose() {
    for (const t of [...this.down, ...this.up]) t.dispose();
    for (const m of [this.first, this.downMat, this.upMat]) m.dispose();
    this.quad.geometry.dispose();
  }
}
