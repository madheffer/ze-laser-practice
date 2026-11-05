// How CS2 lights a map, from the map's own data (truth source: the open-source VRF renderer's CS2 shading,
// Renderer/Shaders/common/lighting.slang, lightmap game version 2 = CS2):
//   - the static world: the baked lightmaps (world/lightmaps.js). Its indirect light is the irradiance shaped by the
//     directional lightmap in tangent space (ComputeLightmapShading: clamped dominant direction, "flatness boost"
//     from curvature, the non-directional share in the direction texture's z), and nothing else: no ambient, no
//     sky light on top. Lights with directlight 1 ("fully baked") are inside it, the sun included.
//   - the sun (light_environment with directlight 2 / 3): added per pixel, colour (sRGB -> linear) x brightness x
//     N.L, masked by its channel of the baked shadow mask (bakedshadowindex: 0 R .. 3 A; 1 = fully shadowed).
//   - CS2's diffuse has no 1/pi (DiffuseColor x (direct + indirect)); three's Lambert divides by pi, so the
//     lightmap irradiance and the sun's intensity are multiplied by pi here to land on CS2's numbers.
//   - what has no lightmap (props, moving models): the light probe volumes (lighting_lpv.slang): an ambient cube per
//     probe (6 faces, weighted by the normal squared), from the smallest volume around the object, the sun masked
//     by the probe's baked visibility. The grids are box-filtered 4x per axis in the bake (bake/ProbeBake.cs).
//     Outside every volume: the sky's ambient.
// Not yet: env_cubemap reflections (three's stock environment, darkened toward the lightmap the way CS2 normalises
// cubemaps), realtime cascaded shadows, probe edge fades / blending between volumes.
//
//   const lighting = new MapLighting(scene, renderer)
//   lighting.setMap(entities, lightmaps)   // per map (lightmaps: world/lightmaps.js, or null = the old fallback)
//   lighting.applyToWorld(root)            // after the world glb is in the scene
//   lighting.ambient                       // the map's sky ambient (THREE.Color, linear): particles read it
import * as THREE from 'three';
import { ShaderChunk } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { parseVec, angleForward } from './entities/index.js';
import { chainBeforeCompile } from '../lib/shader.js';

// the fallback (no baked lighting, or a GPU without the formats): what the renderer always had
const FALLBACK = { hemiSky: 0xdde8ff, hemiGround: 0x3a3328, hemi: 1.1, sun: 0xfff1d6, sunIntensity: 1.6, sunDir: [0.4, 0.3, 1] };

// a "[ r, g, b ]" or "r g b [a]" colour keyvalue (0-255, sRGB) -> THREE.Color in the linear working space
function kvColor(s, fallback = [255, 255, 255]) {
  const v = String(s ?? '').replace(/[[\],]/g, ' ').trim().split(/\s+/).map(Number);
  const c = v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? v : fallback;
  return new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
}
const kvNum = (s, d) => { const n = parseFloat(s); return Number.isFinite(n) ? n : d; };

export class MapLighting {
  constructor(scene, renderer) {
    this.scene = scene;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.hemi = new THREE.HemisphereLight(FALLBACK.hemiSky, FALLBACK.hemiGround, FALLBACK.hemi);
    this.sun = new THREE.DirectionalLight(FALLBACK.sun, FALLBACK.sunIntensity);
    this.sun.position.set(...FALLBACK.sunDir);
    scene.add(this.hemi, this.sun, this.sun.target);
    this.ambient = new THREE.Color(1, 1, 1);
    this.lightmaps = null;
    // shared by every lightmapped material's shader
    this.uniforms = {
      cs2DirIrr: { value: null }, cs2Shadows: { value: null },
      cs2SunMask: { value: new THREE.Vector4(1, 0, 0, 0) },
    };
    this.patched = new WeakMap(); // material -> its lightmapped clone
    this.probePatched = new Map(); // `${material.uuid}:${volume}` -> its probe-lit clone
    this.volumes = [];
  }

  // light_environment -> the sun and the sky ambient; lightmaps -> the world shading
  setMap(entities, lightmaps) {
    this.lightmaps = lightmaps;
    const ents = Object.values(entities?.lumps || {}).flat();
    const env = ents.find((e) => e?.kv?.classname === 'light_environment' && String(e.kv.enabled ?? 'true') !== 'false')?.kv;
    if (!lightmaps || !env) { this.fallback(); return; }
    // the sun: forward = the entity's angles; the light shines along it (three: from position toward target)
    const fwd = angleForward(parseVec(env.angles));
    this.sun.position.set(-fwd[0], -fwd[1], -fwd[2]);
    this.sun.target.position.set(0, 0, 0);
    const brightness = kvNum(env.brightness, 1) * kvNum(env.brightnessscale, 1);
    this.sun.color.copy(kvColor(env.color));
    this.sun.intensity = brightness * Math.PI;
    // directlight 1 = fully baked into the lightmap: no runtime sun (it would count twice)
    const direct = parseInt(env.directlight ?? '2', 10);
    this.sun.visible = direct === 2 || direct === 3;
    const idx = parseInt(env.bakedshadowindex ?? env.bakelightindex ?? '-1', 10);
    this.uniforms.cs2SunMask.value.set(idx === 0 ? 1 : 0, idx === 1 ? 1 : 0, idx === 2 ? 1 : 0, idx === 3 ? 1 : 0);
    // the sky's ambient: what non-lightmapped things (models, particles) get until light probes are done
    this.ambient.copy(kvColor(env.skycolor)).multiplyScalar(kvNum(env.skyintensity, 1));
    this.hemi.color.copy(this.ambient);
    this.hemi.groundColor.copy(this.ambient).multiplyScalar(0.5);
    this.hemi.intensity = Math.PI; // the same pi: hemisphere irradiance goes through three's Lambert
    this.uniforms.cs2DirIrr.value = lightmaps.textures.directional_irradiance || null;
    this.uniforms.cs2Shadows.value = lightmaps.textures.direct_light_shadows || null;
    const irr = lightmaps.textures.irradiance;
    irr.channel = 1; // the world glb's TEXCOORD_1 is the lightmap UV (unscaled: x lighting.json uvScale)
    irr.repeat.set(lightmaps.uvScale[0], lightmaps.uvScale[1]);
    irr.matrixAutoUpdate = true;
    irr.updateMatrix();
    this.volumes = probeVolumes(ents, lightmaps.probes);
    this.probePatched.clear();
  }

  fallback() {
    this.hemi.color.set(FALLBACK.hemiSky); this.hemi.groundColor.set(FALLBACK.hemiGround); this.hemi.intensity = FALLBACK.hemi;
    this.sun.color.set(FALLBACK.sun); this.sun.intensity = FALLBACK.sunIntensity; this.sun.visible = true;
    this.sun.position.set(...FALLBACK.sunDir);
    this.ambient.setRGB(1, 1, 1);
  }

  // every world mesh with lightmap UVs gets the CS2 lightmap shading (a clone of its material, so a material it
  // shares with a mesh without lightmap UVs stays as it was); the rest are lit by their light probe volume
  applyToWorld(root) {
    if (!this.lightmaps) return;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.geometry?.attributes?.uv1) { this.applyProbes(o); return; }
      const one = (m) => {
        if (!m || !m.isMeshStandardMaterial) return m;
        if (!this.patched.has(m)) this.patched.set(m, this.patch(m));
        return this.patched.get(m);
      };
      o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
    });
  }

  // a mesh without a lightmap (a prop, an entity's model): the probes of the smallest volume around its centre
  applyProbes(mesh) {
    if (!this.volumes.length || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const c = mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    let best = -1, bestSize = Infinity;
    for (let i = 0; i < this.volumes.length; i++) {
      const v = this.volumes[i];
      const l = c.clone().applyMatrix4(v.worldToLocal);
      if (l.x < 0 || l.y < 0 || l.z < 0 || l.x > 1 || l.y > 1 || l.z > 1) continue;
      if (v.size < bestSize) { best = i; bestSize = v.size; }
    }
    if (best < 0) return; // outside every volume: the sky's ambient (the hemisphere light)
    const one = (m) => {
      if (!m || !m.isMeshStandardMaterial) return m;
      const key = `${m.uuid}:${best}`;
      if (!this.probePatched.has(key)) this.probePatched.set(key, this.patchProbes(m, this.volumes[best]));
      return this.probePatched.get(key);
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
  }

  patchProbes(src, vol) {
    const m = src.clone();
    const uniforms = { cs2Probe: { value: vol.texture }, cs2ProbeWorldToLocal: { value: vol.worldToLocal }, cs2ProbeDims: { value: vol.dims } };
    chainBeforeCompile(m, (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCs2World;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvCs2World = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lightmap_pars_fragment>', `#include <lightmap_pars_fragment>\n${PROBE_PARS}`)
        .replace('#include <lights_fragment_begin>', PROBE_SUN + LIGHTS_BEGIN_PATCHED)
        .replace('#include <lights_fragment_maps>', LIGHTS_MAPS_PROBES);
    }, 'cs2probe');
    return m;
  }

  patch(src) {
    const m = src.clone();
    m.lightMap = this.lightmaps.textures.irradiance;
    m.lightMapIntensity = 1;
    const hasDir = !!this.uniforms.cs2DirIrr.value, hasShadow = !!this.uniforms.cs2Shadows.value;
    chainBeforeCompile(m, (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lightmap_pars_fragment>', `#include <lightmap_pars_fragment>\n${PARS(hasDir, hasShadow)}`)
        .replace('#include <lights_fragment_begin>', SUN_VISIBILITY + LIGHTS_BEGIN_PATCHED)
        .replace('#include <lights_fragment_maps>', LIGHTS_MAPS_CS2);
    }, `cs2lm${hasDir ? 'd' : ''}${hasShadow ? 's' : ''}`);
    return m;
  }
}

// The probe volumes: the entities' boxes, transforms and grid sizes, matched to the bake's grids by order + handshake.
// worldToLocal maps a world position into the volume's box as 0..1 (VRF's WorldToLocalVolumeNormalized).
function probeVolumes(ents, probes) {
  const list = ents.filter((e) => /^env_(combined_)?light_probe_volume$/.test(e?.kv?.classname || ''));
  const out = [];
  for (const p of probes || []) {
    const kv = list[p.index]?.kv;
    if (!kv || String(kv.handshake ?? '') !== p.handshake) continue;
    const lo = parseVec(kv.box_mins), hi = parseVec(kv.box_maxs);
    const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    if (!size.every((v) => v > 0)) continue;
    const o = parseVec(kv.origin), a = parseVec(kv.angles);
    // Source angles (pitch, yaw, roll): rotate roll about X, then pitch about Y, then yaw about Z
    const ent = new THREE.Matrix4().compose(new THREE.Vector3(...o),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(a[2] * Math.PI / 180, a[0] * Math.PI / 180, a[1] * Math.PI / 180, 'ZYX')),
      new THREE.Vector3(1, 1, 1));
    const worldToLocal = new THREE.Matrix4().makeScale(1 / size[0], 1 / size[1], 1 / size[2])
      .multiply(new THREE.Matrix4().makeTranslation(-lo[0], -lo[1], -lo[2]))
      .multiply(ent.clone().invert());
    const [gx, gy, gz] = p.dims;
    const texture = new THREE.Data3DTexture(p.data, gx, gy, gz * 6);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.HalfFloatType;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.NoColorSpace;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    out.push({ worldToLocal, texture, dims: new THREE.Vector3(gx, gy, gz), size: size[0] * size[1] * size[2] });
  }
  return out;
}

// ---- shader pieces (three r170 chunks: lightmap_pars_fragment, lights_fragment_begin, lights_fragment_maps)
const PARS = (hasDir, hasShadow) => `
${hasDir ? '#define CS2_DIRECTIONAL' : ''}
${hasShadow ? '#define CS2_SHADOWS' : ''}
uniform sampler2D cs2DirIrr;
uniform sampler2D cs2Shadows;
uniform vec4 cs2SunMask;
const float CS2_LM_MIN_Z = 0.0872; // sin(5 degrees): LIGHTMAP_DIRECTION_MIN_Z
const float CS2_LM_MAX_XY = 0.99619; // sqrt(1 - MIN_Z^2)
float cs2Luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// ComputeLightmapShading, CS2 (LIGHTMAP_DIRECTION_CLAMP + LIGHTMAP_FLATNESS_BOOST); normals in view space
vec3 cs2LightmapShading(vec3 irr, vec4 dir, vec3 Nts, vec3 geoN, vec3 pos) {
  vec2 xy = dir.xy * 2.0 - 1.0;
  xy *= CS2_LM_MAX_XY / max(CS2_LM_MAX_XY, length(xy));
  float cosTheta = sqrt(max(0.0, 1.0 - dot(xy, xy)));
  float curvature = length(fwidth(geoN)) / max(length(fwidth(pos)), 1e-6);
  float flatness = smoothstep(0.1, 0.01, curvature) * 0.8;
  float zScale = mix(1.0, mix(0.1, 2.0, clamp((1.0 - cosTheta) * 1.5, 0.0, 1.0)), flatness);
  vec3 L = normalize(vec3(xy, cosTheta * zScale));
  vec3 nonDir = irr * clamp(dir.z, 0.0, 1.0);
  float NoL = max(dot(L, Nts), 0.0);
  return NoL * (irr - nonDir) / max(L.z, 1e-4) + nonDir;
}
`;

// the sun's baked visibility, before the light loop reads it
const SUN_VISIBILITY = `
#ifdef CS2_SHADOWS
  float cs2SunVis = clamp(1.0 - dot(texture2D(cs2Shadows, vLightMapUv), cs2SunMask), 0.0, 1.0);
#else
  float cs2SunVis = 1.0;
#endif
`;

// lights_fragment_begin with the (one) directional light, the sun, masked by its baked shadow
const BEGIN = ShaderChunk.lights_fragment_begin;
const ANCHOR = 'getDirectionalLightInfo( directionalLight, directLight );';
if (!BEGIN.includes(ANCHOR)) console.warn('lighting: three.js lights_fragment_begin changed; the sun is unmasked');
const LIGHTS_BEGIN_PATCHED = BEGIN.replace(ANCHOR, `${ANCHOR}\n\t\tdirectLight.color *= cs2SunVis;`);

// lights_fragment_maps: the lightmap is the whole indirect diffuse (what the light loop put in irradiance, the
// fallback hemisphere, is dropped); the stock environment's specular is darkened toward the lightmap's brightness
// (CS2's cubemap normalisation, which in CS2 can only darken)
const LIGHTS_MAPS_CS2 = `
#if defined( RE_IndirectDiffuse )
  vec3 cs2Irr = texture2D( lightMap, vLightMapUv ).rgb;
  #ifdef CS2_DIRECTIONAL
    vec4 cs2Dir = texture2D( cs2DirIrr, vLightMapUv );
    vec3 cs2Nts = vec3( 0.0, 0.0, 1.0 );
    #if defined( USE_NORMALMAP_TANGENTSPACE )
      cs2Nts = normalize( vec3( dot( normal, tbn[ 0 ] ), dot( normal, tbn[ 1 ] ), dot( normal, nonPerturbedNormal ) ) );
    #endif
    vec3 cs2Diffuse = cs2LightmapShading( cs2Irr, cs2Dir, cs2Nts, nonPerturbedNormal, - vViewPosition );
  #else
    vec3 cs2Diffuse = cs2Irr;
  #endif
  irradiance = cs2Diffuse * PI; // three's BRDF_Lambert divides by pi; CS2's diffuse doesn't
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  {
    vec3 cs2Env = radiance + getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
    float cs2EnvLum = max( cs2Luma( getIBLIrradiance( geometryNormal ) ), 1e-4 );
    radiance = cs2Env * min( 1.0, cs2Luma( cs2Diffuse * PI ) / cs2EnvLum );
  }
#endif
`;

// ---- probe-lit (no lightmap): lighting_lpv.slang's ambient cube, in one volume
const PROBE_PARS = `
uniform highp sampler3D cs2Probe;
uniform mat4 cs2ProbeWorldToLocal;
uniform vec3 cs2ProbeDims;
varying vec3 vCs2World;
// the probe grid position, kept half a probe inside so a face never bleeds into the next face's block
vec3 cs2ProbeCoord() {
  vec3 c = ( cs2ProbeWorldToLocal * vec4( vCs2World, 1.0 ) ).xyz;
  vec3 border = 0.5 / cs2ProbeDims;
  return clamp( c, border, 1.0 - border );
}
// faces 0..5 = +X +Y +Z -X -Y -Z, each a sixth of the depth (as CS2's atlas)
vec4 cs2ProbeFace( vec3 c, float face ) { return texture( cs2Probe, vec3( c.xy, ( face + c.z ) / 6.0 ) ); }
vec3 cs2ProbeIrradiance( vec3 c, vec3 n ) {
  vec3 f = mix( vec3( 0.0, 1.0, 2.0 ), vec3( 3.0, 4.0, 5.0 ), step( n, vec3( 0.0 ) ) );
  vec3 n2 = n * n;
  return cs2ProbeFace( c, f.x ).rgb * n2.x + cs2ProbeFace( c, f.y ).rgb * n2.y + cs2ProbeFace( c, f.z ).rgb * n2.z;
}
`;

// the sun on a probe-lit surface: masked by the probe's baked visibility (the bake keeps it in every face's alpha)
const PROBE_SUN = `
  vec3 cs2PC = cs2ProbeCoord();
  float cs2SunVis = cs2ProbeFace( cs2PC, 0.0 ).a;
`;

const LIGHTS_MAPS_PROBES = `
#if defined( RE_IndirectDiffuse )
  vec3 cs2WorldN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
  irradiance = cs2ProbeIrradiance( cs2PC, cs2WorldN ) * PI; // three's Lambert divides by pi; CS2's doesn't
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness )
    * min( 1.0, dot( irradiance, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( dot( getIBLIrradiance( geometryNormal ), vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 ) );
#endif
`;
