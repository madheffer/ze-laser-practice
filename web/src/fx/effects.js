// The map's particle effects, run by the particle runtime (fx/particles) from the bake's fx/ folder
// (bake/ParticleBake.cs): fx/index.json names every system and texture; systems/<path>.json is a .vpcf's DATA block.
//
//   const fx = await MapEffects.load(urlOf)          // null when the map has no fx/ (an older bake)
//   const inst = await fx.spawn('particles/x.vpcf')   // an EffectInstance, or null when the effect isn't baked
//   inst.update(dt, { cps, active })                  // each frame: control points, on / off (stops emitting when off)
//   inst.group                                        // three.js objects in world space (Source units, z up)
//   fx.lights                                         // this frame's particle lights, every live visible instance's
//                                                     // C_OP_RenderStandardLight (contract: particles/render/lights.js)
//
// An info_particle_system's control points: 0 = the entity itself, 1..63 = the entities its cpoint1..cpoint63 name
// (render.js feeds them every frame): beams between two points, ropes and the like come from these.
import * as THREE from 'three';
import { ParticleSystem, expandDefaults } from './particles/system.js';
import { SpriteRenderer } from './particles/render/sprites.js';
import { RopeRenderer } from './particles/render/ropes.js';
import { TrailRenderer } from './particles/render/trails.js';
import { LightRenderer } from './particles/render/lights.js';
import { SoundRenderer } from './particles/render/sound.js';
import { liveMaterials } from './particles/render/spritecard.js';
import { barnUniforms } from '../world/lighting.js';
import { safeRelPath } from '../lib/paths.js';

// particles.dll's class defaults (2.3 MB generated): loaded with the first map that has effects, not at page start
let expanded = null;
const loadDefaults = () => (expanded ? Promise.resolve() : import('./particles/defaults.js').then((m) => { expanded ||= expandDefaults(m.default); }));
const MAX_SYSTEMS_PER_EFFECT = 64;

// one set of view uniforms for every effect's materials: render.js sets the camera each frame. The barn lights and the
// fog are the world's own uniform objects (world/lighting.js barnUniforms / fogUniforms, bound by setFxCamera): CS2
// lights particles from the scene's barn list (spritecard.js) and fogs them with the view's fog (PS0:733).
const FOG_OFF = () => ({
  cs2FogType: { value: 0 }, cs2FogColor: { value: new THREE.Color(0, 0, 0) },
  cs2FogDist: { value: new THREE.Vector4() }, cs2FogHeight: { value: new THREE.Vector4() }, cs2FogStartSq: { value: 0 },
});
export const fxShared = {
  uCamPos: { value: new THREE.Vector3() }, uCamUp: { value: new THREE.Vector3() }, uCamFwd: { value: new THREE.Vector3() },
  uAmbient: { value: new THREE.Vector3(1, 1, 1) }, ...barnUniforms(), ...FOG_OFF(),
};
let boundLighting = null;
// share a MapLighting's barn + fog uniform objects with every particle material (live ones are repointed)
function bindFxLighting(lighting) {
  if (!lighting || lighting === boundLighting) return;
  boundLighting = lighting;
  const set = { ...(lighting.barnUniforms || {}), ...(lighting.fogUniforms || {}) };
  for (const [k, u] of Object.entries(set)) {
    if (!Object.hasOwn(fxShared, k)) continue;
    fxShared[k] = u;
    for (const m of liveMaterials) if (m.uniforms[k]) m.uniforms[k] = u;
  }
}
// lighting: the renderer's MapLighting (world/lighting.js), optional
export function setFxCamera(camera, lighting = null) {
  bindFxLighting(lighting);
  const p = camera.position;
  fxShared.uCamPos.value.set(p.x, p.y, p.z);
  camera.getWorldDirection(fxShared.uCamFwd.value);
  // the camera's own up (its local +y), not camera.up (the world-up hint): sprites build their quads from it
  fxShared.uCamUp.value.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
}

const norm = (p) => String(p ?? '').toLowerCase().replace(/\\/g, '/').replace(/^resource:/, '').replace(/_c$/, '');

export class MapEffects {
  // urlOf(rel) -> a versioned URL under the map folder (world/assets.js)
  static async load(urlOf, fetchJson) {
    const index = await fetchJson(urlOf('fx/index.json')).catch(() => null);
    if (!index || typeof index !== 'object' || typeof index.systems !== 'object') return null;
    await loadDefaults();
    return new MapEffects(index, urlOf, fetchJson);
  }

  constructor(index, urlOf, fetchJson) {
    this.index = index;
    this.urlOf = urlOf;
    this.fetchJson = fetchJson;
    this.systemCache = new Map(); // path -> Promise<data|null>
    this.docCache = new Map(); // effect -> Promise<doc|null>
    this.texCache = new Map(); // url -> { tex, variants }
    this.loader = new THREE.TextureLoader();
    this.reports = new Set();
    this.trace = null; // (from, dir, length, query) -> hit | null: fx/trace.js on the map collision
    this.onSound = null; // (request) -> void: C_OP_RenderSound's sound requests (render/sound.js); main.js hands them to audio.js
    this.instances = new Set(); // live EffectInstances, for .lights
    this._lights = [];
  }

  has(effect) { return Object.hasOwn(this.index.systems, norm(effect)); }

  system(path) {
    const key = norm(path);
    if (!this.systemCache.has(key)) {
      const file = Object.hasOwn(this.index.systems, key) ? safeRelPath(this.index.systems[key]) : null;
      this.systemCache.set(key, file ? this.fetchJson(this.urlOf('fx/' + file)).catch(() => null) : Promise.resolve(null));
    }
    return this.systemCache.get(key);
  }

  // the runtime's document for an effect: the root and every child system it names, depth-first
  doc(effect) {
    const root = norm(effect);
    if (!this.docCache.has(root)) {
      this.docCache.set(root, (async () => {
        const systems = [];
        const seen = new Set();
        const walk = async (path) => {
          if (seen.has(path) || seen.size >= MAX_SYSTEMS_PER_EFFECT) return;
          seen.add(path);
          const data = await this.system(path);
          if (!data) return;
          systems.push({ path, data });
          for (const c of Array.isArray(data.m_Children) ? data.m_Children : []) if (c?.m_ChildRef) await walk(norm(c.m_ChildRef));
        };
        await walk(root);
        return systems.length ? { root, systems } : null;
      })());
    }
    return this.docCache.get(root);
  }

  // what the renderers ask for: a texture (clamped or repeating) and its sprite sheet
  assets() {
    const entry = (path) => {
      const k = norm(path);
      return Object.hasOwn(this.index.textures || {}, k) ? this.index.textures[k] : null;
    };
    return {
      texture: (path, clamp) => {
        const e = entry(path);
        const file = e && safeRelPath(e.file);
        if (!file) { this.report(`texture ${path} not baked; drawn white`); return null; }
        const url = this.urlOf('fx/' + file);
        let base = this.texCache.get(url);
        if (!base) {
          // one load per file; each wrap mode is its own Texture sharing the image, filled when the load lands
          base = { image: null, variants: new Map(), loaded: null };
          this.texCache.set(url, base);
          // settles either way: app/readiness.js waits on it before a stage starts (a failed texture draws white)
          base.loaded = new Promise((done) => this.loader.load(url, (loaded) => {
            base.image = loaded.image;
            for (const v of base.variants.values()) { v.image = loaded.image; v.needsUpdate = true; }
            done();
          }, undefined, () => { this.report(`texture ${path} failed to load`); done(); }));
        }
        const mode = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        let t = base.variants.get(mode);
        if (!t) {
          t = new THREE.Texture();
          // g_tBaseTexture is sRGB; D3D UVs put v = 0 on the first row
          t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; t.anisotropy = 1;
          t.wrapS = t.wrapT = mode;
          if (base.image) { t.image = base.image; t.needsUpdate = true; }
          base.variants.set(mode, t);
        }
        return t;
      },
      sheet: (path) => (Array.isArray(entry(path)?.sheet) ? entry(path).sheet : null),
    };
  }

  // every effect texture asked for so far, loaded (or failed): app/readiness.js
  texturesLoaded() { return Promise.all([...this.texCache.values()].map((b) => b.loaded)); }

  report(m) { if (!this.reports.has(m)) { this.reports.add(m); this.onReport?.(m); } }

  // The particle lights of the last update of every instance whose group is shown; one array, refilled on each read.
  get lights() {
    const out = this._lights;
    out.length = 0;
    for (const inst of this.instances) if (inst.group.visible !== false) for (const l of inst.lights) out.push(l);
    return out;
  }

  async spawn(effect, opts = {}) {
    const doc = await this.doc(effect);
    return doc ? new EffectInstance(this, doc, opts) : null;
  }
}

export class EffectInstance {
  constructor(effects, doc, { seed = 1, camera = null } = {}) {
    this.effects = effects;
    this.doc = doc;
    // world traces through MapEffects.trace (fx/trace.js), set once the map's collision is built
    this.sys = new ParticleSystem(doc, { defaults: expanded, random: seed, now: () => this.time, camera, trace: (...a) => effects.trace?.(...a) ?? null });
    this.time = 0;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false; // world space: the systems already work in Source units
    this.renderers = new Map();
    this.assets = effects.assets();
    this.active = true;
    this.raw = new Map(doc.systems.map((s) => [s.path, s.data?.m_Renderers || []]));
    this.lights = []; // this frame's C_OP_RenderStandardLight lights (lights.js contract)
    effects.instances?.add(this);
  }

  // cps: [{ position, forward, left, up }] by control point index (any may be missing)
  update(dt, { cps = [], active = true, camPos = [0, 0, 0] } = {}) {
    if (active !== this.active) {
      if (active) { this.sys.restart(); } else this.sys.stopEmission();
      this.active = active;
    }
    cps.forEach((cp, i) => { if (cp) this.sys.setControlPoint(i, cp); });
    this.time += dt;
    this.sys.step(dt);
    for (const m of this.sys.reports.splice(0)) this.effects.report(m);
    const cols = this.sys.collections || [];
    this.lights.length = 0;
    // children draw first, then the root
    for (let ci = cols.length - 1, order = 0; ci >= 0; ci--) {
      const col = cols[ci];
      const raws = this.raw.get(col.path) || [];
      const seen = {};
      (col.renderers || []).forEach((r, ri) => {
        const k = seen[r.cls] = (seen[r.cls] ?? -1) + 1;
        const raw = r.raw || raws.filter((x) => x._class === r.cls)[k] || {};
        const key = `${ci}:${ri}`;
        let rend = this.renderers.get(key);
        if (!rend) {
          if (r.cls === 'C_OP_RenderSprites') rend = new SpriteRenderer(fxShared, this.assets);
          else if (r.cls === 'C_OP_RenderRopes') rend = new RopeRenderer(fxShared, this.assets);
          else if (r.cls === 'C_OP_RenderTrails') rend = new TrailRenderer(fxShared, this.assets); // one streak per particle
          else if (r.cls === 'C_OP_RenderStandardLight') rend = new LightRenderer();
          else if (r.cls === 'C_OP_RenderSound') rend = new SoundRenderer((req) => this.effects.onSound?.(req));
          else { this.effects.report(`${r.cls} is not drawn`); rend = { update: () => ({ unsupported: [] }), dispose() {}, mesh: null }; }
          this.renderers.set(key, rend);
          if (rend.mesh) this.group.add(rend.mesh);
        }
        if (rend instanceof SoundRenderer) { rend.update(col, r.p); return; }
        if (rend instanceof LightRenderer) {
          const ctl = rend.update(col, r.p, raw);
          for (const l of rend.lights) this.lights.push(l);
          for (const u of ctl.unsupported) this.effects.report(`${r.cls}: ${u}`);
          return;
        }
        if (!rend.mesh) return;
        rend.mesh.renderOrder = order++;
        const ctl = rend.update(col, r.p, raw, { camPos, report: (m) => this.effects.report(m) }, r.cls);
        for (const u of ctl?.unsupported || []) this.effects.report(`${r.cls}: ${u}`);
      });
    }
  }

  // nothing left to draw and no longer emitting
  get finished() { return !this.active && (this.sys.collections || []).every((c) => !c.count); }

  dispose() {
    for (const r of this.renderers.values()) r.dispose?.();
    this.group.removeFromParent();
    this.lights.length = 0;
    this.effects.instances?.delete(this);
  }
}
