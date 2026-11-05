// CS2 water: world meshes whose vmat is csgo_water_fancy.vfx are drawn with CS2's own water shader (water-glsl.js)
// instead of the flat glTF material VRF exports for them. Every parameter comes from the vmat itself (the glb keeps
// it in extras.vmat), its textures from the bake (lasers-bake --water: water/water.json + PNGs), the light from the
// map's lighting (world/lighting.js) and the frame behind the water from the scene copy (world/scenecopy.js).
//
//   const water = new Water(lighting)
//   water.setMap(map.water)            // loadMap's { textures: { vtex: url } } (null: an older bake, flat waves)
//   water.material(m)                  // a world material -> its water material (null: not water)
//   water.setQuality(level)            // 'low' | 'medium' | 'high' (Renderer.setQuality)
//   water.frame(camera, time)          // every frame: time, camera, is any water in view (wantsCopy)
//
// Quality (the graphics preset's knobs, Renderer.setQuality): high = the vmat as authored; medium = SSR at half the
// vmat's steps (48 at most) and one refraction sample instead of the blurred five; low = no SSR, no caustics, one
// refraction sample, 2 wave octaves at most (reflections are off on low: the cubemaps go too, lighting.setOptions).
import * as THREE from 'three';
import { WATER_VS, WATER_FS } from './water-glsl.js';
import { LIGHTMAP_PARS, CUBE_PARS, FOG_PARS } from './lighting.js';
import { sceneCopyUniforms } from './scenecopy.js';

export const WATER_SHADER = 'csgo_water_fancy.vfx';

// every parameter the shader reads, with VRF's defaults (water_csgo.frag.slang) for one the vmat leaves out.
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
};
const INTS = { g_nWaveIterations: 3, g_nSSRMaxForwardSteps: 20, g_bUseTriplanarCaustics: 0 };
const VECTORS = {
  g_vMapUVMin: [[-10272, -10199], false], g_vMapUVMax: [[10241, 10241], false], g_vWaveScale: [[15, 15], false],
  g_vDebrisTint: [[0.7, 0.7, 0.7], true], g_vWaterFogColor: [[0.5, 0.5, 0.5], true], g_vWaterDecayColor: [[1, 1, 1], false],
  g_vCausticsTint: [[0.5, 0.5, 0.5], false], g_vFoamColor: [[0.7, 0.7, 0.7, 1], true],
};
// texture slot -> [neutral texel when the bake has none, sRGB]
const TEXTURES = {
  g_tWavesNormalHeight: [[128, 128, 128, 255], false], g_tFoam: [[128, 128, 0, 0], false],
  g_tDebris: [[0, 0, 0, 0], true], g_tDebrisNormal: [[128, 128, 255, 255], false],
};
const LEVELS = ['low', 'medium', 'high'];
const num = (v, d) => (Number.isFinite(+v) ? +v : d);

function vec(v, def, srgb) {
  const a = def.map((d, i) => num(Array.isArray(v) ? v[i] : undefined, d));
  if (srgb) for (let i = 0; i < 3; i++) a[i] = a[i] < 0.04045 ? a[i] * 0.0773993808 : Math.pow(a[i] * 0.9478672986 + 0.0521327014, 2.4);
  return a.length === 2 ? new THREE.Vector2(...a) : a.length === 3 ? new THREE.Vector3(...a) : new THREE.Vector4(...a);
}

function texel(rgba, srgb) {
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export class Water {
  constructor(lighting) {
    this.lighting = lighting;
    this.level = 'high';
    this.textures = new Map(); // url -> THREE.Texture
    this.materials = new Map(); // vmat name -> ShaderMaterial
    this.meshes = new Set(); // water meshes in the world, for wantsCopy
    this.wantsCopy = false;
    this.neutral = Object.fromEntries(Object.entries(TEXTURES).map(([k, [rgba, srgb]]) => [k, texel(rgba, srgb)]));
    // per frame, shared by every water material
    this.shared = {
      g_flTime: { value: 0 }, uSunColor: { value: new THREE.Vector3() }, uSunDiffuse: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      uCamDir: { value: new THREE.Vector3() }, uCamUp: { value: new THREE.Vector3() }, uProjection: { value: new THREE.Matrix4() },
      uLightmap: { value: null }, uLightmapUvTransform: { value: new THREE.Matrix3() },
    };
    this._frustum = new THREE.Frustum(); this._vp = new THREE.Matrix4(); this._sphere = new THREE.Sphere();
  }

  // a new world: drop the last map's materials and textures
  setMap(water) {
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.materials.clear(); this.textures.clear(); this.meshes.clear();
    this.urls = water?.textures || {};
  }

  setQuality(level) {
    const l = LEVELS.includes(level) ? level : 'high';
    if (l === this.level) return;
    this.level = l;
    for (const m of this.materials.values()) this.applyLevel(m);
  }

  // the vmat's features, capped by the quality level (a define change recompiles the material once)
  applyLevel(m) {
    const f = m.userData.features, low = this.level === 'low', medium = this.level === 'medium';
    const d = {
      F_REFLECTION_TYPE: low ? Math.min(1, f.F_REFLECTION_TYPE) : f.F_REFLECTION_TYPE,
      F_REFRACTION: f.F_REFRACTION,
      F_CAUSTICS: low ? 0 : f.F_CAUSTICS,
      F_BLUR_REFRACTION: low || medium ? 0 : f.F_BLUR_REFRACTION,
    };
    m.uniforms.g_nWaveIterations.value = low ? Math.min(2, f.waves) : f.waves;
    m.uniforms.g_nSSRMaxForwardSteps.value = medium ? Math.min(48, Math.ceil(f.ssrSteps / 2)) : f.ssrSteps;
    if (Object.keys(d).some((k) => m.defines[k] !== d[k])) { Object.assign(m.defines, d); m.needsUpdate = true; }
  }

  texture(slot, vtex) {
    const url = vtex && this.urls[vtex];
    if (!url) return this.neutral[slot];
    let t = this.textures.get(url);
    if (!t) {
      t = new THREE.TextureLoader().load(url);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = TEXTURES[slot][1] ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      this.textures.set(url, t);
    }
    return t;
  }

  // a world material -> the water material for its vmat (one per vmat), or null when it isn't CS2 water
  material(src) {
    const vmat = src?.userData?.vmat;
    if (!vmat || String(vmat.ShaderName || '').toLowerCase() !== WATER_SHADER || !this.lighting.lightmaps) return null;
    const key = String(vmat.Name || src.name);
    if (this.materials.has(key)) return this.materials.get(key);
    const F = vmat.FloatParams || {}, I = vmat.IntParams || {}, V = vmat.VectorParams || {}, T = vmat.TextureParams || {};
    const uniforms = { ...this.shared, ...sceneCopyUniforms, ...this.lighting.uniforms, ...this.lighting.fogUniforms, ...this.lighting.cubeUniforms };
    for (const [k, d] of Object.entries(FLOATS)) uniforms[k] = { value: num(F[k], d) };
    for (const [k, d] of Object.entries(INTS)) uniforms[k] = { value: Math.round(num(I[k], d)) };
    for (const [k, [d, srgb]] of Object.entries(VECTORS)) uniforms[k] = { value: vec(V[k], d, srgb) };
    for (const k of Object.keys(TEXTURES)) uniforms[k] = { value: this.texture(k, T[k]) };
    const L = this.lighting;
    // the map's cubemaps, not the uniform: that is 0 while reflections are off, and the shader checks cs2CubeVisible
    const hasShadow = !!L.uniforms.cs2Shadows.value, cubes = L.cubeCount > 0;
    const pars = `${LIGHTMAP_PARS(false, hasShadow)}\n${FOG_PARS}\n${CUBE_PARS(cubes)}`;
    const m = new THREE.ShaderMaterial({
      name: `water:${key}`, uniforms, vertexShader: WATER_VS, fragmentShader: WATER_FS(pars),
      // after the opaques and the scene copy marker (world/scenecopy.js): it reads the frame behind it. Opaque output
      transparent: true, blending: THREE.NoBlending, depthWrite: true, side: src.side,
    });
    m.userData.features = {
      F_REFLECTION_TYPE: Math.round(num(I.F_REFLECTION_TYPE, 0)), F_REFRACTION: Math.round(num(I.F_REFRACTION, 0)),
      F_CAUSTICS: Math.round(num(I.F_CAUSTICS, 0)), F_BLUR_REFRACTION: Math.round(num(I.F_BLUR_REFRACTION, 0)),
      waves: Math.max(1, Math.min(16, uniforms.g_nWaveIterations.value)), ssrSteps: Math.max(0, Math.min(400, uniforms.g_nSSRMaxForwardSteps.value)),
    };
    m.defines = {};
    this.applyLevel(m);
    this.materials.set(key, m);
    return m;
  }

  // a world mesh now drawn with a water material
  track(mesh) { this.meshes.add(mesh); }

  frame(camera, time) {
    const s = this.shared, L = this.lighting;
    s.g_flTime.value = time;
    camera.getWorldDirection(s.uCamDir.value);
    s.uCamUp.value.set(0, 1, 0).applyQuaternion(camera.quaternion);
    s.uProjection.value.copy(camera.projectionMatrix);
    const sun = L.sun;
    s.uSunDir.value.copy(sun.position).sub(sun.target.position).normalize();
    // CS2's diffuse has no 1/pi: the sun's three intensity carries pi (lighting.js setMap)
    s.uSunColor.value.set(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.intensity / Math.PI);
    if (sun.visible) s.uSunDiffuse.value.copy(s.uSunColor.value); else s.uSunDiffuse.value.set(0, 0, 0);
    const irr = L.lightmaps?.textures?.irradiance || null;
    s.uLightmap.value = irr;
    if (irr) s.uLightmapUvTransform.value.copy(irr.matrix);
    // the scene copy only when some water is on screen
    this.wantsCopy = false;
    if (!this.meshes.size) return;
    this._frustum.setFromProjectionMatrix(this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const m of this.meshes) {
      if (!m.parent) { this.meshes.delete(m); continue; }
      if (!m.visible || !m.geometry) continue;
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      if (this._frustum.intersectsSphere(this._sphere.copy(m.geometry.boundingSphere).applyMatrix4(m.matrixWorld))) { this.wantsCopy = true; break; }
    }
  }
}
