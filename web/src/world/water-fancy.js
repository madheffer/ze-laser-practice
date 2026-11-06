// csgo_water_fancy.vfx (dreamin, mist, neochrome, offliner, visualizer): the material for water-fancy-glsl.js.
// Every parameter from the vmat, VRF's defaults (water_csgo.frag.slang) for one it leaves out.
//
// Quality: every level draws the vmat as authored. CS2's own low shader quality (S_SHADER_QUALITY 0, the combo the port
// was checked against) keeps SSR, caustics and every wave octave, and water is too much of what a player sees to cut.
import * as THREE from 'three';
import { WATER_VS, WATER_FS } from './water-fancy-glsl.js';
import { LIGHTMAP_PARS, CUBE_PARS, FOG_PARS, CUBE_FACE } from './lighting.js';
import { MAP_LIGHTS_PARS } from './maplights.js';
import { sceneCopyUniforms } from './scenecopy.js';
import { num, paramUniforms, waterMaterialOptions } from './water-common.js';

export const FANCY_SHADER = 'csgo_water_fancy.vfx';

// srgb: SrgbRead(true) in CS2 (decoded to linear here)
const FLOATS = {
  g_flWaterPlaneOffset: 0, g_flSkyBoxFadeRange: 0.05, g_flWaterRoughnessMin: 0.25, g_flWaterRoughnessMax: 1, g_flFoamMin: 0,
  g_flFoamMax: 1, g_flDebrisMin: 0, g_flDebrisMax: 1, g_flDebrisReflectance: 0.1, g_flDebrisOilyness: 0.1, g_flDebrisNormalStrength: 1,
  g_flDebrisEdgeSharpness: 10, g_flDebrisScale: 1, g_flDebrisWobble: 1, g_flFoamScale: 1, g_flFoamWobble: 1, g_flWavesHeightOffset: 1,
  g_flWavesSharpness: 0.5, g_flFresnelExponent: 5, g_flWavesNormalStrength: 1, g_flWavesNormalJitter: 0.1, g_flWaterInitialDirection: 1.5,
  g_flWavesSpeed: 1, g_flLowFreqWeight: 0.5, g_flMedFreqWeight: 0.5, g_flHighFreqWeight: 0.5, g_flWavesPhaseOffset: 0.4,
  g_flEdgeHardness: 10, g_flEdgeShapeEffect: 1, g_flRefractionLimit: 0.1, g_flWaterFogStrength: 0.5, g_flRefractSampleOffset: 2,
  g_flRefractChromaticSeparation: 0.5, g_flWaterDecayStrength: 8, g_flWaterMaxDepth: 100, g_flWaterFogShadowStrength: 0.5,
  g_flUnderwaterDarkening: 0.6, g_flSpecularPower: 300, g_flSpecularNormalMultiple: 2, g_flSpecularBloomBoostStrength: 100,
  g_flSpecularBloomBoostThreshold: 0.7, g_flCausticUVScaleMultiple: 2.5, g_flCausticDistortion: 0.5, g_flCausticsStrength: 40,
  g_flCausticSharpness: 0.5, g_flCausticDepthFallOffDistance: 100, g_flCausticShadowCutOff: 0.2, g_flReflectance: 0.2,
  g_flReflectionDistanceEffect: 0.5, g_flEnvironmentMapBrightness: 1, g_flGlossiness: 0.75, g_flSSRStepSize: 0.1,
  g_flSSRSampleJitter: 0.02, g_flSSRBoostThreshold: 1, g_flSSRBoost: 0, g_flSSRBrightness: 1, g_flSSRMaxThickness: 4,
  g_flLowEndCubeMapIntensity: 1,
};
const INTS = { g_nWaveIterations: 3, g_nSSRMaxForwardSteps: 20, g_bUseTriplanarCaustics: 0 };
const VECTORS = {
  g_vMapUVMin: [[-10272, -10199], false], g_vMapUVMax: [[10241, 10241], false], g_vWaveScale: [[15, 15], false],
  g_vDebrisTint: [[0.7, 0.7, 0.7], true], g_vWaterFogColor: [[0.5, 0.5, 0.5], true], g_vWaterDecayColor: [[1, 1, 1], false],
  g_vCausticsTint: [[0.5, 0.5, 0.5], false], g_vFoamColor: [[0.7, 0.7, 0.7, 1], true],
};
// texture slot -> { neutral texel when the bake has none, sRGB }
export const FANCY_TEXTURES = {
  g_tWavesNormalHeight: { rgba: [128, 128, 128, 255] }, g_tFoam: { rgba: [128, 128, 0, 0] },
  g_tDebris: { rgba: [0, 0, 0, 0], srgb: true }, g_tDebrisNormal: { rgba: [128, 128, 255, 255] },
};

// ctx: { lighting, shared, texture(slot, vtex, spec) }; lit: the mesh has lightmap UVs (else the sky ambient)
export function fancyMaterial(ctx, vmat, src, key, lit) {
  const L = ctx.lighting, T = vmat.TextureParams || {};
  const uniforms = { ...ctx.shared, ...sceneCopyUniforms, ...L.uniforms, ...L.fogUniforms, ...L.cubeUniforms, ...L.mapLights.uniforms, ...paramUniforms(vmat, { floats: FLOATS, ints: INTS, vectors: VECTORS }) };
  for (const [k, spec] of Object.entries(FANCY_TEXTURES)) uniforms[k] = { value: ctx.texture(k, T[k], spec) };
  const lowEnd = ctx.cube(T.g_tLowEndCubeMap); // world/water.js: the baked cube as six layers, or null
  uniforms.g_tLowEndCubeMap = { value: lowEnd || ctx.cube(null) };
  uniforms.uLowEndCube = { value: lowEnd ? 1 : 0 };
  // the map's cubemaps, not the uniform: that is 0 while reflections are off, and the shader checks cs2CubeVisible
  const hasShadow = lit && !!L.uniforms.cs2Shadows.value, cubes = L.cubeCount > 0;
  const pars = `${lit ? '' : '#define CS2_NO_LIGHTMAP'}\n${LIGHTMAP_PARS(false, hasShadow)}\n${FOG_PARS}\n${CUBE_PARS(cubes)}\n${CUBE_FACE}\n${MAP_LIGHTS_PARS}`;
  const m = new THREE.ShaderMaterial({ name: `water:${key}`, uniforms, vertexShader: WATER_VS, fragmentShader: WATER_FS(pars), ...waterMaterialOptions(src) });
  const I = vmat.IntParams || {};
  m.userData.features = {
    F_REFLECTION_TYPE: Math.round(num(I.F_REFLECTION_TYPE, 0)), F_REFRACTION: Math.round(num(I.F_REFRACTION, 0)),
    F_CAUSTICS: Math.round(num(I.F_CAUSTICS, 0)), F_BLUR_REFRACTION: Math.round(num(I.F_BLUR_REFRACTION, 0)),
    waves: Math.max(1, Math.min(16, uniforms.g_nWaveIterations.value)), ssrSteps: Math.max(0, Math.min(400, uniforms.g_nSSRMaxForwardSteps.value)),
  };
  m.userData.applyLevel = () => fancyLevel(m);
  m.defines = {};
  return m;
}

// the vmat's features (a define change recompiles the material once)
function fancyLevel(m) {
  const f = m.userData.features;
  const d = { F_REFLECTION_TYPE: f.F_REFLECTION_TYPE, F_REFRACTION: f.F_REFRACTION, F_CAUSTICS: f.F_CAUSTICS, F_BLUR_REFRACTION: f.F_BLUR_REFRACTION };
  m.uniforms.g_nWaveIterations.value = f.waves;
  m.uniforms.g_nSSRMaxForwardSteps.value = f.ssrSteps;
  if (Object.keys(d).some((k) => m.defines[k] !== d[k])) { Object.assign(m.defines, d); m.needsUpdate = true; }
}
