// hulls.json -> the engine's hull tables. Pure (no DOM, no three.js): world/assets.js uses it in the browser and
// tools/sim.mjs in Node.
//
// Keys become lower case with forward slashes (lib/paths.js assetKey); the tables have no prototype, so a model
// called "constructor" or "__proto__" is just a missing key. Mesh-only shapes become their bounding box so
// triggers built from them still work.
import { assetKey } from '../lib/paths.js';
import { emptyBounds, growBounds } from '../lib/math.js';

export function normaliseHulls(hullsRaw) {
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
      const layers = Number.isInteger(h.layers) ? h.layers >>> 0 : null; // interaction-layer bits (bake LayersOf), null in older bakes
      if (h.planes) out.push({ verts: h.verts, planes: h.planes, solid: h.solid !== false, layers });
      else if (v.length) out.push({ ...boxHull(min, max, h.solid !== false), layers });
    }
    if (out.length) { hulls[key] = out; bounds[key] = all; }
  }
  return { hulls, bounds };
}

function boxHull(min, max, solid) {
  const verts = [];
  for (let i = 0; i < 8; i++) verts.push(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]);
  const planes = [1, 0, 0, max[0], -1, 0, 0, -min[0], 0, 1, 0, max[1], 0, -1, 0, -min[1], 0, 0, 1, max[2], 0, 0, -1, -min[2]];
  return { verts, planes, solid };
}
