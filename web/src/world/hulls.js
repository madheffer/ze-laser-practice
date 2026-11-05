// hulls.json -> the engine's hull tables. Pure (no DOM, no three.js): world/assets.js uses it in the browser and
// tools/sim.mjs in Node.
//
// Keys become lower case with forward slashes (lib/paths.js assetKey); the tables have no prototype, so a model
// called "constructor" or "__proto__" is just a missing key. A mesh-only shape becomes its bounding box so triggers
// built from it still work; it keeps its triangles (`mesh`), and a solid entity collides with those (meshSlabs).
import { assetKey } from '../lib/paths.js';
import { emptyBounds, growBounds, sub3 as sub, dot3 as dot, cross3 as cross } from '../lib/math.js';

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
      else if (v.length) out.push({ ...boxHull(min, max, h.solid !== false), layers, mesh: Array.isArray(h.tris) ? h.tris : null });
    }
    if (out.length) { hulls[key] = out; bounds[key] = all; }
  }
  return { hulls, bounds };
}

// What a solid entity collides with for a mesh-only shape: each triangle as a convex slab SLAB units thick, pushed
// back behind its face (away from its normal: a mesh's faces point at the side you stand on). Its bounding box would
// fill a hollow mesh: ze__hell_p's rooms are one mesh each, walls and floor, so each room was a block you couldn't
// stand in. Built on first use and kept on the hull (model space), so triggers made of huge meshes (ze_deadcore's
// presses, 85k triangles) never pay for it: they touch with the box. Degenerate triangles are skipped.
const SLAB = 1;
const MAX_MESH_TRIS = 20000; // a hostile hulls.json can't make the load quadratic forever
const slabCache = new WeakMap();
export function meshSlabs(hull) {
  if (!hull?.mesh) return null;
  let out = slabCache.get(hull);
  if (!out) { out = triangleSlabs(hull.mesh).map((x) => ({ ...x, solid: hull.solid, layers: hull.layers })); slabCache.set(hull, out); }
  return out;
}
function triangleSlabs(tris) {
  const out = [];
  const n = Math.min(Math.floor(tris.length / 9), MAX_MESH_TRIS);
  for (let t = 0; t < n; t++) {
    const p = tris.slice(t * 9, t * 9 + 9).map(Number);
    if (!p.every(Number.isFinite)) continue;
    const a = p.slice(0, 3), b = p.slice(3, 6), c = p.slice(6, 9);
    const ab = sub(b, a), ac = sub(c, a);
    const nrm = cross(ab, ac);
    const len = Math.hypot(...nrm);
    if (len < 1e-6) continue;
    const N = nrm.map((x) => x / len);
    const back = (q) => [q[0] - N[0] * SLAB, q[1] - N[1] * SLAB, q[2] - N[2] * SLAB];
    const verts = [...a, ...b, ...c, ...back(a), ...back(b), ...back(c)];
    const planes = [N[0], N[1], N[2], dot(N, a), -N[0], -N[1], -N[2], -dot(N, back(a))];
    for (const [q, r, other] of [[a, b, c], [b, c, a], [c, a, b]]) {
      let s = cross(sub(r, q), N);
      const L = Math.hypot(...s);
      if (L < 1e-9) continue;
      s = s.map((x) => x / L);
      if (dot(s, sub(other, q)) > 0) s = s.map((x) => -x); // outward: away from the triangle's third corner
      planes.push(s[0], s[1], s[2], dot(s, q));
    }
    out.push({ verts, planes, edges: hullEdges(verts, planes) });
  }
  return out;
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
