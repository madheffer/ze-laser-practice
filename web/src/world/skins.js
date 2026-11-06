// Model skins (material groups): the Skin input / `skin` keyvalue swaps each material of a model's default group for
// the same slot of another group (CS2 CBaseModelEntity). The bake writes the groups and the non-default materials
// (bake/SkinBake.cs: maps/<map>/skins.json + models/skins/*.png); the glb has group 0's.
//
// A swapped mesh gets a material built from the glb's own exported one (so it keeps the export's setup: UVs, alpha,
// sides) with the skin's colour / self-illum mask / normal textures and its vmat params, then the renderer's usual
// passes (self-illum, unlit, ...: `finish`). ze_rush_b's 3D-skybox tube is a 27-frame flipbook the map steps through
// every 0.04 s, so a model's skin textures all load the first time it leaves its default skin.
// Untrusted: model keys as the bake wrote them, texture names checked (safeRelPath), at most MAX_GROUPS groups.
import * as THREE from 'three';
import { safeRelPath } from '../lib/paths.js';

const MAX_GROUPS = 128;
const lower = (s) => String(s ?? '').replace(/\\/g, '/').toLowerCase();

// the `skin` keyvalue as a group index: "default" / "" / junk -> 0
export const skinIndex = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_GROUPS - 1) : 0; };

export class Skins {
  // json: skins.json; url(rel): a map file's URL; finish(mesh): the renderer's material passes on a swapped mesh
  constructor(json, url, finish) {
    this.models = new Map();
    for (const [model, d] of Object.entries(json && typeof json === 'object' ? json : {})) {
      if (!Array.isArray(d?.groups) || d.groups.length < 2) continue;
      const groups = d.groups.slice(0, MAX_GROUPS).map((g) => (Array.isArray(g) ? g.map(lower) : []));
      this.models.set(lower(model), { groups, materials: d.materials && typeof d.materials === 'object' ? d.materials : {} });
    }
    this.url = url;
    this.finish = finish;
    this.loader = new THREE.TextureLoader();
    this.textures = new Map(); // file -> Promise<Texture|null>
    this.built = new Map(); // `${src.uuid}|${vmat}` -> material
  }

  has(model) { return this.models.has(lower(model)); }

  // before the renderer's passes: each mesh keeps the export's material and its slot in group 0
  prepare(model, inst) {
    const d = this.models.get(lower(model));
    if (!d) return;
    inst.traverse((o) => {
      if (!o.isMesh || Array.isArray(o.material)) return;
      const slot = d.groups[0].indexOf(lower(o.material.userData?.vmat?.Name || o.material.name));
      if (slot >= 0) o.userData.skin = { slot, src: o.material };
    });
    inst.userData.skin = 0;
  }

  // the entity's skin onto its model instance (every frame: cheap when unchanged). Returns true when it swapped.
  apply(e, model, inst) {
    const d = this.models.get(lower(model));
    if (!d) return false;
    const n = Math.min(skinIndex(e.kv.skin), d.groups.length - 1);
    if (inst.userData.skin === n) return false;
    if (!d.loading && n > 0) { d.loading = true; this.preload(d); }
    let ready = true;
    inst.traverse((o) => {
      const s = o.userData.skin;
      if (!o.isMesh || !s) return;
      const m = this.material(d, s, d.groups[n][s.slot] || d.groups[0][s.slot]);
      if (!m) { ready = false; return; }
      if (o.material !== m) { o.material = m; delete o.userData.tintBase; }
    });
    if (ready) inst.userData.skin = n;
    inst.userData.tintKey = undefined; // the tint is applied again on the new materials (render.js applyTint)
    return true;
  }

  // a skin material for one slot: null until its textures are in
  material(d, s, vmat) {
    const key = `${s.src.uuid}|${vmat}`;
    if (this.built.has(key)) return this.built.get(key);
    // group 0's own material (or one the bake couldn't write): the export's, through the same passes
    const def = vmat === d.groups[0][s.slot] ? null : d.materials[vmat];
    if (!def) return this.finished(key, s.src.clone());
    const tex = this.texturesOf(def);
    if (!tex.ready) return null;
    const m = s.src.clone();
    m.userData = { ...s.src.userData, vmat: def.vmat || s.src.userData?.vmat };
    m.name = vmat;
    const swap = (slot, file, dataTex) => {
      const t = tex.files[file];
      if (!t || !s.src[slot]) return;
      const c = t.clone();
      const ref = s.src[slot];
      c.flipY = ref.flipY; c.wrapS = ref.wrapS; c.wrapT = ref.wrapT; c.channel = ref.channel;
      c.colorSpace = dataTex ? ref.colorSpace : THREE.SRGBColorSpace;
      c.needsUpdate = true;
      m[slot] = c;
    };
    const T = def.textures || {};
    swap('map', T.g_tColor, false);
    swap('emissiveMap', T.g_tSelfIllumMask, true);
    swap('normalMap', T.g_tNormal, true);
    return this.finished(key, m);
  }

  // the renderer's passes on a new material, kept for its slot
  finished(key, m) {
    const mesh = new THREE.Mesh(undefined, m);
    this.finish(mesh);
    this.built.set(key, mesh.material);
    return mesh.material;
  }

  // the textures one skin material names: { ready, files: { file: Texture } }
  texturesOf(def) {
    const files = Object.values(def.textures || {}).filter((f) => typeof f === 'string' && safeRelPath(f) === f);
    const out = { ready: true, files: {} };
    for (const f of files) {
      const p = this.load(f);
      if (p.done) out.files[f] = p.tex;
      else out.ready = false;
    }
    return out;
  }

  load(file) {
    let p = this.textures.get(file);
    if (!p) {
      p = { done: false, tex: null };
      this.loader.load(this.url(`models/${file}`), (t) => { p.tex = t; p.done = true; }, undefined, () => { p.done = true; });
      this.textures.set(file, p);
    }
    return p;
  }

  preload(d) { for (const def of Object.values(d.materials)) this.texturesOf(def); }
}
