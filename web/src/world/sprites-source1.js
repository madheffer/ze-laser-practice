// A Source 1 map's env_sprite glows (lasers-bake source1: sprites/sprites.json + PNGs; entities/classes/sprites.js
// keeps each one on or off). Drawn as Source's C_SpriteRenderer draws a sprite material:
//  - a quad of the texture's size in texels x the entity's scale (1 texel a unit at scale 1), centred on the entity,
//    facing the view (vp_parallel, the Sprite shader's default orientation)
//  - colour = rendercolor x hdrcolorscale; alpha = renderamt, pulsing for renderfx 1-4 (ComputeFxBlend: slow / fast
//    pulse, +-16 at 2 / 8 rad a second; wide pulse +-64), the entity's id standing in for its index in the phase
//  - render modes 3, 5, 7, 8, 9 (glow, additive, additive frame blend, alpha-add, world glow) add; others blend
// UNSETTLED: Source fades a glow (modes 3 / 9) by an occlusion query of glowproxysize and draws it without a depth
// test; here the depth test stands in for that query. Mode 3's screen-constant size is drawn at world size. An
// animated sprite shows its first frame.
import * as THREE from 'three';
import { safeRelPath } from '../lib/paths.js';
import { parseVec } from './entities/math.js';

const ADDITIVE = new Set(['3', '5', '7', '8', '9']);
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

export class Source1Sprites {
  // manifest.sprites -> the index, or null for a map without one
  static async load(manifest, url, fetchJson) {
    const path = manifest?.sprites;
    if (typeof path !== 'string' || safeRelPath(path) == null) return null;
    const json = await fetchJson(url(path)).catch(() => null);
    if (!json || typeof json !== 'object') return null;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const index = new Map();
    for (const [k, v] of Object.entries(json)) {
      const file = typeof v?.file === 'string' && /^[a-z0-9_]{1,120}\.png$/.test(v.file) ? v.file : null;
      const w = Number(v?.width), h = Number(v?.height);
      if (file && w > 0 && h > 0 && w <= 8192 && h <= 8192) index.set(k.toLowerCase(), { url: url(dir + file), width: w, height: h });
    }
    return new Source1Sprites(index);
  }

  constructor(index) {
    this.index = index;
    this.textures = new Map();
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.loader = new THREE.TextureLoader();
  }

  key(e) { return String(e.kv.model || '').replace(/\\/g, '/').toLowerCase(); }
  has(e) { return this.index.has(this.key(e)); }

  texture(entry) {
    let t = this.textures.get(entry.url);
    if (!t) {
      t = this.loader.load(entry.url);
      t.colorSpace = THREE.SRGBColorSpace;
      this.textures.set(entry.url, t);
    }
    return t;
  }

  // the sprite's mesh for entity e (kind 'sprite': Renderer.updateEntities places it every frame through update())
  create(e) {
    const entry = this.index.get(this.key(e));
    const additive = ADDITIVE.has(String(e.kv.rendermode ?? '0').trim());
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture(entry), transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(this.geometry, mat);
    mesh.userData.kind = 'sprite';
    mesh.userData.entry = entry;
    mesh.userData.additive = additive;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false; // placed in world space by update()
    mesh.frustumCulled = false;
    return mesh;
  }

  update(mesh, e, camera, time) {
    const kv = e.kv, entry = mesh.userData.entry;
    let amt = Number(kv.renderamt ?? 255);
    if (!Number.isFinite(amt)) amt = 255;
    const fx = Number(kv.renderfx) | 0, phase = (e.id || 0) * 363.0;
    if (fx === 1) amt += 16 * Math.sin(time * 2 + phase);
    else if (fx === 2) amt += 16 * Math.sin(time * 8 + phase);
    else if (fx === 3) amt += 64 * Math.sin(time * 2 + phase);
    else if (fx === 4) amt += 64 * Math.sin(time * 8 + phase);
    const alpha = Math.min(255, Math.max(0, amt)) / 255;
    mesh.visible = !!e.state.on && alpha > 0;
    if (!mesh.visible) return;
    const rc = parseVec(kv.rendercolor, [255, 255, 255]);
    const hdr = Number(kv.hdrcolorscale ?? 1);
    _c.setRGB(rc[0] / 255, rc[1] / 255, rc[2] / 255).multiplyScalar(Number.isFinite(hdr) && hdr > 0 ? hdr : 1);
    if (mesh.userData.additive) { mesh.material.color.copy(_c).multiplyScalar(alpha); mesh.material.opacity = 1; }
    else { mesh.material.color.copy(_c); mesh.material.opacity = alpha; }
    const sc = Number(kv.scale);
    const scale = Number.isFinite(sc) && sc > 0 ? sc : 1;
    const o = e.worldOrigin();
    _p.set(o[0], o[1], o[2]);
    camera.getWorldQuaternion(_q);
    _s.set(entry.width * scale, entry.height * scale, 1);
    mesh.matrixWorld.compose(_p, _q, _s);
  }
}
