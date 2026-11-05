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
import { emptyBounds, growBounds } from '../lib/math.js';

// VRF exports glTF in metres, Y up: gltf = (src.y, src.z, src.x) * 0.0254. This puts it back in Source units.
export const GLTF_TO_SOURCE = new THREE.Matrix4().set(
  0, 0, 1 / 0.0254, 0,
  1 / 0.0254, 0, 0, 0,
  0, 1 / 0.0254, 0, 0,
  0, 0, 0, 1,
);

// A glb loader whose every request (the glb and the textures beside it) carries the map's version.
function glbLoader(version) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (/^(blob|data):/.test(url) ? url : versioned(url, version)));
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

export async function loadMap(name, onProgress = () => {}) {
  const base = `maps/${mapName(name)}/`;
  onProgress('manifest');
  // manifest.json says which version the rest is; everything after it is fetched as <file>?v=<version>, so it
  // can be cached as immutable and a rebake still reaches the browser
  const manifest = await fetchJson(base + 'manifest.json', FRESH);
  const version = manifest.version;
  const url = (rel) => versioned(base + rel, version);
  const loader = glbLoader(version);
  onProgress('entities');
  const [entities, hullsRaw, colBuf, particles] = await Promise.all([
    fetchJson(url('entities.json')),
    fetchJson(url(manifestPath(manifest.hulls, 'hulls.json'))).catch(() => ({})),
    fetchBuffer(url(manifestPath(manifest.collision?.file, 'collision.bin'))),
    fetchJson(url('particles.json')).catch(() => ({})),
  ]);
  const collision = new Float32Array(colBuf);

  // Normalise hulls: keys lower-case with forward slashes; mesh-only shapes become their bounding box so
  // triggers built from them still work.
  const hulls = Object.create(null);
  const bounds = Object.create(null);
  for (const [model, list] of Object.entries(hullsRaw || {})) {
    if (!Array.isArray(list)) continue;
    const key = assetKey(model);
    const out = [];
    const all = emptyBounds();
    for (const h of list) {
      if (!h || typeof h !== 'object') continue;
      const v = h.verts || h.tris || [];
      const { min, max } = emptyBounds();
      for (let i = 0; i < v.length; i += 3) for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], v[i + a]); max[a] = Math.max(max[a], v[i + a]);
      }
      growBounds(all.min, all.max, min, max);
      const b = { min, max };
      if (h.planes) out.push({ verts: h.verts, planes: h.planes, solid: h.solid !== false });
      else if (v.length) out.push(boxHull(b.min, b.max, h.solid !== false));
    }
    if (out.length) { hulls[key] = out; bounds[key] = all; }
  }

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
  return { name, version, manifest, entities, collision, hulls, bounds, world, getModel, particles: fx };
}

function boxHull(min, max, solid) {
  const verts = [];
  for (let i = 0; i < 8; i++) verts.push(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]);
  const planes = [1, 0, 0, max[0], -1, 0, 0, -min[0], 0, 1, 0, max[1], 0, -1, 0, -min[1], 0, 0, 1, max[2], 0, 0, -1, -min[2]];
  return { verts, planes, solid };
}

// (the loader adds ?v=)
function loadGlb(loader, url, onProgress) {
  return new Promise((resolve, reject) => {
    loader.load(url, (g) => resolve(g.scene), (e) => e.total && onProgress?.(e.loaded / e.total), reject);
  });
}
