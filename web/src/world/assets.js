// Loading a baked map folder (the lasers-bake / lasers.cybo.dev layout).
//
// Everything in a map folder is untrusted (a workshop map anyone can publish): the map name and every path a
// manifest names go through lib/paths.js before they reach a URL, and the lookup tables built here have no
// prototype, so a model or effect called "constructor" or "__proto__" is just a missing key.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mapName, safeRelPath, assetKey, versioned } from '../lib/paths.js';
import { fetchJson, fetchBuffer, FRESH } from '../lib/fetch.js';
import { normaliseHulls } from './hulls.js';
import { mapItems } from './items.js';
import { MapEffects } from '../fx/effects.js';

// VRF exports glTF in metres, Y up: gltf = (src.y, src.z, src.x) * 0.0254. This puts it back in Source units.
export const GLTF_TO_SOURCE = new THREE.Matrix4().set(
  0, 0, 1 / 0.0254, 0,
  1 / 0.0254, 0, 0, 0,
  0, 1 / 0.0254, 0, 0,
  0, 0, 0, 1,
);

// A glb loader whose every request (the glb and the textures beside it) carries the map's version.
// texBase: a quality tier's folder (maps/<map>/q/<tier>/tex/): the glbs' PNGs come from there instead
function glbLoader(version, mapBase = '', texBase = '') {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob|data):/.test(url)) return url;
    if (texBase) { const i = url.indexOf(mapBase); if (i >= 0 && /\.png$/i.test(url)) url = texBase + url.slice(i + mapBase.length); }
    return versioned(url, version);
  });
  return new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
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
  const manifest = await fetchJson(base + 'manifest.json', FRESH);
  const version = manifest.version;
  const url = (rel) => versioned(base + rel, version);
  const tier = opts.tier === 'medium' || opts.tier === 'low' ? opts.tier : '';
  const loader = glbLoader(version, base, tier ? `${base}q/${tier}/tex/` : '');
  onProgress('entities');
  const [entities, hullsRaw, colBuf, particles, entwatch, overview, animations] = await Promise.all([
    fetchJson(url('entities.json')),
    fetchJson(url(manifestPath(manifest.hulls, 'hulls.json'))).catch(() => ({})),
    fetchBuffer(url(manifestPath(manifest.collision?.file, 'collision.bin'))),
    fetchJson(url('particles.json')).catch(() => ({})),
    // optional: GFL's EntWatch items (tools/entwatch.mjs) and the map's CS2 radar (lasers-bake --overview)
    fetchJson(url('entwatch.json')).catch(() => null),
    fetchJson(url('overview/overview.json')).catch(() => null),
    // optional: prop_dynamic sequence lengths (lasers-bake --models), read by entities/classes/props.js
    manifest.animations ? fetchJson(url(manifestPath(manifest.animations, null))).catch(() => null) : null,
  ]);
  // optional: the static world as particle traces see it (lasers-bake collision_fx*.bin; older bakes have none)
  const [fxBuf, fxLayerBuf] = await Promise.all([fetchBuffer(url('collision_fx.bin')).catch(() => null), fetchBuffer(url('collision_fx_layers.bin')).catch(() => null)]);
  const collisionFx = fxBuf && fxLayerBuf && fxBuf.byteLength === fxLayerBuf.byteLength * 9 ? { tris: new Float32Array(fxBuf), layers: new Uint32Array(fxLayerBuf) } : null;
  const collision = new Float32Array(colBuf);

  const { hulls, bounds } = normaliseHulls(hullsRaw);

  onProgress('world');
  const world = await loadGlb(loader, base + manifestPath(manifest.world, null), (p) => onProgress(`world ${Math.round(p * 100)}%`));

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
  const radar = radarInfo(overview, (rel) => url(rel));
  return { name, version, manifest, entities, collision, collisionFx, hulls, bounds, animations, world, getModel, particles: fx, items, radar, effects };
}

// (the loader adds ?v=)
function loadGlb(loader, url, onProgress) {
  return new Promise((resolve, reject) => {
    // the clips ride on the scene (Object3D.animations survives clone()): world/anim.js plays them
    loader.load(url, (g) => { g.scene.animations = g.animations || []; resolve(g.scene); }, (e) => e.total && onProgress?.(e.loaded / e.total), reject);
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
