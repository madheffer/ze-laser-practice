// The 3D view: the static world, entity models riding their entities, and the lasers.
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { MapLighting } from './lighting.js';
import { PostProcess, CS2_POST_GLSL } from './tonemap.js';
import { GLTF_TO_SOURCE } from './assets.js';
import { DEG, parseVec, angleForward, viewQuat, isParticleSystem, glowControlPoints } from './entities/index.js';
import { boxInView } from './view-box.js';
import { nameMatches } from '../lib/names.js';
import { assetKey } from '../lib/paths.js';
import { setFxCamera, fxShared } from '../fx/effects.js';
import { sceneCopyWanted } from '../fx/particles/render/spritecard.js';
import { SceneCopy } from './scenecopy.js';
import { Bloom, BLOOM_POST_GLSL } from './bloom.js';
import { PropAnimator, cloneModel } from './anim.js';
import { Water } from './water.js';
import { applyUnlit } from './unlit.js';
import { Moondome } from './moondome.js';
import { Effects } from './effects.js';
import { spawnsHidden } from './entities/render-mode.js';
import { applySelfIllum, tintSelfIllum } from './selfillum.js';
import { uploadNow, uploadSpread, FRAME_BUDGET_MS } from './gpu-upload.js';
import { ChunkOcclusion } from './occlusion.js';

const _estP = new THREE.Vector3(), _estS = new THREE.Vector3(); // modelEstimate scratch

// an entity's world transform as a particle control point: position and its forward / left / up axes
function cpFrom(ent) {
  const m = ent.getWorld().elements;
  return { position: [m[12], m[13], m[14]], forward: [m[0], m[1], m[2]], left: [m[4], m[5], m[6]], up: [m[8], m[9], m[10]] };
}

// Particle systems one entity may draw (children included): a map's particles.json is data, and an effect
// listing many children, 4 levels deep, would otherwise multiply into millions of sprites.
const MAX_FX_PER_ENTITY = 64;

export class Renderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderScale = 1; // settings: render resolution (setQuality)
    this.msaa = true;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fa3b8);
    // CS uses a 4:3-based horizontal FOV; at 90 that is ~73.74 deg vertical.
    this.camera = new THREE.PerspectiveCamera(73.74, 1, 4, 60000);
    this.camera.up.set(0, 0, 1);

    // the map's own CS2 lighting (lightmaps, sun, sky ambient; the old fixed lights when a map has no bake) and its
    // post-processing (tone curve, exposure, colour lookup), applied by the HDR blit in render()
    this.lighting = new MapLighting(this.scene, this.renderer);
    this.post = new PostProcess();
    this.water = new Water(this.lighting); // CS2 water surfaces (world/water.js)
    this.moondome = new Moondome(this.lighting); // csgo_moondome: fake-skybox surfaces that show a sky cube (world/moondome.js)
    this.effects = new Effects(); // csgo_effects: unlit see-through / additive surfaces with fresnel and distance fade (world/effects.js)

    // world chunks hidden behind walls are not drawn (world/occlusion.js); ?noocclusion draws them all (comparisons)
    this.occlusion = new URLSearchParams(location.search).has('noocclusion') ? null : new ChunkOcclusion(this.renderer.getContext());
    if (this.occlusion && !this.occlusion.ok) this.occlusion = null;
    this.chunks = []; // the world's chunks ready to draw: { object, box } (warmChunk)
    this.worldRoot = new THREE.Group();
    this.worldRoot.matrixAutoUpdate = false;
    this.worldRoot.matrix.copy(GLTF_TO_SOURCE);
    this.scene.add(this.worldRoot);
    this.entRoot = new THREE.Group();
    this.scene.add(this.entRoot);
    this.visuals = new Map(); // entity -> Object3D
    this.anims = new PropAnimator(); // prop_dynamic sequences (world/anim.js)
    this.loading = new Set(); // entity models / effects still loading (app/readiness.js waits for them)
    this.loadingStage = false; // behind the loading screen (app/readiness.js): streamed chunks upload at full speed
    // real particle effects (fx/effects.js) draw in world space
    this.fxRoot = new THREE.Group();
    this.scene.add(this.fxRoot);
    this.fxClock = null;
    this.hullGeo = new Map(); // model -> [BufferGeometry]
    this.fxGeo = new Map(); // effect summary -> BufferGeometry
    this.showHitboxes = false;
    this.laserMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.laserCore = new THREE.MeshBasicMaterial({ color: 0xffd0d0, transparent: true, opacity: 0.9, depthWrite: false });
    this.hitboxMat = new THREE.MeshBasicMaterial({ color: 0x30ff90, wireframe: true, transparent: true, opacity: 0.6, depthWrite: false });
    this.unlitEntity = new WeakMap(); // an entity model's exported material -> its unlit replacement (world/unlit.js)
    this.selfIllum = new WeakMap(); // an exported material -> a copy with CS2's self-illum as emissive (world/selfillum.js)
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // performance settings: render resolution (x the screen's pixel ratio) and MSAA on the HDR target
  // pixelCap: the most of the screen's pixel ratio to draw at (phones are 3x; app/graphics.js Low draws at 1x)
  // bloom: CS2's bloom pass (bloom.js; off on Low)
  // water: its quality follows the preset's knobs (low = reflections off, medium = no MSAA, high = both on: world/water.js)
  setQuality({ renderScale = 1, msaa = true, pixelCap = 2, bloom = true, reflections = true } = {}) {
    this.bloomOn = bloom !== false;
    this.water.setQuality(!reflections ? 'low' : !msaa ? 'medium' : 'high');
    const ratio = Math.min(window.devicePixelRatio, Math.max(0.5, pixelCap)) * Math.min(1, Math.max(0.25, renderScale));
    if (Math.abs(this.renderer.getPixelRatio() - ratio) > 1e-3) { this.renderer.setPixelRatio(ratio); this.resize(); }
    if (this.msaa !== msaa) { this.msaa = msaa; if (this.hdr) { this.hdr.dispose(); this.hdr = null; this.blitScene = null; } }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setFov(hfov43) {
    // horizontal FOV defined at 4:3 (CS's convention) -> vertical
    const v = 2 * Math.atan(Math.tan((hfov43 * DEG) / 2) * 0.75) / DEG;
    this.camera.fov = v;
    this.camera.updateProjectionMatrix();
  }

  // the whole world glb, or null for a streamed map (its chunks come through addWorldChunk)
  // water: the map's baked water textures (loadMap's map.water; null for an older bake)
  setWorld(scene, water = null) {
    for (const c of this.chunks) this.occlusion?.forget(c.object);
    this.chunks = [];
    this.worldRoot.clear();
    this.viewBox = null; // a stage sets its own (setViewBox)
    this.water.setMap(water);
    this.worldMaterials = new Map(); // a streamed world's materials by name: one per vmat across every chunk
    this.unlitMaterials = new Map(); // exported material -> its unlit replacement (world/unlit.js)
    if (scene) this.addWorldChunk(scene);
  }

  // each chunk glb brings its own copy of the materials (and textures) it uses; the first copy of a material is
  // kept and the rest dropped, so a texture is uploaded once however many chunks use it
  sharedMaterial(m) {
    if (!m?.name || !m.isMeshStandardMaterial) return m;
    const key = `${m.name}|${m.transparent}|${m.alphaTest}|${m.side}|${m.vertexColors}`;
    const have = this.worldMaterials.get(key);
    if (!have) { this.worldMaterials.set(key, m); return m; }
    if (have !== m) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
        if (m[k] && m[k] !== have[k]) m[k].dispose();
      }
      m.dispose();
    }
    return have;
  }

  addWorldChunk(scene) {
    scene.traverse((o) => {
      if (o.isMesh) {
        o.material = Array.isArray(o.material) ? o.material.map((m) => this.sharedMaterial(m)) : this.sharedMaterial(o.material);
        // CS2 water gets its own shader in place of the flat glTF material (world/water.js)
        const w = !Array.isArray(o.material) && this.water.material(o.material, { lit: !!o.geometry?.attributes?.uv1 });
        if (w) { o.material = w; this.water.track(o); }
        else { applyUnlit(o, this.unlitMaterials); applySelfIllum(o, this.selfIllum); this.moondome.apply(o); this.effects.apply(o); } // CS2's unlit / self-illum / moondome / effects shaders (world/unlit.js, selfillum.js, moondome.js, effects.js)
        // VRF names tool-texture meshes after their material; hide the editor-only ones
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (mats.some((m) => /tools?(trigger|clip|nodraw|skip|invisible|playerclip|blocklight|areaportal|sky)/i.test(m?.name || ''))) o.visible = false;
        for (const m of mats) if (m && m.transparent === false && m.alphaTest === 0 && m.map && /grate|fence|leaf|foliage|chain/i.test(m.name)) m.alphaTest = 0.5;
      }
    });
    // in the world root first, so the probe volumes are matched in Source units (the root's glTF -> Source)
    this.worldRoot.add(scene);
    this.lighting.applyToWorld(scene); // the map's CS2 lightmap shading (world/lighting.js; nothing without a bake)
    if (this.viewBox) { this.worldRoot.updateMatrixWorld(true); scene.traverse((o) => this.fitView(o)); }
    this.track(this.warmChunk(scene));
  }

  // A chunk is shown once its shaders are compiled and its textures are on the GPU, a few per frame: drawn at once, its
  // first frame did all of that (a chunk streaming in while you play, or one turned to). app/readiness.js waits for
  // the chunks a stage starts with (render.loading).
  async warmChunk(scene) {
    const attached = () => scene.parent === this.worldRoot;
    // compile() reads what is visible when it is called; the chunk is hidden while the programs link
    const programs = this.compileAsync(scene);
    scene.visible = false;
    await programs;
    await uploadSpread(this.renderer, scene, attached, () => (this.loadingStage ? 50 : FRAME_BUDGET_MS));
    if (!attached()) return;
    scene.visible = true;
    const box = new THREE.Box3();
    scene.updateMatrixWorld(true);
    scene.traverse((o) => { if (o.isMesh) box.union(new THREE.Box3().setFromObject(o, false)); });
    if (!box.isEmpty()) this.chunks.push({ object: scene, box: [box.min.toArray(), box.max.toArray()] });
  }

  // every texture of what is in the scene now, on the GPU (behind the loading screen: app/readiness.js)
  uploadTextures() { uploadNow(this.renderer, this.scene); }

  // The stage's view box (world/view-box.js, null for the whole map): world meshes and entity models outside it are
  // not drawn. World meshes are placed once, so they are sorted here; entities move, so updateEntities checks them.
  setViewBox(box) {
    this.viewBox = box;
    if (!box) for (const g of this.visuals.values()) this.loadPending(g, true);
    this.worldRoot.updateMatrixWorld(true);
    this.worldRoot.traverse((o) => this.fitView(o));
  }

  fitView(o) {
    if (!o.isMesh) return;
    if (o.userData.drawn === undefined) o.userData.drawn = o.visible; // editor-only meshes stay hidden
    let local = o.geometry.boundingBox;
    if (o.isInstancedMesh) { if (!o.boundingBox) o.computeBoundingBox(); local = o.boundingBox; }
    else if (!local) { o.geometry.computeBoundingBox(); local = o.geometry.boundingBox; }
    o.visible = o.userData.drawn && boxInView(this.viewBox, local, o.matrixWorld);
  }

  // An entity model's bounds in its own space (Source units) before the model is loaded: its collision hulls
  // (hulls.json), else (no model, or no hulls: an effect, a prop) a box around its origin; padded so a mover's model is fetched a little before it comes in
  modelEstimate(model, map) {
    const cache = (this._estBoxes ||= new Map());
    if (cache.has(model)) return cache.get(model);
    const box = new THREE.Box3();
    for (const h of (model && map.hulls?.[model]) || []) {
      for (let i = 0; i + 2 < h.verts.length; i += 3) box.expandByPoint(_estP.set(h.verts[i], h.verts[i + 1], h.verts[i + 2]));
    }
    if (box.isEmpty()) box.setFromCenterAndSize(_estP.set(0, 0, 0), _estS.set(128, 128, 128));
    box.expandByScalar(512);
    cache.set(model, box);
    return box;
  }

  // fetch a model or effect left out by the view box once its entity reaches into it (or at once: force)
  loadPending(g, force = false) {
    const f = g.userData.pendingLoad;
    if (!f || (!force && !boxInView(this.viewBox, g.userData.estBox, g.matrix))) return;
    g.userData.pendingLoad = null;
    f();
  }

  // an entity's visual reaches into the view box: its meshes' bounds in its own space, measured again whenever a
  // model arrives (they load after the entity spawns), placed where the entity is now
  entityInView(g) {
    if (!this.viewBox) return true;
    return boxInView(this.viewBox, this.entityLocalBox(g), g.matrix);
  }

  // an entity visual's bounds in its own space, measured again whenever a model arrives
  entityLocalBox(g) {
    const u = g.userData;
    let n = 0;
    g.traverse((o) => { if (o.isMesh || o.isLine) n++; });
    if (!u.viewLocal || u.viewMeshes !== n) {
      g.updateMatrixWorld(true);
      u.viewLocal = new THREE.Box3().setFromObject(g, true).applyMatrix4(g.matrixWorld.clone().invert());
      u.viewMeshes = n;
    }
    return u.viewLocal;
  }

  // an entity visual wholly inside a world chunk hidden behind walls (world/occlusion.js hides): not drawn either
  entityOccluded(g) {
    if (!this.occlusion || this.chunks.length < 2) return false;
    const local = this.entityLocalBox(g);
    if (local.isEmpty()) return false;
    const box = (this._entBox ||= new THREE.Box3()).copy(local).applyMatrix4(g.matrix);
    return this.occlusion.hides(box, this.chunks, this.camera);
  }

  clearEntities() {
    for (const v of this.visuals.values()) { this.entRoot.remove(v); v.userData.fx?.dispose(); }
    this.visuals.clear();
    this.fxClock = null;
  }

  // Build the visual for a freshly spawned entity.
  // remember a load until it settles (app/readiness.js: a stage starts once nothing is left loading)
  track(p) {
    this.loading.add(p);
    const done = () => this.loading.delete(p);
    p.then(done, done);
    return p;
  }

  // names (a trailing * matches a prefix) whose entities get no visual this stage: the scenario file's `hide`, a
  // trainer choice such as westersand's floating boss HP bars (the HUD has its own)
  setHidden(names) { this.hidden = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n) : []; }

  async addEntity(e, map) {
    if (this.hidden?.length && e.name && this.hidden.some((n) => nameMatches(n, e.name))) return;
    const kv = e.kv;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    let any = false;

    if (isParticleSystem(e.cls) && map.effects?.has(kv.effect_name)) {
      // the real effect (fx/particles): it lives in world space, under fxRoot, fed from this entity every frame
      any = true;
      // its shaders are compiled before it is shown (off the main thread where the browser can): a first draw that
      // compiled them held the frame (deadcore: 138 ms when a stage's first effect started mid-stage)
      const spawn = () => this.track(map.effects.spawn(kv.effect_name, { seed: e.id }).then(async (inst) => {
        if (!inst || !e.alive || this.visuals.get(e) !== group) return inst?.dispose();
        // a zero-length step with the state its first frame will have: its renderers and their materials exist
        inst.update(0, { cps: this.controlPoints(e, group), active: !!e.state.active, prepare: true });
        // three compiles only what is visible, and a renderer with no particles yet hides its mesh
        const hidden = [];
        inst.group.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
        await this.compileAsync(inst.group);
        for (const o of hidden) o.visible = false;
        if (!e.alive || this.visuals.get(e) !== group) return inst.dispose();
        group.userData.fx = inst;
        this.fxRoot.add(inst.group);
      }));
      // outside the stage's view box it isn't fetched until its entity comes in (loadPending): the shifting pool's
      // waterfalls on the island
      group.userData.estBox = this.modelEstimate(null, map);
      if (boxInView(this.viewBox, group.userData.estBox, e.getWorld())) spawn();
      else group.userData.pendingLoad = spawn;
    } else if (isParticleSystem(e.cls)) {
      // an older bake without fx/: the summary sprites
      const fx = map.particles?.[assetKey(kv.effect_name || '')];
      if (fx) {
        this.addParticle(group, fx, map, 0, { left: MAX_FX_PER_ENTITY });
        any = true;
      }
    } else if (e.cls === 'env_laser' && /\.spr$/i.test(String(kv.texture || ''))) {
      // a CS:GO sprite (.spr): Source 2 has no sprite resources, so CS2 draws no beam for it (its damage stays,
      // beams.js); maps that wanted it seen add a particle beam between the same points (ze_dreamin's laser_*_fix)
    } else if (e.cls === 'env_laser') {
      const width = Math.max(2, Number(kv.width) || 8);
      const rc = String(kv.rendercolor || '255 40 40').replace(/[[\],]/g, ' ').trim().split(/\s+/).map(Number);
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color((rc[0] || 255) / 255, (rc[1] || 0) / 255, (rc[2] || 0) / 255), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(width / 4, width / 4, 1, 8, 1, true), mat);
      beam.userData.kind = 'beam';
      beam.matrixAutoUpdate = false;
      group.add(beam);
      any = true;
    } else if (e.cls === 'trigger_hurt') {
      // hitboxes, shown with H; what you see in game is the particles parented next to them
      if (this.hullGeometries(e.model, map)) {
        // a heal zone (negative damage: mist's Cleansing Aura) is drawn for everyone, as the area to stand in. CS2 shows
        // it with particles spread over the area; ours are summarised to a point, so the zone's own volume stands in.
        const heal = Number(kv.damage) < 0;
        for (const geo of heal ? this.hullGeo.get(e.model) : []) {
          const mat = this.healMaterial(e, map);
          const zone = new THREE.Mesh(geo, mat);
          zone.userData.kind = 'heal';
          group.add(zone);
          // and its outline, so the edge reads on a bright floor too
          const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: mat.color, transparent: true, opacity: 0.9 }));
          edge.userData.kind = 'heal';
          group.add(edge);
        }
        for (const geo of this.hullGeo.get(e.model)) {
          const glow = new THREE.Mesh(geo, this.laserMat);
          glow.userData.kind = 'hurt';
          group.add(glow);
          const wire = new THREE.Mesh(geo, this.hitboxMat);
          wire.userData.kind = 'hitbox';
          group.add(wire);
        }
        any = true;
      }
    } else if (!e.cls.startsWith('trigger_') && e.model) {
      if (!spawnsHidden(kv, e.engine?.renderMigrated)) { // kRenderNone as GFL runs the map (entities/render-mode.js)
        // outside the stage's view box (world/view-box.js) the model isn't fetched until the entity moves into it
        // (updateEntities): ze_the_shifting_pool's tube never downloads the platform stage's 250 grid pieces
        group.userData.estBox = this.modelEstimate(e.model, map);
        const pending = !boxInView(this.viewBox, group.userData.estBox, e.getWorld());
        const p = pending ? null : map.getModel(e.model);
        if (p || pending) {
          any = true;
          const build = (p) => this.track(p).then((scene) => {
            if (!scene || !e.alive) return;
            const inst = cloneModel(scene);
            this.anims.attach(e, inst);
            const holder = new THREE.Group();
            holder.matrixAutoUpdate = false;
            holder.matrix.copy(GLTF_TO_SOURCE);
            holder.add(inst);
            inst.traverse((o) => { if (o.isMesh) { applyUnlit(o, this.unlitEntity); applySelfIllum(o, this.selfIllum); this.moondome.apply(o); this.effects.apply(o); } }); // before the tint: it clones
            const rc = kv.rendercolor ? parseVec(kv.rendercolor) : null;
            if (rc && (rc[0] !== 255 || rc[1] !== 255 || rc[2] !== 255)) {
              inst.traverse((o) => {
                if (o.isMesh) {
                  o.material = o.material.clone();
                  const tint = new THREE.Color(rc[0] / 255, rc[1] / 255, rc[2] / 255);
                  o.material.color?.multiply(tint);
                  tintSelfIllum(o.material, tint);
                }
              });
            }
            group.add(holder);
            // probe-lit like the props (world/lighting.js): placed first, so the probe volume is picked where the
            // entity is; a mover picks again as it goes (updateEntities -> lighting.refreshProbes)
            group.matrix.copy(e.getWorld());
            group.updateMatrixWorld(true);
            const meshes = group.userData.probeMeshes = [];
            inst.traverse((o) => {
              if (!o.isMesh) return;
              // CS2 water on an entity's model (a moving water brush): no lightmap UVs, so the sky ambient lights it
              const w = !Array.isArray(o.material) && this.water.material(o.material, { lit: false });
              if (w) { o.material = w; this.water.track(o); return; }
              this.lighting?.applyProbes(o); meshes.push(o);
            });
          });
          if (p) build(p);
          else group.userData.pendingLoad = () => { const q = map.getModel(e.model); if (q) build(q); };
        }
      }
    }
    if (!any) return;
    group.userData.born = e.engine.time;
    // CBaseModelEntity m_fadeMaxDist x m_flFadeScale: past it the model has faded out (fadedOut)
    const fadeMax = Number(kv.fademaxdist) * (kv.fadescale == null ? 1 : Number(kv.fadescale));
    if (fadeMax > 0) group.userData.fadeMax = fadeMax;
    this.visuals.set(e, group);
    this.entRoot.add(group);
  }

  // A trigger model's hulls as convex meshes: one set per model, shared by every spawned copy (a firestorm wave
  // spawns hundreds); null when the model has none. world/warm.js builds them ahead of a mid-stage spawn.
  hullGeometries(model, map) {
    if (this.hullGeo.has(model)) return this.hullGeo.get(model);
    const hulls = map.hulls?.[model];
    if (!hulls) return null;
    const geos = [];
    for (const h of hulls) {
      const pts = [];
      for (let i = 0; i < h.verts.length; i += 3) pts.push(new THREE.Vector3(h.verts[i], h.verts[i + 1], h.verts[i + 2]));
      if (pts.length >= 4) geos.push(new ConvexGeometry(pts));
    }
    this.hullGeo.set(model, geos);
    return geos;
  }

  // A sprite effect as a cloud of soft additive points inside its emit box (from particles.json).
  // Close to how these ZE laser strips render: many overlapping glow sprites along a line.
  addParticle(group, fx, map, depth, budget) {
    if (depth > 3 || budget.left <= 0 || (fx.renderer && fx.renderer !== 'C_OP_RenderSprites')) return;
    budget.left--;
    const pts = new THREE.Points(this.particleGeometry(fx), this.spriteMaterial());
    pts.userData.kind = 'fx';
    pts.frustumCulled = true;
    group.add(pts);
    for (const c of Array.isArray(fx.children) ? fx.children : []) {
      const child = map.particles[assetKey(c)];
      if (child) this.addParticle(group, child, map, depth + 1, budget);
    }
  }

  // One point cloud per effect summary, shared by every entity playing it.
  particleGeometry(fx) {
    if (this.fxGeo.has(fx)) return this.fxGeo.get(fx);
    const lo = fx.offsetMin?.length ? fx.offsetMin : fx.boxMin?.length ? fx.boxMin : [0, 0, 0];
    const hi = fx.offsetMax?.length ? fx.offsetMax : fx.boxMax?.length ? fx.boxMax : [0, 0, 0];
    const n = Math.max(8, Math.min(600, Math.round(fx.max || (fx.rate || 50))));
    const cmin = (fx.colorMin?.length ? fx.colorMin : fx.color?.length ? fx.color : [255, 255, 255]).map((v) => v / 255);
    const cmax = (fx.colorMax?.length ? fx.colorMax : cmin.map((v) => v * 255)).map((v) => v / 255);
    const rmin = fx.radiusMin ?? fx.radius ?? 5, rmax = fx.radiusMax ?? rmin;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) pos[i * 3 + a] = lo[a] + Math.random() * (hi[a] - lo[a]);
      const t = Math.random();
      for (let a = 0; a < 3; a++) col[i * 3 + a] = cmin[a] + (cmax[a] - cmin[a]) * t;
      size[i] = rmin + Math.random() * (rmax - rmin);
      seed[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.hypot(...hi.map((v, a) => Math.max(Math.abs(v), Math.abs(lo[a])))) + rmax);
    this.fxGeo.set(fx, geo);
    return geo;
  }

  spriteMaterial() {
    if (this._sprite) return this._sprite;
    this._sprite = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 1 } },
      vertexShader: `
        attribute float size; attribute float seed; attribute vec3 color;
        uniform float uTime; uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          // each sprite lives ~1 s: drift a little, fade in and out, then respawn in place
          float life = fract(uTime * (0.8 + 0.4 * fract(seed * 7.13)) + seed);
          vec3 p = position + vec3(sin(seed * 3.1 + uTime), cos(seed * 1.7 + uTime), life * 6.0) * 2.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = size * 2.0 * (0.6 + 0.4 * (1.0 - life)) * uScale / -mv.z;
          vColor = color;
          vAlpha = smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.6, 1.0, life));
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float g = exp(-dot(d, d) * 14.0);
          gl_FragColor = vec4(vColor * g * vAlpha * 0.45, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    return this._sprite;
  }

  removeEntity(e) {
    const v = this.visuals.get(e);
    if (!v) return;
    // with simulated ping the entity stays on screen until its death reaches you
    if (this.delay > 0) { v.userData.died = e.engine.time; return; }
    this.entRoot.remove(v); this.visuals.delete(e); this.anims.detach(e);
    v.userData.fx?.dispose();
  }

  // ---- simulated ping -------------------------------------------------------------------------------
  // With client-side prediction your own movement is instant, but the server's entities reach your screen
  // about one round trip late, while hits are decided where they really are. So entities are drawn from a
  // short history `delay` seconds behind the simulation (record() every tick, updateEntities(time) per frame).
  record(time) {
    if (!(this.delay > 0)) return;
    const keep = time - this.delay - 0.25;
    for (const [e, g] of this.visuals) {
      const h = g.userData.hist || (g.userData.hist = []);
      h.push({ t: time, m: e.getWorld().clone(), vis: e.alive && e.visible, en: e.enabled, fx: !!e.state.active });
      while (h.length > 2 && h[1].t < keep) h.shift();
    }
  }

  // The snapshot to draw at `target`: interpolated between the two ticks around it.
  snapshot(g, target) {
    const h = g.userData.hist;
    if (!h?.length) return null;
    if (target <= h[0].t) return h[0];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t <= target) {
        const a = h[i], b = h[i + 1];
        if (!b) return a;
        const k = (target - a.t) / (b.t - a.t);
        const m = new THREE.Matrix4();
        const pa = new THREE.Vector3(), qa = new THREE.Quaternion(), sa = new THREE.Vector3();
        const pb = new THREE.Vector3(), qb = new THREE.Quaternion(), sb = new THREE.Vector3();
        a.m.decompose(pa, qa, sa); b.m.decompose(pb, qb, sb);
        m.compose(pa.lerp(pb, k), qa.slerp(qb, k), sa.lerp(sb, k));
        return { m, vis: a.vis, en: a.en, fx: a.fx };
      }
    }
    return h[0];
  }

  // Real particle effects (fx/effects.js): each frame, the entity's control points (0 = itself, n = what its cpoint<n>
  // names), on while the map has it started (Start / Stop / DestroyImmediately set state.active), stepped by the
  // frame's share of simulation time.
  updateEffects(time) {
    const dt = this.fxClock == null ? 0 : Math.max(0, Math.min(0.1, time - this.fxClock));
    this.fxClock = time;
    setFxCamera(this.camera, this.lighting); // the world barn lights + fog reach particles (fx/effects.js)
    // particles are lit by the map's own sky ambient (world/lighting.js, from its light_environment / probes), white without a bake
    const amb = this.lighting?.ambient;
    if (amb) fxShared.uAmbient.value.set(amb.r, amb.g, amb.b); else fxShared.uAmbient.value.set(1, 1, 1);
    const camPos = [this.camera.position.x, this.camera.position.y, this.camera.position.z];
    const frustum = this.viewFrustum();
    for (const [e, g] of this.visuals) {
      const inst = g.userData.fx;
      if (!inst) continue;
      inst.update(dt, { cps: this.controlPoints(e, g), active: !!(e.alive && e.state.active), camPos, frustum });
      inst.group.visible = e.visible !== false;
    }
  }

  // the camera's frustum this frame (particles skip what it can't see: fx/effects.js)
  viewFrustum() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    this._pv ||= new THREE.Matrix4();
    this._frustum ||= new THREE.Frustum();
    return this._frustum.setFromProjectionMatrix(this._pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  }

  // an effect's control points: n = the entity its cpoint<n> names (cpoint0 too: ze_dreamin's beams set it), CP 0
  // defaults to itself. Which cpoints the entity names is read once (its keyvalues don't change; the targets move).
  controlPoints(e, g) {
    const names = g.userData.cpNames ||= Array.from({ length: 64 }, (_, i) => e.kv[`cpoint${i}`]).map((n, i) => (n ? [i, n] : null)).filter(Boolean);
    const cps = [cpFrom(e)];
    for (const [i, name] of names) {
      const t = e.engine.findOne(name);
      if (t) cps[i] = cpFrom(t);
    }
    const glow = glowControlPoints(e); // env_particle_glow: its tint and scales as CP 16 / 17
    if (glow) { cps[16] = glow[16]; cps[17] = glow[17]; }
    return cps;
  }

  updateEntities(time = 0) {
    // entity models re-pick their light probe volume where they are now (CS2 looks a dynamic object's probes up
    // where it stands): a few times a second, cheap while nothing changes volume
    if ((this._probeTick = ((this._probeTick || 0) + 1) % 8) === 0 && this.lighting) {
      for (const g of this.visuals.values()) {
        if (!g.visible || !g.userData.probeMeshes) continue;
        for (const m of g.userData.probeMeshes) this.lighting.refreshProbes(m);
      }
    }
    this.updateEffects(time - (this.delay || 0));
    this.anims.update(time - (this.delay || 0));
    if (this._sprite) {
      this._sprite.uniforms.uTime.value = performance.now() / 1000;
      // point size in pixels per world unit at distance 1
      this._sprite.uniforms.uScale.value = this.renderer.domElement.height / (2 * Math.tan((this.camera.fov * DEG) / 2));
    }
    const delayed = this.delay > 0;
    const target = time - (this.delay || 0);
    for (const [e, g] of this.visuals) {
      if (delayed) {
        const born = g.userData.born ?? -Infinity, died = g.userData.died;
        if (died != null && target >= died) { this.entRoot.remove(g); this.visuals.delete(e); this.anims.detach(e); continue; }
        const s = target < born ? null : this.snapshot(g, target);
        g.visible = !!s && s.vis;
        if (!s) continue;
        g.matrix.copy(s.m);
        this.loadPending(g);
        if (g.visible) g.visible = !this.fadedOut(g) && this.entityInView(g) && !this.entityOccluded(g);
        g.matrixWorldNeedsUpdate = true;
        for (const c of g.children) {
          const k = c.userData.kind;
          if (k === 'fx' || k === 'beam') c.visible = s.fx;
          else if (k === 'heal') c.visible = s.en;
          else if (k === 'hurt' || k === 'hitbox') c.visible = s.en && this.showHitboxes;
        }
        continue;
      }
      g.matrix.copy(e.getWorld());
      g.matrixWorldNeedsUpdate = true;
      this.loadPending(g);
      const on = e.alive && e.visible;
      g.visible = on && !this.fadedOut(g) && this.entityInView(g) && !this.entityOccluded(g);
      for (const c of g.children) {
        const k = c.userData.kind;
        if (k === 'fx') c.visible = !!e.state.active;
        else if (k === 'beam') this.placeBeam(c, e);
        else if (k === 'heal') c.visible = e.enabled;
        else if (k === 'hurt') c.visible = e.enabled && this.showHitboxes;
        else if (k === 'hitbox') c.visible = e.enabled && this.showHitboxes;
      }
    }
  }

  // an entity model past its fade distance (fademaxdist; ze_neochrome / ze_offliner hide their playerstart.vmdl
  // angle helpers with fademaxdist 1). Fully faded only: the partial fade between fademindist and it is not drawn.
  fadedOut(g) {
    const max = g.userData.fadeMax;
    if (!max) return false;
    const m = g.matrix.elements, c = this.camera.position;
    return Math.hypot(m[12] - c.x, m[13] - c.y, m[14] - c.z) > max;
  }

  // a heal zone's material: the colour of a particle parented to it (mist's aura: pink), else a soft green
  healMaterial(e, map) {
    let color = new THREE.Color(0x7dffa0);
    const fxEnt = [...e.children].find((c) => isParticleSystem(c.cls));
    const fx = fxEnt && map.particles?.[assetKey(fxEnt.kv.effect_name || '')];
    // the more saturated of the particle's two colours (a pale one vanishes on a bright floor)
    const sat = (c) => (c?.length >= 3 ? Math.max(...c.slice(0, 3)) - Math.min(...c.slice(0, 3)) : -1);
    const c = sat(fx?.colorMin) > sat(fx?.colorMax) ? fx.colorMin : fx?.colorMax;
    if (c?.length >= 3) color = new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255);
    // outside faces only: teammates see the zone around the holder, inside it your view stays clear
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.FrontSide });
  }

  // an env_laser's beam (beams.js keeps beamStart / beamEnd in world space) as a cylinder in the laser's group
  placeBeam(c, e) {
    const a = e.state.beamStart, b = e.state.beamEnd;
    c.visible = !!(e.state.active && a && b);
    if (!c.visible) return;
    const inv = e.getWorld().clone().invert();
    const pa = new THREE.Vector3(...a).applyMatrix4(inv), pb = new THREE.Vector3(...b).applyMatrix4(inv);
    const len = pa.distanceTo(pb);
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), pb.clone().sub(pa).normalize());
    c.matrix.compose(mid, q, new THREE.Vector3(1, Math.max(1, len), 1));
  }

  // Built from the angles (Source's AngleMatrix), not lookAt + world up: with the aim punch on top of looking straight
  // up, the view's pitch goes past -90 and lookAt would spin it 180 degrees; CS2's rolls on over the top
  setView(eye, yaw, pitch) {
    const cam = this.camera;
    cam.position.set(eye[0], eye[1], eye[2]);
    viewQuat(pitch, yaw, cam.quaternion);
  }

  // The world pass goes to a half-float HDR target and is tone-mapped once, as a whole frame, on the way to the screen
  // (CS2 renders HDR and tone-maps the frame). Particle shaders write HDR values (an overbright beam is meant to be
  // hot, not clipped white), so drawing them straight to the 8-bit canvas blew them out. The curve is the ACES the
  // world materials already used per material, so the world looks as before.
  render() {
    const r = this.renderer;
    this.ensureTarget();
    // depth feathering / refraction read the frame after the opaques (scenecopy.js)
    this.water.frame(this.camera, performance.now() / 1000);
    this.effects.frame(performance.now() / 1000);
    (this.sceneCopy ||= new SceneCopy(this.scene, () => this.water.wantsCopy || sceneCopyWanted())).frame(r, this.hdr, this.camera);
    // the chunks the last frames' queries found hidden stay out of this one; a world in one piece has nothing to cull
    const occlude = this.occlusion && this.chunks.length > 1;
    if (occlude) this.occlusion.apply(this.chunks, this.camera);
    r.setRenderTarget(this.hdr);
    r.render(this.scene, this.camera);
    if (occlude) {
      // against this frame's depth (MSAA's resolved into the target's own framebuffer): three's state is restored after
      const fbo = r.properties.get(this.hdr).__webglFramebuffer;
      this.occlusion.query(this.chunks, this.camera, this.viewFrustum(), this._occBox ||= new THREE.Box3(), fbo, this.hdr.width, this.hdr.height);
      r.resetState();
    }
    // CS2's bloom from the post volume on screen (bloom.js; this.bloomOn: the graphics setting)
    this.bloom.enabled = this.bloomOn !== false;
    this.bloom.params = this.post.bloom;
    this.bloom.render(r, this.hdr);
    r.setRenderTarget(null);
    r.render(this.blitScene, this.blitCam);
  }

  // Build the shaders object (and what is under it) is drawn with, as the world pass draws it: into the HDR target.
  // three picks a program variant by the target bound (the screen gets sRGB output and tone mapping, a render target
  // linear and none), so compiling with the screen bound built variants the frame never uses and the real ones were
  // still compiled on their first draw. Off the main thread where the browser can (KHR_parallel_shader_compile).
  compileAsync(object) {
    const r = this.renderer;
    this.ensureTarget();
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.hdr);
    const done = r.compileAsync(object, this.camera, this.scene); // compiles now; resolves once the programs link
    r.setRenderTarget(prev);
    return done.catch(() => {});
  }

  // the HDR target the world is drawn into, and the blit that tone-maps it onto the screen, at the canvas's size
  ensureTarget() {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(this._size || (this._size = new THREE.Vector2()));
    if (!this.hdr) {
      this.hdr = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.msaa ? 4 : 0 });
      this.bloom ||= new Bloom();
      const mat = new THREE.ShaderMaterial({
        uniforms: { tHdr: { value: this.hdr.texture }, ...this.post.uniforms, ...this.bloom.uniforms },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `// three prepends its tone-mapping functions (toneMapped material, drawn to the screen)
// CS2's curve, then sRGB, then the map's colour lookup on the sRGB values, then its vignette (world/tonemap.js)
uniform sampler2D tHdr; varying vec2 vUv;
${CS2_POST_GLSL}
${BLOOM_POST_GLSL}
void main() {
  vec3 c = cs2Tonemap(cs2BloomPre(texture2D(tHdr, vUv).rgb, vUv, cs2Exposure)); vec4 s = sRGBTransferOETF(vec4(clamp(c, 0.0, 1.0), 1.0));
  s.rgb = cs2Vignette(cs2ColorCorrect(cs2BloomScreen(s.rgb, vUv, cs2Exposure)), vec2(vUv.x, 1.0 - vUv.y)); gl_FragColor = s;
}`,
        depthTest: false, depthWrite: false, // (toneMapped stays true: three then feeds toneMappingExposure)
      });
      this.blitScene = new THREE.Scene();
      this.blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      this.blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
    if (this.hdr.width !== size.x || this.hdr.height !== size.y) this.hdr.setSize(size.x, size.y);
  }
}
