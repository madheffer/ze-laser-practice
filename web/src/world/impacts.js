// Where a bullet meets the world, and what that surface is: the sound of the hit (CS2 plays the surface property's
// audiosounds.bulletimpact there; audio/surfaces.js has the names). The static world is the particle collision set
// (lasers-bake collision_fx*.bin, the shapes with their layer bits) and collision_fx_surfaces.bin gives each of its
// triangles a surface property hash (bake/Program.cs AppendTriangles, the shape's surface or a mesh triangle's own).
//
//   const impacts = await loadImpacts(mapName, version, collisionFx)   // null without the files (an older bake)
//   impacts.hit(eye, dir, range) -> { pos, hash, distance } | null
//
// The trace is CS2's bullet trace (world/bullets.js: interacts-with 0x1c300b, player clips let bullets through).
// Moving brush entities and props are not tested (their surfaces aren't baked).
import { makeTrace } from './collision.js';
import { bulletWorld, BULLET_MASK } from './bullets.js';
import { fetchBuffer } from '../lib/fetch.js';
import { mapName as safeMap, versioned } from '../lib/paths.js';

const FIND = 1.5; // units around the hit point searched for the triangle it is on

export async function loadImpacts(name, version, fx) {
  if (!fx?.tris || !fx.layers) return null;
  const buf = await fetchBuffer(versioned(`maps/${safeMap(name)}/collision_fx_surfaces.bin`, version)).catch(() => null);
  if (!buf || buf.byteLength !== fx.layers.byteLength) return null;
  return new BulletImpacts(fx, new Uint32Array(buf));
}

export class BulletImpacts {
  constructor(fx, surfaces) {
    this.world = bulletWorld(fx); // shared with fx/trace.js
    this.surfaces = surfaces;
    this.tr = makeTrace();
  }

  hit(o, d, range = 8192) {
    const e = [o[0] + d[0] * range, o[1] + d[1] * range, o[2] + d[2] * range];
    const tr = this.world.traceRay(o, e, this.tr, true, BULLET_MASK);
    if (!(tr.fraction < 1) || tr.startSolid) return null;
    const pos = tr.endPos.slice();
    const dist = tr.fraction * range;
    // the triangle under the hit: the nearest crossing of the ray among the triangles around it
    const lo = [pos[0] - FIND, pos[1] - FIND, pos[2] - FIND], hi = [pos[0] + FIND, pos[1] + FIND, pos[2] + FIND];
    const T = this.world.bvh.tris, L = this.world.layers;
    let best = -1, bestErr = Infinity;
    this.world.bvh.query(lo, hi, (t) => {
      if (L && !(L[t] & BULLET_MASK)) return;
      const k = rayTri(o, d, T, t * 9);
      if (k == null) return;
      const err = Math.abs(k - dist);
      if (err < bestErr) { bestErr = err; best = t; }
    });
    if (best < 0) return null;
    return { pos, hash: this.surfaces[best] >>> 0, distance: dist };
  }
}

// Möller–Trumbore: the distance along d where the ray from o crosses triangle T[i..i+8], or null
function rayTri(o, d, T, i) {
  const e1x = T[i + 3] - T[i], e1y = T[i + 4] - T[i + 1], e1z = T[i + 5] - T[i + 2];
  const e2x = T[i + 6] - T[i], e2y = T[i + 7] - T[i + 1], e2z = T[i + 8] - T[i + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  const tx = o[0] - T[i], ty = o[1] - T[i + 1], tz = o[2] - T[i + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-4 || u > 1 + 1e-4) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < -1e-4 || u + v > 1 + 1e-4) return null;
  const k = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return k >= 0 ? k : null;
}
