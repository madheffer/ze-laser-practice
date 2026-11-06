// Loading a baked map folder (the lasers-bake / lasers.cybo.dev layout).
//
// Everything in a map folder is untrusted (a workshop map anyone can publish): the map name and every path a
// manifest names go through lib/paths.js before they reach a URL, and the lookup tables built here have no
// prototype, so a model or effect called "constructor" or "__proto__" is just a missing key.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mapName, safeRelPath, assetKey, versioned } from '../lib/paths.js';
import { fetchJson, fetchBuffer, fetchBufferProgress, FRESH } from '../lib/fetch.js';
import { applyStripper } from '../lib/stripper.js';
import { normaliseHulls } from './hulls.js';
import { mapItems } from './items.js';
import { MapEffects } from '../fx/effects.js';
import { chunkList } from './stream.js';
import { soundDurations } from '../lib/sound-durations.js';

import { loadPhysics } from './physics-world.js';
// VRF exports glTF in metres, Y up: gltf = (src.y, src.z, src.x) * 0.0254. This puts it back in Source units.
export const GLTF_TO_SOURCE = new THREE.Matrix4().set(
  0, 0, 1 / 0.0254, 0,
  1 / 0.0254, 0, 0, 0,
  0, 1 / 0.0254, 0, 0,
  0, 0, 0, 1,
);

// A glb loader whose every request (the glb and the textures beside it) carries the map's version.
// tex: a quality tier's textures ({ base: maps/<map>/q/<tier>/tex/, webp, version }): the glbs' PNGs come from there
// instead, as .webp when the tier's tex.json says so (lasers-bake --tiers), with the tier's own cache version
function glbLoader(version, mapBase = '', tex = null) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob|data):/.test(url)) return url;
    const i = tex ? url.indexOf(mapBase) : -1;
    if (i >= 0 && /\.png$/i.test(url)) {
      const rel = url.slice(i + mapBase.length);
      return versioned(tex.base + (tex.webp ? rel.replace(/\.png$/i, '.webp') : rel), tex.version || version);
    }
    return versioned(url, version);
  });
  const textures = new Map(); // one map's loads share it: see SharedTextures
  return new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder).register((parser) => new SharedTextures(parser, textures));
}

// A GLTFLoader plugin: a texture file is fetched and decoded once for every glb of the map. The world's chunks
// (world/stream.js) each name the same PNGs (mist: 338 texture loads for 38 files, ~350 MB of PNG decoded for
// 36 MB), and GLTFLoader's own cache is per glb. Keyed by the resolved file and its sampler; textures with an
// extension (basisu, webp, ...) go the usual way. A glb that clones a texture (texCoord, transform) still shares
// its image (THREE.Source), so render.js sharedMaterial's one upload per texture holds.
class SharedTextures {
  constructor(parser, cache) { this.parser = parser; this.cache = cache; this.name = 'lasers_shared_textures'; }

  loadTexture(index) {
    const p = this.parser, json = p.json;
    const def = json.textures?.[index], src = json.images?.[def?.source];
    if (!def || typeof src?.uri !== 'string' || /^(data|blob):/.test(src.uri) || (def.extensions && Object.keys(def.extensions).length)) return null;
    const key = `${THREE.LoaderUtils.resolveURL(src.uri, p.options.path)}|${JSON.stringify(json.samplers?.[def.sampler] ?? null)}`;
    let t = this.cache.get(key);
    if (!t) {
      const loader = p.options.manager.getHandler(src.uri) || p.textureLoader;
      t = p.loadTextureImage(index, def.source, loader);
      this.cache.set(key, t);
      t.then((tex) => { if (!tex) this.cache.delete(key); }, () => this.cache.delete(key)); // a failed load may be retried
    }
    return t;
  }
}

export async function loadMapIndex(base = 'maps/') {
  return fetchJson(base + 'index.json', FRESH);
}

export async function loadScenarios(map) {
  try { return await fetchJson(`scenarios/${mapName(map)}.json`); } catch { return { map, scenarios: [] }; }
}

// A path the manifest names, relative to the map folder (or its default when it names none).
function manifestPath(value, fallback) {
  const p = safeRelPath(value ?? fallback);
  if (p == null) throw new Error(`manifest: unsafe path ${JSON.stringify(String(value).slice(0, 80))}`);
  return p;
}

// opts.tier: 'medium' | 'low' (a lasers-bake --tiers copy, textures from q/<tier>/tex/), else high
export async function loadMap(name, onProgress = () => {}, opts = {}) {
  const base = `maps/${mapName(name)}/`;
  onProgress('manifest');
  // manifest.json says which version the rest is; everything after it is fetched as <file>?v=<version>, so it
  // can be cached as immutable and a rebake still reaches the browser
  const tier = opts.tier === 'medium' || opts.tier === 'low' ? opts.tier : '';
  // a tier's tex.json (newer bakes): its textures' format and version; an older bake has none (PNGs, the map's version)
  const [manifest, texJson] = await Promise.all([
    fetchJson(base + 'manifest.json', FRESH),
    tier ? fetchJson(`${base}q/${tier}/tex.json`, FRESH).catch(() => null) : null,
  ]);
  const version = manifest.version;
  const url = (rel) => versioned(base + rel, version);
  const texVersion = typeof texJson?.version === 'string' && /^\d{1,20}$/.test(texJson.version) ? texJson.version : '';
  const tex = tier ? { base: `${base}q/${tier}/tex/`, webp: texJson?.format === 'webp', version: texVersion } : null;
  const loader = glbLoader(version, base, tex);
  onProgress('entities');
  // the big files (collision, the particle-trace collision): their bytes move the loading bar, which a round's
  // server also reads to tell a slow download from a stuck one (server/coop-round.js). The total isn't known up
  // front (compressed responses), so the share creeps toward 100% as megabytes arrive.
  let got = 0, shown = -1;
  const bytes = (n) => {
    got += n;
    const pct = Math.min(99, Math.floor(100 * (1 - Math.exp(-got / (16 * 1024 * 1024)))));
    if (pct !== shown) { shown = pct; onProgress(`entities ${pct}%`); }
  };
  // optional: the static world as particle traces see it (lasers-bake collision_fx*.bin; older bakes have none),
  // fetched alongside the rest rather than after it
  const fxFiles = Promise.all([fetchBufferProgress(url('collision_fx.bin'), bytes).catch(() => null), fetchBuffer(url('collision_fx_layers.bin')).catch(() => null)]);
  const [entities, hullsRaw, colBuf, particles, entwatch, overview, animations, stripper] = await Promise.all([
  // optional: the map's physics for CS2's physics (lasers-bake --physics; world/physics-world.js), and its runtime
  // (rubikon/, served from /rubikon/_framework by tools/build-rubikon.mjs), once per page
  const physicsFile = Promise.all([
    fetchBuffer(url('physics.bin')).catch(() => null),
    loadPhysics(new URL(`${import.meta.env?.BASE_URL || '/'}rubikon/_framework/dotnet.js`, location.href).href),
  ]).then(([bin, ok]) => (ok ? bin : null));
    fetchJson(url('entities.json')),
    fetchJson(url(manifestPath(manifest.hulls, 'hulls.json'))).catch(() => ({})),
    fetchBufferProgress(url(manifestPath(manifest.collision?.file, 'collision.bin')), bytes),
    fetchJson(url('particles.json')).catch(() => ({})),
    // optional: GFL's EntWatch items (tools/entwatch.mjs) and the map's CS2 radar (lasers-bake --overview)
    fetchJson(url('entwatch.json')).catch(() => null),
    fetchJson(url('overview/overview.json')).catch(() => null),
    // optional: prop_dynamic sequence lengths (lasers-bake --models), read by entities/classes/props.js
    manifest.animations ? fetchJson(url(manifestPath(manifest.animations, null))).catch(() => null) : null,
    // optional: GFL's StripperCS2 edits to this map (tools/stripper.mjs), applied below as GFL's servers do
    fetchJson(url('stripper.json')).catch(() => null),
  ]);
  // the map's sound events' lengths, for point_soundevent's OnSoundFinished (entities/classes/soundents.js)
  const sounds = soundDurations(await fetchJson(url('soundevents.json')).catch(() => null));
  // optional: the water shader's textures (lasers-bake --water), only for a map with CS2 water in it
  const water = waterTextures(await fetchJson(url('water/water.json')).catch(() => null), url);
  // the same edits the co-op server applies to its copy (server/map-store.js): both must hold the same entities
  applyStripper(entities, stripper, name);
  const [fxBuf, fxLayerBuf] = await fxFiles;
  const collisionFx = fxBuf && fxLayerBuf && fxBuf.byteLength === fxLayerBuf.byteLength * 9 ? { tris: new Float32Array(fxBuf), layers: new Uint32Array(fxLayerBuf) } : null;
  const physics = await physicsFile;
  const collision = new Float32Array(colBuf);

  const { hulls, bounds } = normaliseHulls(hullsRaw);

  // the world in chunks streamed around the player (tools/chunk-world.mjs, world/stream.js), else the whole glb
  const chunkJson = opts.chunks !== false && manifest.chunks === 'world/chunks.json' ? await fetchJson(url('world/chunks.json')).catch(() => null) : null;
  const chunks = chunkJson ? chunkList(chunkJson) : [];
  let world = null;
  if (!chunks.length) {
    onProgress('world');
    world = await loadGlb(loader, base + manifestPath(manifest.world, null), (p) => onProgress(`world ${Math.round(p * 100)}%`));
  }
  // attempt > 0 (world/stream.js retrying): a URL of its own, or three's loader would join the request that hung
  const loadChunk = (file, attempt = 0) => loadGlb(loader, base + file + (attempt > 0 ? `?retry=${attempt}` : ''));

  const renderModels = new Set((Array.isArray(manifest.renderModels) ? manifest.renderModels : []).map(assetKey));
  const modelBase = base + manifestPath(manifest.models, 'models/');
  const modelCache = new Map();
  const getModel = (path) => {
    const key = assetKey(path);
    if (!renderModels.has(key)) return null;
    if (!modelCache.has(key)) {
      const rel = safeRelPath(key.replace(/\.vmdl$/, '.glb'));
      modelCache.set(key, rel == null ? Promise.resolve(null) : loadGlb(loader, modelBase + rel).catch(() => null));
    }
    return modelCache.get(key);
  };

  const fx = Object.create(null);
  for (const [k, v] of Object.entries(particles || {})) fx[assetKey(k)] = v;
  const items = mapItems(entities, entwatch); // world/items.js: the map's EntWatch items, heals marked
  // the map's particle effects as the game has them (bake fx/), run by fx/particles; null for an older bake
  const effects = await MapEffects.load((rel) => url(rel), fetchJson);
  // particles that draw a model (C_OP_RenderModels) take it from the map's own models
  if (effects) { effects.getModel = getModel; effects.modelToSource = GLTF_TO_SOURCE; }
  const radar = radarInfo(overview, (rel) => url(rel));
  return { name, version, manifest, entities, collision, collisionFx, hulls, bounds, animations, soundDurations: sounds, world, chunks, loadChunk, getModel, particles: fx, items, radar, effects, water };
}

// water.json -> { textures: { <vtex path>: url }, frames: { <vtex path>: slices }, cubes } (null without one). File names only
// as the bake writes them; frame counts 1..64 (a texture array's animation frames, stacked in its PNG)
function waterTextures(j, url) {
  const t = j?.textures;
  if (!t || typeof t !== 'object') return null;
  const textures = Object.create(null), frames = Object.create(null);
  for (const [vtex, file] of Object.entries(t)) {
    if (typeof file === 'string' && /^[a-z0-9_]{1,110}\.png$/.test(file)) textures[vtex] = url(`water/${file}`);
  }
  for (const [vtex, n] of Object.entries(j.frames && typeof j.frames === 'object' ? j.frames : {})) {
    if (textures[vtex] && Number.isInteger(n) && n >= 1 && n <= 64) frames[vtex] = n;
  }
  // cubes: { <vtex path>: { size, faces: [6 x size x size x RGB floats] } } (WaterBake.cs: a vmat's small HDR cube) -> RGBA floats
  const cubes = Object.create(null);
  for (const [vtex, c] of Object.entries(j.cubes && typeof j.cubes === 'object' ? j.cubes : {})) {
    const n = c?.size;
    if (!Number.isInteger(n) || n < 1 || n > 16 || !Array.isArray(c.faces) || c.faces.length !== 6 * n * n * 3) continue;
    if (!c.faces.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 65504)) continue;
    const data = new Float32Array(6 * n * n * 4);
    for (let i = 0; i < 6 * n * n; i++) { data[i * 4] = c.faces[i * 3]; data[i * 4 + 1] = c.faces[i * 3 + 1]; data[i * 4 + 2] = c.faces[i * 3 + 2]; data[i * 4 + 3] = 1; }
    cubes[vtex] = { size: n, data };
  }
  return { textures, frames, cubes };
}

// (the loader adds ?v=)
// a glb (and its textures) that shows no progress for GLB_IDLE_MS fails instead of holding a stage's load for ever
// (a file replaced on the host mid-download); world/stream.js tries a chunk once more. Two tries fit well inside
// the co-op server's wait for a round's players (server/coop-round.js LOAD_CAP_MS)
const GLB_IDLE_MS = 20_000;
function loadGlb(loader, url, onProgress) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const poke = () => { clearTimeout(timer); timer = setTimeout(() => reject(new Error(`${url}: no data for ${GLB_IDLE_MS / 1000} s`)), GLB_IDLE_MS); };
    poke();
    // the clips ride on the scene (Object3D.animations survives clone()): world/anim.js plays them
    loader.load(url, (g) => { clearTimeout(timer); g.scene.animations = g.animations || []; resolve(g.scene); },
      (e) => { poke(); if (e.total) onProgress?.(e.loaded / e.total); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

// overview.json -> { posX, posY, scale, size, sections: [{ min, max, src }] } (null without one). Numbers checked, image
// names only from the fixed radar[_<suffix>].png set the bake writes.
function radarInfo(o, url) {
  if (!o || typeof o !== 'object' || !Number.isFinite(o.pos_x) || !Number.isFinite(o.pos_y) || !(o.scale > 0)) return null;
  const images = o.images && typeof o.images === 'object' ? o.images : {};
  const src = (suffix) => {
    const name = images[suffix];
    return typeof name === 'string' && /^radar(_[a-z0-9]{1,16})?\.png$/.test(name) ? url('overview/' + name) : null;
  };
  const sections = (Array.isArray(o.sections) ? o.sections : [])
    .map((s) => ({ min: Number(s?.min), max: Number(s?.max), src: src(String(s?.name ?? '').toLowerCase()) }))
    .filter((s) => Number.isFinite(s.min) && Number.isFinite(s.max) && s.src);
  const base = src('') || sections[0]?.src || null;
  if (!base) return null;
  // size: the source texture's width (CS2 maps the overview over texW * scale units); older bakes: 1024
  const size = Number.isInteger(o.size) && o.size >= 16 && o.size <= 8192 ? o.size : 1024;
  return { posX: o.pos_x, posY: o.pos_y, scale: o.scale, size, base, sections };
}
