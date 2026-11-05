// csgo_water.vfx (westersand's river, visualizer's arcana pools): the material for water-basic-glsl.js. Defaults and
// the parameter expressions are CS2's own (csgo_water_vulkan_50_{ps,vs}.vcs variable descriptions, read with VRF):
// colours are SrgbGammaToLinear'd, g_vRoughness = max(.01, 1 - g_flGlossiness), the normal uv offset is
// -.5 * scale * (cos r - sin r, sin r + cos r) + offset + .5 with r = g_flNormalTexCoordRotation in degrees.
// It is cheap and unlit; quality changes nothing (reflections off on Low already removes the cubemaps).
import * as THREE from 'three';
import { BASIC_VS, BASIC_FS } from './water-basic-glsl.js';
import { CUBE_PARS, FOG_PARS } from './lighting.js';
import { sceneCopyUniforms } from './scenecopy.js';
import { num, vec, paramUniforms, waterMaterialOptions } from './water-common.js';

export const BASIC_SHADER = 'csgo_water.vfx';

const FLOATS = {
  g_flBumpStrength: 1, g_flNormalMapAnimationTimePerFrame: 0.1, g_flNormalMapAnimationTimeOffset: 0, g_flRefractionAmount: 1,
  g_flWaterDepth: 35, g_flWaterStart: 0, g_flReflectance: 0.2, g_flReflectionPower: 1,
};
const VECTORS = {
  g_vRefractionTint: [[1, 1, 1], true], g_vWaterFogColor: [[0.5, 0.5, 0.5], true],
  g_vReflectionDir: [[0, 0, 1], false], g_vReflectionColor: [[1, 1, 1], true], g_vExtraTexCoordScroll: [[0, 0, 0, 0], false],
};
// g_tNormal: a texture array (animation frames, WaterBake.cs); a flat normal when the bake has none
export const BASIC_TEXTURES = { g_tNormal: { rgba: [128, 128, 128, 255], array: true } };

export function basicMaterial(ctx, vmat, src, key) {
  const L = ctx.lighting, F = vmat.FloatParams || {}, V = vmat.VectorParams || {}, T = vmat.TextureParams || {};
  const params = paramUniforms(vmat, { floats: FLOATS, vectors: VECTORS });
  if (!(params.g_flNormalMapAnimationTimePerFrame.value > 0)) params.g_flNormalMapAnimationTimePerFrame.value = 0.1;
  if (params.g_flWaterDepth.value === params.g_flWaterStart.value) params.g_flWaterDepth.value += 1; // CS2 divides by the difference
  const scale = vec(V.g_vNormalTexCoordScale, [1, 1], false), off = vec(V.g_vNormalTexCoordOffset, [0, 0], false);
  const rot = num(F.g_flNormalTexCoordRotation, 0) * Math.PI / 180, c = Math.cos(rot), s = Math.sin(rot);
  const uniforms = {
    ...ctx.shared, ...sceneCopyUniforms, ...L.fogUniforms, ...L.cubeUniforms, ...params,
    g_tNormal: { value: ctx.texture('g_tNormal', T.g_tNormal, BASIC_TEXTURES.g_tNormal) },
    g_flRefractionClipPlaneAdjust: { value: 0 }, // a render attribute CS2 sets for planar refraction; 0 otherwise
    uRoughness: { value: Math.max(0.01, 1 - num(F.g_flGlossiness, 1)) },
    uNormalTexCoordScale: { value: scale },
    uNormalTexCoordOffset: { value: new THREE.Vector2(-0.5 * scale.x * (c - s) + off.x + 0.5, -0.5 * scale.y * (s + c) + off.y + 0.5) },
  };
  const pars = `${FOG_PARS}\n${CUBE_PARS(L.cubeCount > 0)}`;
  const m = new THREE.ShaderMaterial({ name: `water:${key}`, uniforms, vertexShader: BASIC_VS, fragmentShader: BASIC_FS(pars), ...waterMaterialOptions(src) });
  m.userData.applyLevel = () => {};
  return m;
}
