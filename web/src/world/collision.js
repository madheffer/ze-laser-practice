// Box traces against the map: the one query CS movement is built on.
//
// A trace sweeps an axis-aligned box (the player hull) from a start to an end point and reports how far it
// got before touching something, and the plane it touched. It is Quake's brush clip: the box is folded into
// each solid (Minkowski sum) so the sweep becomes a segment, and the segment is clipped against the solid's
// planes, stopping DIST_EPSILON short so the next move starts cleanly outside.
//
// Static world: triangles from collision.bin in a BVH; each triangle is clipped as a thin convex solid (its
// face, the 3 axes and the 9 edge x axis separating directions).
// Moving brush entities: convex hulls (hulls.json) placed by their entity's current transform.

export const DIST_EPSILON = 0.03125;

export function makeTrace() {
  return { fraction: 1, startSolid: false, allSolid: false, endPos: [0, 0, 0], normal: [0, 0, 0], hit: null };
}

// ---------------------------------------------------------------- BVH over triangles

export class TriangleBVH {
  // parts: { idx, nodeB, nodeI } of a tree already built over these tris (world/bvh-build.js builds it in a worker)
  constructor(tris, parts = null) {
    this.tris = tris; // Float32Array, 9 floats per triangle
    const n = tris.length / 9;
    this.count = n;
    if (parts) {
      this.idx = parts.idx; this.nodeB = parts.nodeB; this.nodeI = parts.nodeI;
      this.stack = new Uint32Array(128);
      return;
    }
    const idx = new Uint32Array(n);
    const cen = new Float32Array(n * 3);
    const bmin = new Float32Array(n * 3);
    const bmax = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      idx[i] = i;
      for (let a = 0; a < 3; a++) {
        const v0 = tris[i * 9 + a], v1 = tris[i * 9 + 3 + a], v2 = tris[i * 9 + 6 + a];
        const lo = Math.min(v0, v1, v2), hi = Math.max(v0, v1, v2);
        bmin[i * 3 + a] = lo; bmax[i * 3 + a] = hi; cen[i * 3 + a] = (lo + hi) * 0.5;
      }
    }
    this.idx = idx;
    // nodes: [minx,miny,minz,maxx,maxy,maxz] + (left/right or start/count). Every split leaves both sides non-empty,
    // so a tree over n triangles has at most 2n - 1 nodes: preallocated typed arrays, scalar bounds (a big map's
    // build was ~0.3 s of frozen page on a desktop with growing JS arrays, several times that on a phone)
    const cap = Math.max(1, 2 * n - 1);
    const nodesB = new Float32Array(cap * 6);
    const nodesI = new Uint32Array(cap * 3);
    let nodes = 0;
    const build = (start, end) => {
      const ni = nodes++;
      let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
      let clx = Infinity, cly = Infinity, clz = Infinity, chx = -Infinity, chy = -Infinity, chz = -Infinity;
      for (let k = start; k < end; k++) {
        const t3 = idx[k] * 3;
        let v = bmin[t3]; if (v < lx) lx = v; v = bmin[t3 + 1]; if (v < ly) ly = v; v = bmin[t3 + 2]; if (v < lz) lz = v;
        v = bmax[t3]; if (v > hx) hx = v; v = bmax[t3 + 1]; if (v > hy) hy = v; v = bmax[t3 + 2]; if (v > hz) hz = v;
        v = cen[t3]; if (v < clx) clx = v; if (v > chx) chx = v;
        v = cen[t3 + 1]; if (v < cly) cly = v; if (v > chy) chy = v;
        v = cen[t3 + 2]; if (v < clz) clz = v; if (v > chz) chz = v;
      }
      const o = ni * 6;
      nodesB[o] = lx; nodesB[o + 1] = ly; nodesB[o + 2] = lz; nodesB[o + 3] = hx; nodesB[o + 4] = hy; nodesB[o + 5] = hz;
      const count = end - start;
      if (count <= 6) {
        nodesI[ni * 3] = 1; nodesI[ni * 3 + 1] = start; nodesI[ni * 3 + 2] = count;
        return ni;
      }
      let axis = 0;
      const ext = [chx - clx, chy - cly, chz - clz];
      if (ext[1] > ext[axis]) axis = 1;
      if (ext[2] > ext[axis]) axis = 2;
      const mid = axis === 0 ? (clx + chx) * 0.5 : axis === 1 ? (cly + chy) * 0.5 : (clz + chz) * 0.5;
      let i = start, j = end - 1;
      while (i <= j) {
        if (cen[idx[i] * 3 + axis] < mid) i++;
        else { const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp; j--; }
      }
      let split = i;
      if (split === start || split === end) split = (start + end) >> 1;
      const l = build(start, split);
      const r = build(split, end);
      nodesI[ni * 3] = 0; nodesI[ni * 3 + 1] = l; nodesI[ni * 3 + 2] = r;
      return ni;
    };
    if (n > 0) build(0, n);
    this.nodeB = nodesB.slice(0, nodes * 6);
    this.nodeI = nodesI.slice(0, nodes * 3);
    this.stack = new Uint32Array(128);
  }

  // Calls fn(triIndex) for every triangle whose bounds overlap [lo, hi].
  query(lo, hi, fn) {
    if (!this.count) return;
    const B = this.nodeB, I = this.nodeI, st = this.stack;
    let sp = 0;
    st[sp++] = 0;
    while (sp) {
      const n = st[--sp];
      const o = n * 6;
      if (B[o] > hi[0] || B[o + 3] < lo[0] || B[o + 1] > hi[1] || B[o + 4] < lo[1] || B[o + 2] > hi[2] || B[o + 5] < lo[2]) continue;
      if (I[n * 3] === 1) {
        const s = I[n * 3 + 1], c = I[n * 3 + 2];
        for (let k = s; k < s + c; k++) fn(this.idx[k]);
      } else {
        st[sp++] = I[n * 3 + 1];
        st[sp++] = I[n * 3 + 2];
      }
    }
  }

  // Calls fn(triIndex) for the triangles in leaves the segment s + t*d (t in [0, best()]) passes through, nearest
  // boxes first enough: best() is re-read per node, so boxes beyond the closest hit so far are skipped.
  queryRay(s, d, best, fn) {
    if (!this.count) return;
    const B = this.nodeB, I = this.nodeI, st = this.stack;
    const ix = 1 / d[0], iy = 1 / d[1], iz = 1 / d[2];
    let sp = 0;
    st[sp++] = 0;
    while (sp) {
      const n = st[--sp];
      const o = n * 6;
      // slab test (an infinite inverse on a zero component gives +-Infinity, which the min/max handle)
      let t0 = (B[o] - s[0]) * ix, t1 = (B[o + 3] - s[0]) * ix;
      let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
      t0 = (B[o + 1] - s[1]) * iy; t1 = (B[o + 4] - s[1]) * iy;
      lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      t0 = (B[o + 2] - s[2]) * iz; t1 = (B[o + 5] - s[2]) * iz;
      lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      // NaN (a zero direction component exactly on a box face) keeps the node: never skip a box wrongly
      if (hi < Math.max(lo, 0) - 1e-6 || lo > best() + 1e-6) continue;
      if (I[n * 3] === 1) {
        const s0 = I[n * 3 + 1], c = I[n * 3 + 2];
        for (let k = s0; k < s0 + c; k++) fn(this.idx[k]);
      } else {
        st[sp++] = I[n * 3 + 1];
        st[sp++] = I[n * 3 + 2];
      }
    }
  }
}

// ---------------------------------------------------------------- rays

// A zero-size trace against one triangle: Moller-Trumbore for where the segment crosses it, then the same stand-off
// the box clip gives (DIST_EPSILON short of the face, the normal facing the start; along the ray when that is less). A start
// within DIST_EPSILON of the face, over the triangle, is start-solid, as the clip's padded slab reports.
const EDGE_TOL = 1e-5; // barycentric slack, so a ray along a shared edge hits one of its two triangles
function rayTriangle(T, o, s, d, tr) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const e1x = T[o + 3] - ax, e1y = T[o + 4] - ay, e1z = T[o + 5] - az;
  const e2x = T[o + 6] - ax, e2y = T[o + 7] - ay, e2z = T[o + 8] - az;
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-9) return;
  nx /= nl; ny /= nl; nz /= nl;
  let d1 = nx * (s[0] - ax) + ny * (s[1] - ay) + nz * (s[2] - az);
  let dd = nx * d[0] + ny * d[1] + nz * d[2]; // d2 - d1
  if (d1 < 0) { d1 = -d1; dd = -dd; nx = -nx; ny = -ny; nz = -nz; }
  // where on the triangle: the start's projection when it sits on the face, else the crossing point
  const t = d1 <= DIST_EPSILON ? 0 : dd < 0 ? d1 / -dd : Infinity;
  if (!(t <= 1)) return;
  const px = s[0] + d[0] * t - ax, py = s[1] + d[1] * t - ay, pz = s[2] + d[2] * t - az;
  const d00 = e1x * e1x + e1y * e1y + e1z * e1z, d01 = e1x * e2x + e1y * e2y + e1z * e2z, d11 = e2x * e2x + e2y * e2y + e2z * e2z;
  const d20 = px * e1x + py * e1y + pz * e1z, d21 = px * e2x + py * e2y + pz * e2z;
  const den = d00 * d11 - d01 * d01;
  if (den <= 0) return;
  const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
  if (v < -EDGE_TOL || w < -EDGE_TOL || v + w > 1 + EDGE_TOL) return;
  if (d1 <= DIST_EPSILON) { tr.startSolid = true; return; }
  // stand off DIST_EPSILON along the normal, or along the ray if that is less: a grazing ray would otherwise stop
  // far short of the face (DIST_EPSILON / cos), where the box clip's other planes hide it
  const len = Math.hypot(d[0], d[1], d[2]);
  const f = Math.max(0, t - Math.min(DIST_EPSILON / -dd, len > 0 ? DIST_EPSILON / len : 0));
  if (f < tr.fraction) { tr.fraction = f; tr.normal[0] = nx; tr.normal[1] = ny; tr.normal[2] = nz; tr.hit = null; }
}

// ---------------------------------------------------------------- clipping

// A clip context: accumulates planes of one convex solid, then clips the swept box against them.
const clip = {
  enterFrac: -1, leaveFrac: 1, getOut: false, startOut: false, nx: 0, ny: 0, nz: 0, dead: false,
};

function clipReset() {
  clip.enterFrac = -1; clip.leaveFrac = 1; clip.getOut = false; clip.startOut = false; clip.dead = false;
}

// plane: n.p = dist (already expanded by the box's support along n). s/e: segment start/end (box centres).
function clipPlane(nx, ny, nz, dist, s, e) {
  if (clip.dead) return;
  const d1 = nx * s[0] + ny * s[1] + nz * s[2] - dist;
  const d2 = nx * e[0] + ny * e[1] + nz * e[2] - dist;
  if (d2 > 0) clip.getOut = true;
  if (d1 > 0) clip.startOut = true;
  if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1)) { clip.dead = true; return; }
  if (d1 <= 0 && d2 <= 0) return;
  if (d1 > d2) {
    const f = (d1 - DIST_EPSILON) / (d1 - d2);
    if (f > clip.enterFrac) { clip.enterFrac = f; clip.nx = nx; clip.ny = ny; clip.nz = nz; }
  } else {
    const f = (d1 + DIST_EPSILON) / (d1 - d2);
    if (f < clip.leaveFrac) clip.leaveFrac = f;
  }
}

// Both faces of a slab along unit axis d: [lo - r, hi + r].
// A slab thinner than 2 * DIST_EPSILON (a flat triangle's face or axis slab swept by a ray, h = 0) gets that thickness:
// otherwise the epsilon pulls the enter fraction past the leave fraction and a ray through the triangle misses.
// A box trace never meets this (its support r thickens every slab), so movement is unchanged.
function clipSlab(dx, dy, dz, lo, hi, h, s, e) {
  let r = Math.abs(dx) * h[0] + Math.abs(dy) * h[1] + Math.abs(dz) * h[2];
  if (hi - lo + 2 * r < 2 * DIST_EPSILON) r = DIST_EPSILON - (hi - lo) / 2;
  clipPlane(dx, dy, dz, hi + r, s, e);
  clipPlane(-dx, -dy, -dz, -(lo - r), s, e);
}

function clipFinish(tr, ref) {
  if (clip.dead) return;
  if (!clip.startOut) {
    tr.startSolid = true;
    if (!clip.getOut) { tr.allSolid = true; tr.fraction = 0; }
    return;
  }
  if (clip.enterFrac < clip.leaveFrac && clip.enterFrac > -1 && clip.enterFrac < tr.fraction) {
    tr.fraction = Math.max(0, clip.enterFrac);
    tr.normal[0] = clip.nx; tr.normal[1] = clip.ny; tr.normal[2] = clip.nz;
    tr.hit = ref;
  }
}

const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function clipTriangle(T, o, h, s, e, tr) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
  const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  clipReset();
  // face normal
  const e0x = bx - ax, e0y = by - ay, e0z = bz - az;
  const e1x = cx - bx, e1y = cy - by, e1z = cz - bz;
  const e2x = ax - cx, e2y = ay - cy, e2z = az - cz;
  let nx = e0y * -e2z - e0z * -e2y, ny = e0z * -e2x - e0x * -e2z, nz = e0x * -e2y - e0y * -e2x;
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-9) return;
  nx /= nl; ny /= nl; nz /= nl;
  const fd = nx * ax + ny * ay + nz * az;
  // Face plane first, so a flat hit reports the face normal rather than an edge axis.
  clipSlab(nx, ny, nz, fd, fd, h, s, e);
  // world axes
  clipSlab(1, 0, 0, Math.min(ax, bx, cx), Math.max(ax, bx, cx), h, s, e);
  clipSlab(0, 1, 0, Math.min(ay, by, cy), Math.max(ay, by, cy), h, s, e);
  clipSlab(0, 0, 1, Math.min(az, bz, cz), Math.max(az, bz, cz), h, s, e);
  // edge x axis
  const edges = [[e0x, e0y, e0z], [e1x, e1y, e1z], [e2x, e2y, e2z]];
  for (let i = 0; i < 3 && !clip.dead; i++) {
    const ed = edges[i];
    for (let a = 0; a < 3; a++) {
      const A = AX[a];
      let dx = ed[1] * A[2] - ed[2] * A[1], dy = ed[2] * A[0] - ed[0] * A[2], dz = ed[0] * A[1] - ed[1] * A[0];
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-6) continue;
      dx /= l; dy /= l; dz /= l;
      const p0 = dx * ax + dy * ay + dz * az, p1 = dx * bx + dy * by + dz * bz, p2 = dx * cx + dy * cy + dz * cz;
      clipSlab(dx, dy, dz, Math.min(p0, p1, p2), Math.max(p0, p1, p2), h, s, e);
    }
  }
  clipFinish(tr, null);
}

// A placed convex hull: world-space planes [nx,ny,nz,d]* plus its world AABB (bevel planes).
export function clipHull(hull, h, s, e, tr, ref) {
  clipReset();
  const P = hull.planes;
  for (let i = 0; i < P.length && !clip.dead; i += 4) {
    const nx = P[i], ny = P[i + 1], nz = P[i + 2];
    const r = Math.abs(nx) * h[0] + Math.abs(ny) * h[1] + Math.abs(nz) * h[2];
    clipPlane(nx, ny, nz, P[i + 3] + r, s, e);
  }
  const lo = hull.min, hi = hull.max;
  clipSlab(1, 0, 0, lo[0], hi[0], h, s, e);
  clipSlab(0, 1, 0, lo[1], hi[1], h, s, e);
  clipSlab(0, 0, 1, lo[2], hi[2], h, s, e);
  clipFinish(tr, ref);
}

// Clip a box sweep against entity solids ([{ hulls, min, max, ref }], EntityEngine.solids()) whose bounds meet the
// sweep's [lo, hi]; skip(ref, solid) leaves some out.
function clipSolids(solids, lo, hi, h, s, e, tr, mask = 0, skip = null) {
  for (const d of solids) {
    if (d.max[0] < lo[0] || d.min[0] > hi[0] || d.max[1] < lo[1] || d.min[1] > hi[1] || d.max[2] < lo[2] || d.min[2] > hi[2]) continue;
    if (skip && skip(d.ref, d)) continue;
    for (const hull of d.hulls) {
      // a hull outside the sweep can't be hit (a mesh brush is hundreds of triangle slabs: world/hulls.js)
      if (hull.min && (hull.max[0] < lo[0] || hull.min[0] > hi[0] || hull.max[1] < lo[1] || hull.min[1] > hi[1] || hull.max[2] < lo[2] || hull.min[2] > hi[2])) continue;
      if (!mask || hull.layers == null || (hull.layers & mask)) clipHull(hull, h, s, e, tr, d.ref);
    }
  }
}

function traceEnd(tr, s, e) {
  const f = tr.fraction;
  tr.endPos[0] = s[0] + (e[0] - s[0]) * f;
  tr.endPos[1] = s[1] + (e[1] - s[1]) * f;
  tr.endPos[2] = s[2] + (e[2] - s[2]) * f;
  return tr;
}

// Shorten a finished trace (tr, from s to e) by the entity solids it meets on the way: physboxes (classes/physics.js)
// trace the static world, then the map's movers and brushes, so a cube lands on a lift instead of falling through it.
export function traceSolids(tr, solids, s, e, h, skip = null) {
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(s[a], e[a]) - h[a] - 1;
    hi[a] = Math.max(s[a], e[a]) + h[a] + 1;
  }
  clipSolids(solids, lo, hi, h, s, e, tr, 0, skip);
  return traceEnd(tr, s, e);
}

// ---------------------------------------------------------------- world

export class CollisionWorld {
  // tris: collision.bin's floats, or an already built TriangleBVH (the co-op server shares one per map)
  // layers: optional Uint32Array, one interaction-layer bit set per triangle (collision_fx_layers.bin)
  constructor(tris, layers = null) {
    this.bvh = tris instanceof TriangleBVH ? tris : new TriangleBVH(tris);
    this.layers = layers;
    this.dynamic = []; // [{ hulls: [{planes,min,max}], min, max, ref }] refreshed by the entity system each tick
    this._lo = [0, 0, 0];
    this._hi = [0, 0, 0];
  }

  // Sweep a box (half extents h, centred) from s to e. Returns a trace. mask (interaction-layer bits) skips triangles
  // and hulls that carry layers none of which it has; 0 = no layer test (movement).
  traceBox(s, e, h, tr = makeTrace(), worldOnly = false, mask = 0) {
    tr.fraction = 1; tr.startSolid = false; tr.allSolid = false; tr.hit = null;
    tr.normal[0] = tr.normal[1] = tr.normal[2] = 0;
    const lo = this._lo, hi = this._hi;
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(s[a], e[a]) - h[a] - 1;
      hi[a] = Math.max(s[a], e[a]) + h[a] + 1;
    }
    const T = this.bvh.tris;
    const L = mask ? this.layers : null;
    if (h[0] === 0 && h[1] === 0 && h[2] === 0) {
      // a ray: the BVH walked along it and an exact triangle test (rayTriangle), not the box clip
      const d = this._d || (this._d = [0, 0, 0]);
      d[0] = e[0] - s[0]; d[1] = e[1] - s[1]; d[2] = e[2] - s[2];
      this.bvh.queryRay(s, d, () => tr.fraction, (t) => { if (!L || (L[t] & mask)) rayTriangle(T, t * 9, s, d, tr); });
    } else {
      this.bvh.query(lo, hi, L ? (t) => { if (L[t] & mask) clipTriangle(T, t * 9, h, s, e, tr); } : (t) => clipTriangle(T, t * 9, h, s, e, tr));
    }
    if (!worldOnly) clipSolids(this.dynamic, lo, hi, h, s, e, tr, mask);
    return traceEnd(tr, s, e);
  }

  // Ray (zero-size box) for picking / ground probes.
  traceRay(s, e, tr, worldOnly = false, mask = 0) {
    return this.traceBox(s, e, [0, 0, 0], tr, worldOnly, mask);
  }
}

// Does an AABB (centre c, half h) overlap a placed convex hull? Exact SAT: the box axes, the hull's face planes and,
// when the hull carries verts + edges (entity.hulls(), hulls.js hullEdges), each box axis x hull edge.
export function boxTouchesHull(c, h, hull) {
  const lo = hull.min, hi = hull.max;
  if (c[0] + h[0] < lo[0] || c[0] - h[0] > hi[0] || c[1] + h[1] < lo[1] || c[1] - h[1] > hi[1] || c[2] + h[2] < lo[2] || c[2] - h[2] > hi[2]) return false;
  const P = hull.planes;
  for (let i = 0; i < P.length; i += 4) {
    const nx = P[i], ny = P[i + 1], nz = P[i + 2];
    const r = Math.abs(nx) * h[0] + Math.abs(ny) * h[1] + Math.abs(nz) * h[2];
    if (nx * c[0] + ny * c[1] + nz * c[2] - r > P[i + 3]) return false;
  }
  // The rest of an exact convex overlap (separating axis theorem): each box axis crossed with each hull edge. Without
  // them a box near the edge of a hull turned on two axes "touched" it up to ~20 u outside (a tilted spinning blade).
  // The box's own axes are the bounds test above and the hull's faces the plane loop; touching surfaces still count.
  const E = hull.edges, V = hull.verts;
  if (!E || !V || !E.length) return true;
  for (let i = 0; i < E.length; i += 3) {
    const ex = E[i], ey = E[i + 1], ez = E[i + 2];
    for (let a = 0; a < 3; a++) {
      // edge x unit axis a
      let nx, ny, nz;
      if (a === 0) { nx = 0; ny = ez; nz = -ey; } else if (a === 1) { nx = -ez; ny = 0; nz = ex; } else { nx = ey; ny = -ex; nz = 0; }
      const L = Math.hypot(nx, ny, nz);
      if (L < 1e-6) continue; // edge along the axis: that axis is already a box face
      nx /= L; ny /= L; nz /= L;
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < V.length; k += 3) {
        const p = nx * V[k] + ny * V[k + 1] + nz * V[k + 2];
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
      const cc = nx * c[0] + ny * c[1] + nz * c[2], r = Math.abs(nx) * h[0] + Math.abs(ny) * h[1] + Math.abs(nz) * h[2];
      if (cc + r < lo || cc - r > hi) return false;
    }
  }
  return true;
}

// Ray (origin o, unit direction d) against a placed convex hull's planes: the distance it enters at (0 if it
// starts inside), or null for a miss. Up to 8192 u (CS2's bullet range). Bullets and the knife vs bosses.
export function rayHullEntry(o, d, h) {
  let tin = 0, tout = 8192;
  const P = h.planes;
  for (let i = 0; i < P.length; i += 4) {
    const dn = P[i] * d[0] + P[i + 1] * d[1] + P[i + 2] * d[2];
    const dist = P[i] * o[0] + P[i + 1] * o[1] + P[i + 2] * o[2] - P[i + 3];
    if (Math.abs(dn) < 1e-9) { if (dist > 0) return null; continue; }
    const t = -dist / dn;
    if (dn < 0) tin = Math.max(tin, t); else tout = Math.min(tout, t);
    if (tin > tout) return null;
  }
  return tin;
}
