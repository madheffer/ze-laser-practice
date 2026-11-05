// CS2's self-illumination (F_SELF_ILLUM on csgo_complex / csgo_vertexlitgeneric / cables) as three's emissive.
// VRF exports the mask as the glTF emissiveTexture but writes no emissiveFactor, so three drew every one of these
// black-emissive: lit only, they took the probes' colour (ze_ffxii_westersand_v8's lasers came out dull brown-red
// in the red desert instead of a bright see-through yellow-green bar). The baked maps carry ~160 such materials.
//
// CS2 (csgo_complex v72, vpkstuff docs/research/shader_dumps/csgo_complex.interface.md + SHADER_TRANSPARENCY_AUDIT
// "colorGlow": complex_ps_si_trans.glsl :280-282, :698):
//   g_vSelfIllumTintScaled = pow(2, g_flSelfIllumBrightness) * g_flSelfIllumScale * SrgbGammaToLinear(g_vSelfIllumTint)
//   E        = TextureSelfIllumMask(uv + fract(g_vSelfIllumScrollSpeed * t)).rgb * g_vSelfIllumTintScaled
//   emission = mix(E, E * albedo, g_flSelfIllumAlbedoFactor), added after lighting
//   albedo   = g_tColor * mix(1, rendercolor, g_flModelTintAmount) * g_vColorTint
// Defaults: brightness 0, scale 1, albedo factor 1, tint [1 1 1], mask (0,0,0): no mask, no glow.
// csgo_vertexlitgeneric declares the same parameters; taken as the same maths (its dump is not in the corpus).
// UNSETTLED: the mask's scroll and g_bUseSecondaryUvForSelfIllum are not drawn; the rendercolor tint multiplies the
// whole emission (exact at albedo factor 1, every map's value but a few).
import * as THREE from 'three';

const num = (v, d) => (Number.isFinite(v) ? v : d);
const vec3 = (v) => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? v.slice(0, 3) : null);
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// the material's self-illum terms, or null when it has none (or its mask is black)
export function selfIllumTerms(m) {
  const vmat = m?.userData?.vmat;
  if (!vmat || !vmat.IntParams?.F_SELF_ILLUM) return null;
  const f = vmat.FloatParams || {}, v = vmat.VectorParams || {};
  const t = vec3(v.g_vSelfIllumTint) || [1, 1, 1];
  const k = Math.pow(2, num(f.g_flSelfIllumBrightness, 0)) * num(f.g_flSelfIllumScale, 1);
  const scaled = t.map((c) => srgbToLinear(c) * k);
  const albedo = Math.min(1, Math.max(0, num(f.g_flSelfIllumAlbedoFactor, 1)));
  // the mask: a constant (VRF writes it as TextureSelfIllumMask, and bakes it to a 1x1 emissiveTexture), a texture,
  // or the shader's default black
  const constMask = vec3(v.TextureSelfIllumMask);
  const maskTex = constMask ? null : m.emissiveMap || null;
  const mask = constMask || (maskTex ? null : [0, 0, 0]);
  if (mask && mask.every((c) => c <= 0)) return null;
  if (scaled.every((c) => c <= 0)) return null;
  return { scaled, albedo, mask, maskTex };
}

let DECODE = null, ENCODE = null; // sRGB byte -> linear, linear (4096 steps) -> sRGB byte

function pixels(image, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}

// mask x mix(1, albedo, a) as one sRGB texture at the albedo's size: three's emissive takes a single map. The mask
// is linear data; the product is stored sRGB-encoded so three decodes it back to linear albedo x mask.
function bakeEmission(albedoTex, maskTex, maskConst, a) {
  const ai = albedoTex?.image, mi = maskTex?.image;
  const w = ai?.width || mi?.width, h = ai?.height || mi?.height;
  if (!w || !h) return null;
  const A = ai ? pixels(ai, w, h).data : null;
  const M = mi ? pixels(mi, w, h).data : null;
  const out = new ImageData(w, h);
  const o = out.data;
  const lut = DECODE || (DECODE = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255)));
  const encLut = ENCODE || (ENCODE = Uint8Array.from({ length: 4096 }, (_, i) => {
    const x = i / 4095;
    return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255);
  }));
  for (let p = 0; p < o.length; p += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const albedo = A ? lut[A[p + ch]] : 1;
      const mask = M ? M[p + ch] / 255 : maskConst[ch];
      o[p + ch] = encLut[Math.round(Math.min(1, mask * (1 - a + a * albedo)) * 4095)];
    }
    o[p + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  const src = albedoTex || maskTex;
  tex.flipY = src.flipY; tex.wrapS = src.wrapS; tex.wrapT = src.wrapT; tex.channel = src.channel;
  tex.repeat.copy(src.repeat); tex.offset.copy(src.offset); tex.rotation = src.rotation; tex.center.copy(src.center);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// a copy of the material with CS2's self-illum as three's emissive, or null when it has none
export function selfIllumMaterial(m) {
  if (!m || m.userData?.cs2SelfIllum || !('emissive' in m)) return null;
  const s = selfIllumTerms(m);
  if (!s) return null; // no glow: the export's emissive is black already
  const u = m.clone();
  u.userData = { ...m.userData, cs2SelfIllum: true, cs2SelfIllumAlbedo: s.albedo > 0 };
  u.emissive = new THREE.Color(s.scaled[0], s.scaled[1], s.scaled[2]);
  const albedoMap = s.albedo > 0 ? m.map : null;
  if (s.mask && !albedoMap) {
    // a constant mask, no albedo texture in it: one colour
    u.emissiveMap = null;
    u.emissive.multiply(new THREE.Color(s.mask[0], s.mask[1], s.mask[2]));
  } else if (s.mask && s.albedo === 1) {
    u.emissiveMap = albedoMap;
    u.emissive.multiply(new THREE.Color(s.mask[0], s.mask[1], s.mask[2]));
  } else if (s.maskTex && !albedoMap) {
    // the mask alone: linear data, not sRGB
    const t = s.maskTex.clone();
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    u.emissiveMap = t;
  } else {
    u.emissiveMap = bakeEmission(albedoMap, s.maskTex, s.mask, s.albedo);
    if (!u.emissiveMap) return null;
  }
  return u;
}

const shared = new WeakMap(); // an exported material -> its self-illum copy (or itself)

// a mesh's materials with CS2's self-illum filled in (one replacement per source material)
export function applySelfIllum(mesh, cache = shared) {
  const one = (m) => {
    if (cache.has(m)) return cache.get(m);
    let u = m;
    try { u = selfIllumMaterial(m) || m; } catch (e) { console.warn('self-illum:', m?.name, e); }
    cache.set(m, u);
    return u;
  };
  mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
}

// an entity's rendercolor on a cloned material: the albedo-driven glow takes the tint as the albedo does
export function tintSelfIllum(m, color) {
  if (m?.userData?.cs2SelfIllumAlbedo && m.emissive) m.emissive.multiply(color);
}
