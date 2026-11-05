// CS2 water: a mesh whose vmat runs one of CS2's water shaders is drawn with that shader, ported, instead of the flat
// glTF material VRF exports for it: csgo_water_fancy.vfx (water-fancy.js) and csgo_water.vfx (water-basic.js). Every
// parameter comes from the vmat itself (the glb keeps it in extras.vmat), its textures from the bake (lasers-bake
// --water: water/water.json + PNGs), the light from the map's lighting (world/lighting.js) and the frame behind the
// water from the scene copy (world/scenecopy.js). Any future map whose water uses these shaders is drawn the same way;
// a water shader not ported here is logged once and keeps the flat material.
//
//   const water = new Water(lighting)
//   water.setMap(map.water)            // loadMap's { textures: { vtex: url }, frames: { vtex: n } } (null: none baked)
//   water.material(m, { lit })         // a material -> its water material (null: not CS2 water); lit: lightmap UVs
//   water.track(mesh)                  // a mesh now drawn with one (for wantsCopy)
//   water.setQuality(level)            // 'low' | 'medium' | 'high' (Renderer.setQuality)
//   water.frame(camera, time)          // every frame: time, camera, sun, is any water in view (wantsCopy)
import * as THREE from 'three';
import { FANCY_SHADER, fancyMaterial } from './water-fancy.js';
import { BASIC_SHADER, basicMaterial } from './water-basic.js';
import { texel } from './water-common.js';

const LEVELS = ['low', 'medium', 'high'];

export class Water {
  constructor(lighting) {
    this.lighting = lighting;
    this.level = 'high';
    this.textures = new Map(); // url -> THREE.Texture
    this.materials = new Map(); // `${vmat}|${lit}` -> ShaderMaterial
    this.meshes = new Set(); // water meshes in the scene, for wantsCopy
    this.wantsCopy = false;
    this.neutral = new Map(); // a slot's one-texel stand-in
    this.warned = new Set();
    this.urls = {}; this.frames = {};
    // per frame, shared by every water material
    this.shared = {
      g_flTime: { value: 0 }, uSunColor: { value: new THREE.Vector3() }, uSunDiffuse: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 0, 1) }, uAmbient: { value: new THREE.Vector3(1, 1, 1) },
      uCamDir: { value: new THREE.Vector3() }, uCamUp: { value: new THREE.Vector3() }, uProjection: { value: new THREE.Matrix4() },
      uLightmap: { value: null }, uLightmapUvTransform: { value: new THREE.Matrix3() },
    };
    this.ctx = { lighting, shared: this.shared, texture: (slot, vtex, spec) => this.texture(slot, vtex, spec) };
    this._frustum = new THREE.Frustum(); this._vp = new THREE.Matrix4(); this._sphere = new THREE.Sphere();
  }

  // a new world: drop the last map's materials and textures
  setMap(water) {
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.materials.clear(); this.textures.clear(); this.meshes.clear();
    this.urls = water?.textures || {};
    this.frames = water?.frames || {};
  }

  setQuality(level) {
    const l = LEVELS.includes(level) ? level : 'high';
    if (l === this.level) return;
    this.level = l;
    for (const m of this.materials.values()) m.userData.applyLevel(l);
  }

  // the baked texture for a slot (a texture array when the bake says it has frames), else a neutral texel
  texture(slot, vtex, spec) {
    const url = vtex && this.urls[vtex];
    const frames = url ? Math.floor(this.frames[vtex] || 0) : 0;
    if (!url || (spec.array && !(frames >= 1))) {
      const k = `${slot}|${!!spec.array}`;
      if (!this.neutral.has(k)) this.neutral.set(k, texel(spec.rgba, spec.srgb, spec.array));
      return this.neutral.get(k);
    }
    let t = this.textures.get(url);
    if (t) return t;
    if (spec.array) {
      // a strip of `frames` slices, top to bottom (WaterBake.cs), uploaded as a texture array once it loads
      t = new THREE.DataArrayTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1);
      new THREE.ImageLoader().load(url, (img) => {
        const w = img.width, h = Math.floor(img.height / frames);
        if (!w || !h) return;
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h * frames;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        t.image = { data: new Uint8Array(g.getImageData(0, 0, w, h * frames).data.buffer), width: w, height: h, depth: frames };
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.dispose(); // its storage was made for the 1 x 1 stand-in: three allocates it again at the new size
        t.needsUpdate = true;
      });
    } else {
      t = new THREE.TextureLoader().load(url);
      t.anisotropy = 4;
    }
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.colorSpace = spec.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    this.textures.set(url, t);
    return t;
  }

  // a material -> the water material for its vmat (one per vmat and lighting), or null when it isn't CS2 water.
  // lit: the mesh has lightmap UVs and the map's lightmaps are loaded (else the fancy shader takes the sky ambient)
  material(src, { lit = true } = {}) {
    const vmat = src?.userData?.vmat;
    const shader = String(vmat?.ShaderName || '').toLowerCase();
    if (!vmat || !/water/.test(shader)) return null;
    if (shader !== FANCY_SHADER && shader !== BASIC_SHADER) {
      if (!this.warned.has(shader)) { this.warned.add(shader); console.warn(`water: ${shader} isn't ported (world/water.js); ${vmat.Name} draws flat`); }
      return null;
    }
    const useLm = shader === FANCY_SHADER && lit && !!this.lighting.lightmaps;
    const name = String(vmat.Name || src.name);
    const key = `${name}|${useLm}`;
    let m = this.materials.get(key);
    if (!m) {
      m = shader === FANCY_SHADER ? fancyMaterial(this.ctx, vmat, src, name, useLm) : basicMaterial(this.ctx, vmat, src, name);
      m.userData.applyLevel(this.level);
      this.materials.set(key, m);
    }
    return m;
  }

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
    s.uAmbient.value.set(L.ambient.r, L.ambient.g, L.ambient.b);
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
