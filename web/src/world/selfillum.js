// CS2's self-illumination (csgo_complex.vfx F_SELF_ILLUM) on an exported material. VRF keeps the mask as the glTF
// emissiveTexture but writes no emissiveFactor, so three drew these black-emissive: lit only, they took the probes'
// colour. In CS2 the glow is most of the look: ze_ffxii_westersand_v8's lasers are materials/sprites/bluelaser1.vmat
// (a cyan strip, SelfIllumBrightness 4.57, albedo factor 1) x rendercolor [135 135 0], a bright see-through
// yellow-green bar; probe-lit in the red desert they came out dull brown-red.
//   selfIllum = mix(1, albedo, g_flSelfIllumAlbedoFactor) x g_vSelfIllumTint x mask x brightness x scale
// albedo is the colour texture x tint, so the entity's rendercolor (material.color, world/render.js) multiplies the
// emissive too: tintSelfIllum. UNSETTLED: three's emissive takes one map, so a material with both a non-uniform mask
// and an albedo factor keeps the albedo and drops the mask (bluelaser1's mask is a 1x1 white).
import * as THREE from 'three';

const num = (v, d) => (Number.isFinite(v) ? v : d);

function selfIllumOf(m) {
  const vmat = m?.userData?.vmat;
  if (!vmat || !m.isMeshStandardMaterial || !vmat.IntParams?.F_SELF_ILLUM) return null;
  return vmat;
}

// a copy of the material with CS2's self-illum as three's emissive, or null when it has none
export function selfIllumMaterial(m) {
  const vmat = selfIllumOf(m);
  if (!vmat || m.userData.cs2SelfIllum) return null;
  const f = vmat.FloatParams || {}, v = vmat.VectorParams || {};
  const albedo = Math.min(1, Math.max(0, num(f.g_flSelfIllumAlbedoFactor, 1)));
  const k = num(f.g_flSelfIllumBrightness, 1) * num(f.g_flSelfIllumScale, 1);
  const t = Array.isArray(v.g_vSelfIllumTint) ? v.g_vSelfIllumTint : [1, 1, 1];
  const mask = m.emissiveMap, maskImg = mask?.image;
  const uniformMask = !mask || (maskImg && maskImg.width <= 1 && maskImg.height <= 1);
  const u = m.clone();
  u.userData = { ...m.userData, cs2SelfIllum: true };
  if (albedo > 0 && m.map) {
    // mix(1, albedo, a): the white part as a lift of the texture (exact at a = 1, the usual value)
    u.emissiveMap = m.map;
    u.emissive = new THREE.Color(num(t[0], 1), num(t[1], 1), num(t[2], 1)).multiplyScalar(k);
    if (!uniformMask) u.userData.cs2SelfIllumMaskDropped = true;
  } else {
    u.emissiveMap = uniformMask ? null : mask;
    u.emissive = new THREE.Color(num(t[0], 1), num(t[1], 1), num(t[2], 1)).multiplyScalar(k);
  }
  u.userData.cs2SelfIllumAlbedo = albedo > 0;
  return u;
}

// a mesh's materials with CS2's self-illum filled in (one replacement per source material, through `cache`)
export function applySelfIllum(mesh, cache) {
  const one = (m) => {
    if (cache.has(m)) return cache.get(m);
    const u = selfIllumMaterial(m) || m;
    cache.set(m, u);
    return u;
  };
  mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
}

// an entity's rendercolor on a cloned material: the albedo-driven glow takes the tint as the albedo does
export function tintSelfIllum(m, color) {
  if (m?.userData?.cs2SelfIllumAlbedo && m.emissive) m.emissive.multiply(color);
}
