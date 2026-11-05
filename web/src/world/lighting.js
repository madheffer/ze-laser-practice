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
//   - fog (the map's own env_fog_controller / env_gradient_fog, driven by its I/O: entities/classes/fog.js), on lit
//     colour before the tonemap; the sky (env_sky: its sky.vfx cube, exposure bias, tint) fogged by the controller
//     the way CS2 fogs the 2D sky; a fog's farz is the view distance
//   - reflections: the map's env_cubemap_array, every cubemap volume (env_combined_light_probe_volume / env_cubemap /
//     env_cubemap_box) blended per pixel in CS2's priority order with its edge fade, box parallax (spheres too, as v2),
//     the reflection bent toward the normal by roughness, mip = sqrt(roughness) x (mips - 2), normalised by the
//     lightmap / probe brightness over the cubemap's own baked SH (CUBEMAP_RADIANCE_SH), never brighter (v2)
// Not yet: realtime cascaded shadows, probe blending between volumes, CS2's own EnvBRDF table (three's analytic one).
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
      cs2DirIrr: { value: null }, cs2Shadows: { value: null }, cs2IrrRange: { value: 0 },
      cs2SunMask: { value: new THREE.Vector4(1, 0, 0, 0) },
    };
    this.patched = new WeakMap(); // material -> its lightmapped clone
    this.probePatched = new Map(); // `${material.uuid}:${volume}` -> its probe-lit clone
    this.volumes = [];
    // fog: shared by every patched material (update() fills them each frame)
    this.fogUniforms = {
      cs2FogType: { value: 0 }, cs2FogColor: { value: new THREE.Color(0, 0, 0) },
      cs2FogDist: { value: new THREE.Vector4() }, cs2FogHeight: { value: new THREE.Vector4() }, cs2FogStartSq: { value: 0 },
    };
    this.sky = null; // the sky mesh (setMap)
    this.skyUniforms = {
      cs2SkyTexture: { value: null }, cs2SkyScale: { value: new THREE.Color(1, 1, 1) }, cs2SkyDecodeSrgb: { value: 0 },
      cs2SkyFogColor: { value: new THREE.Color() }, cs2SkyFog: { value: 0 }, cs2SkyRgbm: { value: 0 },
    };
    this.defaultFar = null;
    // reflections: the cube array (as a 2D array of faces) + one row of volume data per cubemap
    this.cubeUniforms = { cs2Cubes: { value: null }, cs2CubeVolumes: { value: null }, cs2CubeCount: { value: 0 }, cs2CubeMips: { value: new THREE.Vector2(0, 0) } };
    this.cubeCount = 0; // the map's; the uniform is 0 while reflections are off (the loop then costs nothing)
    this.options = { fog: true, reflections: true };
    this._color = new THREE.Color(); this._fwd = new THREE.Vector3(); this._dir = new THREE.Vector3();
  }

  // performance settings, instant: fog and reflections are uniforms, so nothing recompiles
  setOptions({ fog = true, reflections = true } = {}) {
    this.options = { fog, reflections };
    this.cubeUniforms.cs2CubeCount.value = reflections ? this.cubeCount : 0;
  }

  // every frame: the fog the player sees now (the engine's fog entities), the view distance, the sky's fog
  update(engine, camera) {
    if (this.defaultFar == null) this.defaultFar = camera.far;
    const fog = this.options.fog && engine?.fogState ? engine.fogState() : { controller: null, gradient: null };
    const u = this.fogUniforms;
    const g = fog.gradient, c = fog.controller?.on ? fog.controller : null;
    let farz = -1;
    if (g) {
      // env_gradient_fog (VRF SceneGradientFog): colour x strength (as stored, /255: no sRGB decode), distance and
      // height terms each biased, scaled and raised to their exponent, times the max opacity
      u.cs2FogType.value = 2;
      u.cs2FogColor.value.setRGB(g.color[0] / 255 * g.strength, g.color[1] / 255 * g.strength, g.color[2] / 255 * g.strength, THREE.LinearSRGBColorSpace);
      const dScale = 1 / Math.max(1e-3, g.end - g.start);
      const hDen = g.startHeight - g.endHeight;
      const hScale = hDen !== 0 ? 1 / hDen : 0, hBias = hDen !== 0 ? -g.endHeight * hScale : 1;
      u.cs2FogDist.value.set(dScale, -g.start * dScale, Math.min(1, Math.max(0, g.opacity * g.weight)), g.exponent);
      u.cs2FogHeight.value.set(hScale, hBias, g.vexponent, g.endHeight);
      u.cs2FogStartSq.value = g.start * g.start;
      farz = g.farz;
    } else if (c) {
      // env_fog_controller: colour (sRGB -> linear) x hdrcolorscale, blended toward the secondary colour by the view
      // direction when fogblend is on; amount = min(maxdensity, ((d - start) / (end - start)) ^ exponent)
      u.cs2FogType.value = 1;
      controllerColor(c, camera, u.cs2FogColor.value, this._fwd, this._dir);
      u.cs2FogDist.value.set(c.start, c.end, Math.min(1, Math.max(0, c.density)), c.exponent);
      farz = c.farz;
    } else u.cs2FogType.value = 0;
    // farz: how far the world draws (the sky stays)
    const far = farz > 0 ? Math.max(256, Math.min(farz, this.defaultFar)) : this.defaultFar;
    if (camera.far !== far) { camera.far = far; camera.updateProjectionMatrix(); }
    // the 2D sky: only the legacy controller fogs it (VRF Renderer: BackgroundFor(...).Render(LinearFog)), at the far plane
    const su = this.skyUniforms;
    if (c) {
      su.cs2SkyFogColor.value.copy(u.cs2FogColor.value);
      const d = Math.min(c.farz > 0 ? c.farz : Infinity, this.defaultFar);
      su.cs2SkyFog.value = Math.min(c.density, Math.max(0, Math.min(1, (d - c.start) / Math.max(1e-3, c.end - c.start))) ** c.exponent);
    } else su.cs2SkyFog.value = 0;
    if (this.sky) this.sky.position.copy(camera.position);
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
    this.uniforms.cs2IrrRange.value = lightmaps.irradianceRange || 0; // a quality tier's RGBM PNG
    const irr = lightmaps.textures.irradiance;
    irr.channel = 1; // the world glb's TEXCOORD_1 is the lightmap UV (unscaled: x lighting.json uvScale)
    irr.repeat.set(lightmaps.uvScale[0], lightmaps.uvScale[1]);
    irr.matrixAutoUpdate = true;
    irr.updateMatrix();
    this.volumes = probeVolumes(ents, lightmaps.probes);
    this.probePatched.clear();
    this.setSky(ents, lightmaps.skies);
    this.setCubemaps(ents, lightmaps.cubemaps);
  }

  // env_cubemap_array as a 2D array texture (layer = array_index x 6 + face: WebGL has no cube arrays), and each
  // cubemap volume's data as rows of a float texture, in CS2's priority order (VRF IndoorPriorityCompare: indoor
  // level first, then the smaller volume, then array_index)
  setCubemaps(ents, cm) {
    const cu = this.cubeUniforms;
    cu.cs2Cubes.value?.dispose(); cu.cs2CubeVolumes.value?.dispose();
    cu.cs2Cubes.value = null; cu.cs2CubeVolumes.value = null; cu.cs2CubeCount.value = 0; this.cubeCount = 0;
    if (!cm) return;
    const layers = cm.faces; // depth x 6
    const tex = new THREE.CompressedArrayTexture(cm.mips.map((m) => ({ data: cm.data.subarray(m.offset, m.offset + m.bytes), width: m.width, height: m.height })),
      cm.width, cm.height, layers, cm.format);
    tex.minFilter = cm.mips.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    const vols = [];
    for (const e of ents) {
      const kv = e?.kv;
      if (!kv || !/^(env_combined_light_probe_volume|env_cubemap|env_cubemap_box)$/.test(kv.classname || '') || kv.customcubemaptexture) continue;
      const idx = parseInt(kv.array_index, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx * 6 + 5 >= layers) continue;
      let lo, hi, fade;
      if (kv.classname === 'env_cubemap') {
        const r = kvNum(kv.influenceradius, 512);
        lo = [-r, -r, -r]; hi = [r, r, r];
        const f = kvNum(kv.edge_fade_dist, 0); fade = [f, f, f];
      } else { lo = parseVec(kv.box_mins); hi = parseVec(kv.box_maxs); fade = parseVec(kv.edge_fade_dists); }
      if (![0, 1, 2].every((i) => hi[i] > lo[i])) continue;
      const o = parseVec(kv.origin), a = parseVec(kv.angles);
      const ent = new THREE.Matrix4().compose(new THREE.Vector3(...o),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(a[2] * Math.PI / 180, a[0] * Math.PI / 180, a[1] * Math.PI / 180, 'ZYX')), new THREE.Vector3(1, 1, 1));
      const worldToLocal = ent.clone().invert();
      // CUBEMAP_RADIANCE_SH -> the luma the cubemap was baked at, as (linear xyz, constant) in world space
      const sh = cm.sh[idx];
      let shv = [0, 0, 0, 0];
      if (sh) {
        const l = [0, 1, 2, 3].map((k) => 0.2126 * sh[k] + 0.7152 * sh[9 + k] + 0.0722 * sh[18 + k]);
        const c0 = l[0] * 0.282095;
        const lin = new THREE.Vector3(-l[3], -l[1], l[2]).multiplyScalar(0.325735).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(ent));
        const max = 0.99 * Math.abs(c0);
        if (lin.length() > max) lin.setLength(max);
        shv = [lin.x, lin.y, lin.z, c0];
      }
      const size = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
      vols.push({ indoor: kvNum(kv.indoor_outdoor_level, 0), size, idx, worldToLocal, lo, hi, fade, shv });
    }
    vols.sort((x, y) => (y.indoor - x.indoor) || (x.size - y.size) || (x.idx - y.idx));
    if (!vols.length) { tex.dispose(); return; }
    // 7 texels a volume: worldToLocal rows (3), mins + array index, maxs, 1 / edge fade, SH (linear, constant)
    const W = 7, data = new Float32Array(W * vols.length * 4);
    vols.forEach((v, r) => {
      const m = v.worldToLocal.elements; // column-major
      const put = (t, x, y, z, w) => data.set([x, y, z, w], (r * W + t) * 4);
      put(0, m[0], m[4], m[8], m[12]); put(1, m[1], m[5], m[9], m[13]); put(2, m[2], m[6], m[10], m[14]);
      put(3, v.lo[0] - 0.1, v.lo[1] - 0.1, v.lo[2] - 0.1, v.idx);
      put(4, v.hi[0] + 0.1, v.hi[1] + 0.1, v.hi[2] + 0.1, 0);
      put(5, ...v.fade.map((f) => (f > 0 ? 1 / f : 3.4e38)), 0);
      put(6, ...v.shv);
    });
    const vt = new THREE.DataTexture(data, W, vols.length, THREE.RGBAFormat, THREE.FloatType);
    vt.minFilter = vt.magFilter = THREE.NearestFilter;
    vt.needsUpdate = true;
    cu.cs2Cubes.value = tex;
    cu.cs2CubeVolumes.value = vt;
    this.cubeCount = vols.length;
    cu.cs2CubeCount.value = this.options.reflections ? vols.length : 0;
    // the mip chain as CS2 counts it (the bake may have skipped the top mips)
    cu.cs2CubeMips.value.set(cm.levels, cm.skipped);
  }

  // env_sky: the first enabled one's sky material, as a cube drawn behind everything (sky.vfx: the texture x
  // 2^(brightness exposure bias + render-only bias) x the entity's tint (sRGB -> linear) x brightnessscale)
  setSky(ents, skies) {
    if (this.sky) { this.scene.remove(this.sky); this.sky.geometry.dispose(); this.sky.material.dispose(); this.skyUniforms.cs2SkyTexture.value?.dispose(); this.sky = null; }
    const kv = ents.find((e) => e?.kv?.classname === 'env_sky' && !['true', '1'].includes(String(e.kv.startdisabled)) && String(e.kv.enabled ?? '1') !== '0')?.kv;
    const key = kv && String(kv.skyname || kv.skybox_material_day || '').replace(/\\/g, '/').toLowerCase().replace(/_c$/, '');
    const sky = key && skies?.[key];
    if (!sky) return;
    const su0 = this.skyUniforms;
    su0.cs2SkyRgbm.value = 0;
    if (sky.rgbmFaces) return this.setSkyMesh(kv, sky, (() => {
      const t = new THREE.CubeTexture(sky.rgbmFaces);
      t.colorSpace = THREE.NoColorSpace; t.flipY = false; t.generateMipmaps = false; t.premultiplyAlpha = false;
      t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
      su0.cs2SkyRgbm.value = sky.range; su0.cs2SkyDecodeSrgb.value = 0;
      return t;
    })());
    const faces = [];
    for (let f = 0; f < 6; f++) {
      faces.push({ width: sky.width, height: sky.height, mipmaps: sky.mips.map((m) => {
        const face = m.bytes / 6;
        return { data: sky.data.subarray(m.offset + f * face, m.offset + (f + 1) * face), width: m.width, height: m.height };
      }) });
    }
    const tex = new THREE.CompressedCubeTexture(faces, sky.format);
    tex.minFilter = sky.mips.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    // an 8-bit sky is sRGB (sky.vfx reads it SrgbRead): decoded by the GPU when it can, else in the shader
    const ldr = sky.kind !== 'bc6h';
    tex.colorSpace = ldr && sky.srgbOk ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.skyUniforms.cs2SkyDecodeSrgb.value = ldr && !sky.srgbOk ? 1 : 0;
    this.setSkyMesh(kv, sky, tex);
  }

  setSkyMesh(kv, sky, tex) {
    const su = this.skyUniforms;
    su.cs2SkyTexture.value = tex;
    const bias = (sky.floats.g_flBrightnessExposureBias || 0) + (sky.floats.g_flRenderOnlyExposureBias || 0);
    const bscale = kvNum(kv.brightnessscale, 1) > 0 ? kvNum(kv.brightnessscale, 1) : 1;
    su.cs2SkyScale.value.copy(kvColor(kv.tint_color)).multiplyScalar(bscale * 2 ** bias);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.ShaderMaterial({
      uniforms: su, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: true,
    }));
    // the drawn cube turns with env_sky's angles; the lookup uses the unturned direction (VRF core/sky.vert)
    const a = parseVec(kv.angles);
    mesh.quaternion.setFromEuler(new THREE.Euler(a[2] * Math.PI / 180, a[0] * Math.PI / 180, a[1] * Math.PI / 180, 'ZYX'));
    mesh.frustumCulled = false;
    mesh.renderOrder = 1e6; // after the opaque world: it only fills what nothing else covered
    this.scene.add(mesh);
    this.sky = mesh;
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
      Object.assign(shader.uniforms, uniforms, this.fogUniforms, this.cubeUniforms);
      shader.vertexShader = worldPosVertex(shader.vertexShader);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lightmap_pars_fragment>', `#include <lightmap_pars_fragment>\n${PROBE_PARS}\n${FOG_PARS}\n${CUBE_PARS(this.cubeUniforms.cs2CubeCount.value > 0)}`)
        .replace('#include <lights_fragment_begin>', PROBE_SUN + LIGHTS_BEGIN_PATCHED)
        .replace('#include <lights_fragment_maps>', LIGHTS_MAPS_PROBES)
        .replace('#include <fog_fragment>', FOG_APPLY);
    }, `cs2probef${this.cubeUniforms.cs2CubeCount.value > 0 ? 'c' : ''}`);
    return m;
  }

  patch(src) {
    const m = src.clone();
    m.lightMap = this.lightmaps.textures.irradiance;
    m.lightMapIntensity = 1;
    const hasDir = !!this.uniforms.cs2DirIrr.value, hasShadow = !!this.uniforms.cs2Shadows.value;
    chainBeforeCompile(m, (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      Object.assign(shader.uniforms, this.fogUniforms, this.cubeUniforms);
      shader.vertexShader = worldPosVertex(shader.vertexShader);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lightmap_pars_fragment>', `#include <lightmap_pars_fragment>\n${PARS(hasDir, hasShadow)}\nvarying vec3 vCs2World;\n${FOG_PARS}\n${CUBE_PARS(this.cubeUniforms.cs2CubeCount.value > 0)}`)
        .replace('#include <lights_fragment_begin>', SUN_VISIBILITY + LIGHTS_BEGIN_PATCHED)
        .replace('#include <lights_fragment_maps>', LIGHTS_MAPS_CS2)
        .replace('#include <fog_fragment>', FOG_APPLY);
    }, `cs2lm${hasDir ? 'd' : ''}${hasShadow ? 's' : ''}f${this.cubeUniforms.cs2CubeCount.value > 0 ? 'c' : ''}`);
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
uniform float cs2IrrRange; // > 0: RGBM (rgb x a x range)
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
  vec4 cs2IrrTexel = texture2D( lightMap, vLightMapUv );
  vec3 cs2Irr = cs2IrrRange > 0.0 ? cs2IrrTexel.rgb * cs2IrrTexel.a * cs2IrrRange : cs2IrrTexel.rgb;
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
#if defined( CS2_CUBEMAPS ) && defined( RE_IndirectSpecular )
  radiance += cs2EnvSpecular( vCs2World, normal, geometryViewDir, material.roughness, cs2Luma( cs2Diffuse ) );
#elif defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
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
#if defined( CS2_CUBEMAPS ) && defined( RE_IndirectSpecular )
  radiance += cs2EnvSpecular( vCs2World, normal, geometryViewDir, material.roughness, dot( irradiance / PI, vec3( 0.2126, 0.7152, 0.0722 ) ) );
#elif defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness )
    * min( 1.0, dot( irradiance, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( dot( getIBLIrradiance( geometryNormal ), vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 ) );
#endif
`;

// ---- fog + sky
// the vertex's world position, for fog (and the probes)
function worldPosVertex(vs) {
  return vs.replace('#include <common>', '#include <common>\nvarying vec3 vCs2World;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvCs2World = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
}

// the controller's colour now: fogblend leans it from the secondary colour toward the primary by how much you look
// along fogdir (CFogController); sRGB -> linear, x hdrcolorscale
function controllerColor(c, camera, out, fwd, dir) {
  let r = c.color[0], g = c.color[1], b = c.color[2];
  if (c.blend && c.dir) {
    camera.getWorldDirection(fwd);
    const t = 0.5 * fwd.dot(dir.set(c.dir[0], c.dir[1], c.dir[2]).normalize()) + 0.5;
    r = c.color2[0] + (r - c.color2[0]) * t; g = c.color2[1] + (g - c.color2[1]) * t; b = c.color2[2] + (b - c.color2[2]) * t;
  }
  return out.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace).multiplyScalar(c.hdr);
}

export const FOG_PARS = `
uniform float cs2FogType; // 0 none, 1 env_fog_controller, 2 env_gradient_fog
uniform vec3 cs2FogColor;
uniform vec4 cs2FogDist;   // 1: start, end, max density, exponent; 2: distance scale, bias, max opacity, exponent
uniform vec4 cs2FogHeight; // 2: height scale, bias, vertical exponent, end height
uniform float cs2FogStartSq;
vec3 cs2ApplyFog( vec3 color, vec3 worldPos ) {
  if ( cs2FogType < 0.5 ) return color;
  float dist = length( worldPos - cameraPosition );
  float amount;
  if ( cs2FogType < 1.5 ) {
    amount = min( cs2FogDist.z, pow( clamp( ( dist - cs2FogDist.x ) / max( cs2FogDist.y - cs2FogDist.x, 1e-3 ), 0.0, 1.0 ), cs2FogDist.w ) );
  } else {
    // VRF fog.slang (CS2): fogged only past the start and inside the height range
    if ( dist * dist <= cs2FogStartSq ) return color;
    if ( cs2FogHeight.z != 0.0 && ( ( cs2FogHeight.x > 0.0 && worldPos.z < cs2FogHeight.w ) || ( cs2FogHeight.x < 0.0 && worldPos.z > cs2FogHeight.w ) ) ) return color;
    vec2 c = clamp( vec2( dist, worldPos.z ) * vec2( cs2FogDist.x, cs2FogHeight.x ) + vec2( cs2FogDist.y, cs2FogHeight.y ), 0.0001, 1.0 );
    c = pow( c, vec2( cs2FogDist.w, cs2FogHeight.z ) );
    amount = c.x * c.y * cs2FogDist.z;
  }
  return mix( color, cs2FogColor, clamp( amount, 0.0, 1.0 ) );
}
`;
// three's fog_fragment slot: after lighting, before any tone mapping (the world renders into the HDR target)
const FOG_APPLY = `gl_FragColor.rgb = cs2ApplyFog( gl_FragColor.rgb, vCs2World );`;

const SKY_VS = `
varying vec3 vCs2SkyDir;
void main() {
  vCs2SkyDir = position; // the unturned direction (Source Z up): the lookup, as VRF's sky shader
  vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position = p.xyww; // on the far plane: behind everything
}`;
const SKY_FS = `
uniform samplerCube cs2SkyTexture;
uniform vec3 cs2SkyScale;
uniform float cs2SkyDecodeSrgb;
uniform vec3 cs2SkyFogColor;
uniform float cs2SkyFog;
uniform float cs2SkyRgbm; // > 0: RGBM faces (a quality tier)
varying vec3 vCs2SkyDir;
void main() {
  vec4 t = textureCube( cs2SkyTexture, normalize( vCs2SkyDir ) ); // faces as the vtex stores them, Source directions
  vec3 c = cs2SkyRgbm > 0.0 ? t.rgb * t.a * cs2SkyRgbm : t.rgb;
  if ( cs2SkyDecodeSrgb > 0.5 ) c = pow( c, vec3( 2.2 ) );
  c *= cs2SkyScale;
  gl_FragColor = vec4( mix( c, cs2SkyFogColor, cs2SkyFog ), 1.0 );
}`;

// ---- reflections (VRF common/envmap.slang, CS2 = lightmap version 2)
const CUBE_PARS = (on) => !on ? '' : `
#define CS2_CUBEMAPS
uniform highp sampler2DArray cs2Cubes;      // layer = array_index * 6 + face (+X -X +Y -Y +Z -Z)
uniform highp sampler2D cs2CubeVolumes;     // 7 texels per volume, in priority order
uniform int cs2CubeCount;
uniform vec2 cs2CubeMips;                   // CS2's mip count, mips the bake skipped
// a cube direction (as GL picks the face) -> the face's layer offset and uv
vec3 cs2CubeFace( vec3 d ) {
  vec3 a = abs( d );
  float face; vec2 st; float ma;
  if ( a.x >= a.y && a.x >= a.z ) { ma = a.x; face = d.x > 0.0 ? 0.0 : 1.0; st = d.x > 0.0 ? vec2( -d.z, -d.y ) : vec2( d.z, -d.y ); }
  else if ( a.y >= a.z ) { ma = a.y; face = d.y > 0.0 ? 2.0 : 3.0; st = d.y > 0.0 ? vec2( d.x, d.z ) : vec2( d.x, -d.z ); }
  else { ma = a.z; face = d.z > 0.0 ? 4.0 : 5.0; st = d.z > 0.0 ? vec2( d.x, -d.y ) : vec2( -d.x, -d.y ); }
  return vec3( st / ma * 0.5 + 0.5, face );
}
vec4 cs2Vol( int i, int t ) { return texelFetch( cs2CubeVolumes, ivec2( t, i ), 0 ); }
// the reflection: every volume around the pixel, by priority, until covered; normalised by the diffuse light
vec3 cs2EnvSpecular( vec3 posWS, vec3 normalVS, vec3 viewVS, float roughness, float diffuseLuma ) {
  vec3 N = normalize( ( vec4( normalVS, 0.0 ) * viewMatrix ).xyz );
  vec3 V = normalize( ( vec4( viewVS, 0.0 ) * viewMatrix ).xyz );
  vec3 R = reflect( -V, N );
  // bent toward the normal as the surface roughens (GetDominantReflectionFactor)
  float r2 = roughness * roughness, rSq = r2 * r2;
  float s = clamp( 1.0 - rSq, 0.0, 1.0 );
  R = normalize( mix( N, R, s * ( sqrt( s ) + rSq ) ) );
  float lod = max( 0.0, sqrt( roughness ) * ( cs2CubeMips.x - 2.0 ) - cs2CubeMips.y );
  vec3 env = vec3( 0.0 ); float envLuma = 0.0; float total = 0.01;
  // bounded by the uniform, not a constant: a constant bound gets fully unrolled by ANGLE's D3D compiler
  for ( int i = 0; i < cs2CubeCount; i++ ) {
    if ( total > 0.99 ) break;
    mat3x4 w2l = mat3x4( cs2Vol( i, 0 ), cs2Vol( i, 1 ), cs2Vol( i, 2 ) );
    vec3 lp = vec4( posWS, 1.0 ) * w2l;
    vec4 mn = cs2Vol( i, 3 ); vec3 mx = cs2Vol( i, 4 ).xyz; vec3 inv = cs2Vol( i, 5 ).xyz;
    vec3 f = min( clamp( ( lp - mn.xyz ) * inv, 0.0, 1.0 ), clamp( ( mx - lp ) * inv, 0.0, 1.0 ) );
    float fade = min( f.x, min( f.y, f.z ) );
    if ( fade <= 0.0 ) continue;
    float weight = smoothstep( 0.0, 1.0, fade ) * ( 1.0 - total );
    // box parallax: where the reflection leaves the box, mixed back toward the plain direction by roughness
    vec3 lr = vec4( R, 0.0 ) * w2l;
    vec3 first = ( mn.xyz - lp ) / lr, second = ( mx - lp ) / lr;
    vec3 far3 = max( first, second );
    float dist = abs( min( far3.x, min( far3.y, far3.z ) ) );
    vec3 dir = mix( lp + lr * dist, lr, roughness );
    vec3 uvf = cs2CubeFace( dir );
    env += textureLod( cs2Cubes, vec3( uvf.xy, mn.w * 6.0 + uvf.z ), lod ).rgb * weight;
    vec4 sh = cs2Vol( i, 6 );
    envLuma += dot( vec4( N, 1.0 ), sh ) * weight;
    total += weight;
  }
  env /= total; envLuma /= total;
  // CS2 v2: the cubemap is only ever darkened toward the lightmap's brightness, never brightened
  return env * min( diffuseLuma / max( envLuma, 1e-4 ), 1.0 );
}
`;
