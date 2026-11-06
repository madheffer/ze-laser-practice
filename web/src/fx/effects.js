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
import { ModelRenderer } from './particles/render/models.js';
import { liveMaterials } from './particles/render/spritecard.js';
import { barnUniforms } from '../world/lighting.js';
import { sceneCopyUniforms } from '../world/scenecopy.js';
import { safeRelPath } from '../lib/paths.js';

// particles.dll's class defaults (2.3 MB generated): loaded with the first map that has effects, not at page start
let expanded = null;
const loadDefaults = () => (expanded ? Promise.resolve() : import('./particles/defaults.js').then((m) => { expanded ||= expandDefaults(m.default); }));
const MAX_SYSTEMS_PER_EFFECT = 64;
const OVERLAY_ORDER = 1e6; // GameOverlay-layer particles draw after every other transparent object

// one set of view uniforms for every effect's materials: render.js sets the camera each frame. The barn lights and the
// fog are the world's own uniform objects (world/lighting.js barnUniforms / fogUniforms, bound by setFxCamera): CS2
// lights particles from the scene's barn list (spritecard.js) and fogs them with the view's fog (PS0:733).
const FOG_OFF = () => ({
  cs2FogType: { value: 0 }, cs2FogColor: { value: new THREE.Color(0, 0, 0) },
  cs2FogDist: { value: new THREE.Vector4() }, cs2FogHeight: { value: new THREE.Vector4() }, cs2FogStartSq: { value: 0 },
});
// The scene copy (world/scenecopy.js) feeds depth feathering and refraction.
export const fxShared = {
  uCamPos: { value: new THREE.Vector3() }, uCamUp: { value: new THREE.Vector3() }, uCamFwd: { value: new THREE.Vector3() },
  uAmbient: { value: new THREE.Vector3(1, 1, 1) }, ...barnUniforms(), ...FOG_OFF(), ...sceneCopyUniforms,
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

// CS2's stand-ins for what a map names but doesn't ship:
// - a system that won't load: client.dll FUN_18189aed0 warns "Attempted to create unknown particle system type" and
//   creates particles/error/error.vpcf instead (red sprite bursts; the bake adds it to every map's fx/)
// - a texture that won't load: the render system binds its 2D error texture (rendersystemvulkan FUN_1800f7e20 fills
//   slot +0x6a8, which texturebase.cpp:3673 "Falling back to error texture" returns): 32 x 32 RGBA, magenta
//   0xffff00ff where (x ^ y) & 4, else opaque black, i.e. a 4-texel magenta / black checker
export const ERROR_SYSTEM = 'particles/error/error.vpcf';
let errorPixels = null;
function errorTexture(mode) {
  if (!errorPixels) {
    errorPixels = new Uint8Array(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = (y * 32 + x) * 4, on = ((x ^ y) & 4) !== 0;
      errorPixels[i] = on ? 255 : 0; errorPixels[i + 1] = 0; errorPixels[i + 2] = on ? 255 : 0; errorPixels[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(errorPixels, 32, 32, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; t.wrapS = t.wrapT = mode;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

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
    this.getModel = null; // (vmdl path) -> Promise<glTF scene> | null: C_OP_RenderModels' models (render/models.js); world/assets.js
    this.modelToSource = null; // the matrix from those glTF scenes to Source units (world/assets.js GLTF_TO_SOURCE)
    this.instances = new Set(); // live EffectInstances, for .lights
    this._lights = [];
  }

  // whether spawn(effect) draws something: the effect itself, or CS2's error system in its place
  has(effect) {
    const k = norm(effect);
    return Object.hasOwn(this.index.systems, k) || (k !== '' && Object.hasOwn(this.index.systems, ERROR_SYSTEM));
  }

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
          let data = await this.system(path);
          if (!data && path !== ERROR_SYSTEM) {
            // not baked (the map names a system its VPK and CS2's paks lack): CS2's error system under the same name,
            // so the parent's child reference still finds it. For a child ref this follows the root's rule (client.dll);
            // particles.dll's own handling of a missing child is not traced (UNSETTLED)
            data = await this.system(ERROR_SYSTEM);
            if (data) this.report(`system ${path} not baked; CS2's ${ERROR_SYSTEM} drawn instead`);
          }
          if (!data) return;
          systems.push({ path, data });
          // the models it draws start loading now, not when its first particle is drawn (render/models.js)
          for (const r of Array.isArray(data.m_Renderers) ? data.m_Renderers : []) {
            if (r?._class === 'C_OP_RenderModels') for (const m of Array.isArray(r.m_ModelList) ? r.m_ModelList : []) if (m?.m_model) this.getModel?.(String(m.m_model));
          }
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
        if (!file) {
          // CS2's 2D error texture (errorTexture above), one per wrap mode
          this.report(`texture ${path} not baked; CS2's error texture (magenta / black checker) drawn`);
          const key = `error:${clamp ? 'clamp' : 'repeat'}`;
          let base = this.texCache.get(key);
          if (!base) {
            base = { image: null, variants: new Map(), loaded: Promise.resolve(), tex: errorTexture(clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping) };
            this.texCache.set(key, base);
          }
          return base.tex;
        }
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

// Whether a collection's particles can reach the view: the box around their positions (field 0), grown by four times
// the largest radius (field 3) and a margin, for the sprite's own size, its stretch and the roll of its quad.
// No frustum: always.
const CULL_MARGIN = 128;
const _box = new THREE.Box3();
function collectionInView(col, frustum) {
  if (!frustum) return true;
  const P = col.attr?.[0], R = col.attr?.[3], n = col.count || 0;
  if (!P) return true;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, r = 0;
  for (let i = 0; i < n; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
    if (R && R[i] > r) r = R[i];
  }
  if (!Number.isFinite(x0 + x1 + y0 + y1 + z0 + z1)) return true; // a NaN position: drawn as before
  const pad = 4 * (Number.isFinite(r) ? r : 0) + CULL_MARGIN;
  _box.min.set(x0 - pad, y0 - pad, z0 - pad);
  _box.max.set(x1 + pad, y1 + pad, z1 + pad);
  return frustum.intersectsBox(_box);
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
  // frustum: the camera's (THREE.Frustum); sprites and ropes wholly outside it skip building their buffers and are not
  // drawn (they still simulate, so what they do is unchanged). prepare: build every renderer and its material whatever
  // is live or seen (render.js compiles the effect's shaders from that before it is shown)
  update(dt, { cps = [], active = true, camPos = [0, 0, 0], frustum = null, prepare = false } = {}) {
    // A start plays from this frame on; a stop came at the end of the time this frame covers, so that time still runs
    // with emission on (a fresh instance that was never on stops before its first step). Westersand's Chaos_Tesla gets
    // Stop 0.5 s after Start, the frame its beams restart (tesla_beam_mainc C_OP_RestartAfterDuration 0.5) and fire
    // the bolts seen in game; stopping first dropped them, leaving only the first bolts, drawn at the map's origin
    // (their CPs 5 / 6 are aimed only once the root has a particle).
    const stopping = !active && this.active && this.time > 0;
    if (active !== this.active && !stopping) {
      if (active) { this.sys.restart(); } else this.sys.stopEmission();
      this.active = active;
    }
    cps.forEach((cp, i) => { if (cp) this.sys.setControlPoint(i, cp); });
    this.time += dt;
    this.sys.step(dt);
    if (stopping) { this.sys.stopEmission(); this.active = false; }
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
          else if (r.cls === 'C_OP_RenderModels') rend = new ModelRenderer(this.effects); // a map model per particle
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
        // nothing of it can be on screen: its buffers wait for the frame it can (trails and models are left alone: a
        // streak reaches back along the velocity, a model has its own size)
        if (!prepare && (rend instanceof SpriteRenderer || rend instanceof RopeRenderer) && !(col.count > 0 && collectionInView(col, frustum))) {
          rend.mesh.visible = false;
          return;
        }
        // CS2's GameOverlay layer (m_bOnlyRenderInEffecsGameOverlay; client.dll builds a "GameOverlay Particles" layer):
        // drawn after the scene, over it. Westersand's Chaos_Tesla lightning (tesla_beam_p1c) is one: in game its bolts
        // show across Chaos's body although they start inside it. UNSETTLED: the layer's own pass is not traced; no depth
        // test, after everything else, is read from that footage.
        const overlay = !!(r.p?.m_bOnlyRenderInEffecsGameOverlay ?? raw.m_bOnlyRenderInEffecsGameOverlay);
        rend.mesh.renderOrder = (overlay ? OVERLAY_ORDER : 0) + order++;
        const ctl = rend.update(col, r.p, raw, { camPos, report: (m) => this.effects.report(m) }, r.cls);
        if (rend.mesh.material) rend.mesh.material.depthTest = !overlay;
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
