// A Source 1 map's own baked light (lasers-bake source1: bake/Source1/LightmapAtlas.cs). Its glb materials carry
// the lightmap atlas in the occlusion slot (TEXCOORD_1) with extras.lightmap = "rgbm<range>"; here each becomes an
// unlit MeshBasicMaterial (Source's LightmappedGeneric is texture x lightmap, no runtime lights) whose
// ambient-occlusion read is swapped for the RGBM decode, so a texel is albedo x light (linear, 1 = as authored).
// extras.additive ($additive: lasers, glows) draws added onto what is behind. One replacement per material.
import * as THREE from 'three';

// Source's HDR tonemap scale (its auto-exposure, clamped to the map's env_tonemap_controller min / max): one value
// for the whole map here, no adaptation yet. setSource1Exposure() per map (render.js setSky)
export const source1Exposure = { value: 2 };
export function setSource1Exposure(v) { source1Exposure.value = Number.isFinite(v) && v > 0 ? Math.min(v, 16) : 2; }

const replaced = new WeakMap(); // glb material -> its Source 1 material
const done = new WeakSet();

// a mesh from a Source 1 glb: its materials swapped for their unlit, lightmapped versions (others are left alone)
export function applySource1(o) {
  const one = (m) => {
    if (!m || done.has(m) || !(m.userData?.lightmap || m.userData?.additive)) return m;
    if (!replaced.has(m)) { const r = convert(m); done.add(r); replaced.set(m, r); }
    return replaced.get(m);
  };
  o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
}

function convert(src) {
  const kind = String(src.userData?.lightmap || '');
  const range = /^rgbm(\d+(\.\d+)?)$/.exec(kind)?.[1];
  const m = new THREE.MeshBasicMaterial({
    name: src.name, map: src.map, color: src.color, transparent: src.transparent, opacity: src.opacity,
    alphaTest: src.alphaTest, side: src.side, depthWrite: src.depthWrite, aoMap: range ? src.aoMap : null,
    vertexColors: kind === 'vertex', // a static prop: its ambient-cube light baked into COLOR_0
  });
  m.userData = { ...src.userData };
  if (kind === 'vertex') vertexLight(m);
  else if (kind === 'cube') cubeLight(m);
  patch(m, range); // the atlas decode (rgbm only) and $additive
  return m;
}

// COLOR_0 is linear light (can pass 1): x the exposure, as the lightmapped surfaces are
function vertexLight(m) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.s1Exposure = source1Exposure;
    shader.fragmentShader = `uniform float s1Exposure;\n${shader.fragmentShader}`.replace('#include <color_fragment>',
      '#include <color_fragment>\n  diffuseColor.rgb *= s1Exposure;');
  };
  m.customProgramCacheKey = () => 'source1-vertex';
}

// an entity model: Source's ambient cube (+X -X +Y -Y +Z -Z, linear) at the entity, by the world normal per vertex.
// m.s1Cube holds this material's six colours (a model's material is cloned per entity: lightModel below)
function cubeLight(m) {
  m.s1Cube = { value: Array.from({ length: 6 }, () => new THREE.Vector3(0.5, 0.5, 0.5)) };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.s1Cube = m.s1Cube;
    shader.uniforms.s1Exposure = source1Exposure;
    shader.vertexShader = `uniform vec3 s1Cube[6];\nvarying vec3 vS1Light;\n${shader.vertexShader}`.replace('#include <begin_vertex>',
      `#include <begin_vertex>
  #ifdef USE_SKINNING
    vec3 s1n = normalize(mat3(modelMatrix) * objectNormal); // the skinned normal (three skins it for skinned meshes)
  #else
    vec3 s1n = normalize(mat3(modelMatrix) * normal);
  #endif
  vec3 s1q = s1n * s1n;
  vS1Light = s1q.x * (s1n.x >= 0.0 ? s1Cube[0] : s1Cube[1]) + s1q.y * (s1n.y >= 0.0 ? s1Cube[2] : s1Cube[3]) + s1q.z * (s1n.z >= 0.0 ? s1Cube[4] : s1Cube[5]);`);
    shader.fragmentShader = `uniform float s1Exposure;\nvarying vec3 vS1Light;\n${shader.fragmentShader}`.replace('#include <color_fragment>',
      '#include <color_fragment>\n  diffuseColor.rgb *= vS1Light * s1Exposure;');
  };
  m.customProgramCacheKey = () => 'source1-cube';
}

// an entity model's meshes take the entity's ambient cube (kv._s1light: 18 numbers, lasers-bake source1). Materials
// are made the entity's own first (a tinted one already is: render.js applyTint)
export function lightModel(inst, kv) {
  const v = String(kv?._s1light || '').trim().split(/\s+/).map(Number);
  if (v.length !== 18 || !v.every((x) => Number.isFinite(x) && x >= 0 && x < 64)) return;
  inst.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material) || o.material?.userData?.lightmap !== 'cube') return;
    if (!o.userData.tintBase && !o.userData.s1Own) {
      o.material = convert(o.material);
      done.add(o.material);
      o.userData.s1Own = true;
    }
    const c = o.material.s1Cube?.value;
    if (c) for (let i = 0; i < 6; i++) c[i].set(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
  });
}

function patch(m, range) {
  if (range && m.aoMap) {
    m.aoMap.colorSpace = THREE.NoColorSpace;
    m.aoMap.generateMipmaps = false;
    m.aoMap.minFilter = THREE.LinearFilter;
    const R = Number(range).toFixed(3);
    m.onBeforeCompile = (shader) => {
      shader.uniforms.s1Exposure = source1Exposure;
      shader.fragmentShader = `uniform float s1Exposure;\n${shader.fragmentShader}`;
      shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>',
        `#ifdef USE_AOMAP
          vec4 s1lm = texture2D( aoMap, vAoMapUv );
          reflectedLight.indirectDiffuse *= s1lm.rgb * s1lm.a * ${R} * s1Exposure;
        #endif`);
    };
    m.customProgramCacheKey = () => `source1-rgbm-${R}`;
    m.needsUpdate = true;
  }
  if (m.userData?.additive) {
    m.transparent = true;
    m.blending = THREE.AdditiveBlending;
    m.depthWrite = false;
    m.needsUpdate = true;
  }
}

// the map's 2D sky (manifest sky2d: { rt, bk, lf, ft, up, dn } -> PNG URLs) as the scene background. The scene is in
// Source space (Z up); a cube is sampled Y up, so the faces go in by Source axis and the background turns Z up to Y up.
// Face per axis: ft +X, bk -X, lf +Y, rt -Y, up +Z, dn -Z (Source's skybox naming).
export function source1Sky(sky2d, url, engine) {
  if (engine !== 'source1') return null;
  if (!sky2d || typeof sky2d !== 'object') return { source1: true, texture: null, rotation: null };
  // three's px nx py ny pz nz slots, after the Z-up -> Y-up turn below; three samples a CubeTexture mirrored (its
  // flipEnvMap), hence each axis's opposite face in its slot. Checked in the game with a coloured test cube: looking
  // +X shows ft with up above it, lf on the left and rt on the right
  const order = ['bk', 'ft', 'dn', 'up', 'lf', 'rt'];
  if (!order.every((f) => typeof sky2d[f] === 'string' && /^sky\/(rt|bk|lf|ft|up|dn)\.png$/.test(sky2d[f]))) return { source1: true, texture: null, rotation: null };
  const tex = new THREE.CubeTextureLoader().load(order.map((f) => url(sky2d[f])));
  tex.colorSpace = THREE.SRGBColorSpace;
  return { source1: true, texture: tex, rotation: new THREE.Euler(-Math.PI / 2, 0, 0) };
}
