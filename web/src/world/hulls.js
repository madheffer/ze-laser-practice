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
      if (h.planes) out.push({ verts: h.verts, planes: h.planes, edges: hullEdges(h.verts, h.planes), solid: h.solid !== false, layers });
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
  return { verts, planes, edges: [1, 0, 0, 0, 1, 0, 0, 0, 1], solid };
}

// A convex hull's distinct edge directions (unit, flat [x,y,z,...]): two faces share an edge when at least two of the
// hull's vertices lie on both, and that edge runs along the cross of their normals. collision.js boxTouchesHull needs
// them for an exact box-vs-hull overlap (the box-axis x edge separating axes).
export function hullEdges(verts, planes) {
  const EPS = 0.01, out = [];
  const onPlane = (p) => {
    const idx = [];
    for (let i = 0; i < verts.length; i += 3) {
      if (Math.abs(planes[p] * verts[i] + planes[p + 1] * verts[i + 1] + planes[p + 2] * verts[i + 2] - planes[p + 3]) < EPS) idx.push(i);
    }
    return new Set(idx);
  };
  const sets = [];
  for (let p = 0; p < planes.length; p += 4) sets.push(onPlane(p));
  for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
    let shared = 0;
    for (const i of sets[a]) if (sets[b].has(i) && ++shared >= 2) break;
    if (shared < 2) continue;
    const [ax, ay, az] = [planes[a * 4], planes[a * 4 + 1], planes[a * 4 + 2]];
    const [bx, by, bz] = [planes[b * 4], planes[b * 4 + 1], planes[b * 4 + 2]];
    let x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
    const L = Math.hypot(x, y, z);
    if (L < 1e-6) continue;
    x /= L; y /= L; z /= L;
    let dup = false;
    for (let k = 0; k < out.length; k += 3) if (Math.abs(out[k] * x + out[k + 1] * y + out[k + 2] * z) > 0.9999) { dup = true; break; }
    if (!dup) out.push(x, y, z);
  }
  return out;
}
