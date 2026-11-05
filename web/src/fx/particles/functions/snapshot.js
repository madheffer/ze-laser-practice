// Control point snapshots, as particles.dll md5 63babcbf3245e56855a777134323e74a keeps them.
//
// A snapshot is a refcounted object (constructor 0x180020010, vtable 0x1804d29c0, 0xb70 bytes) created through
// ParticleSystemMgr003 (interface 0x18065ade0, vtable 0x1804d7fe0) slot +0x148 (0x1800206a0) and filled by slot
// +0x150 (0x180020820 -> snapshot vtable +8, 0x1800a64c0). It holds a particle count (+0x9e0) and one stream per
// attribute it carries: +0x9e8 + 4*attr is the stream index (-1 = absent), +0x128 + 4*index the stream's data type
// (the attribute type table DAT_18065a420, read by mgr slot +0x120 0x1800b2460: float, vector or int), +0x28 + 8*index
// the data and +0x3a8 + 8*index its stride (vectors in SIMD blocks of 4 there; plain arrays here).
// The fill call takes a fixed descriptor of stream pointers; 0x1800a64c0 maps descriptor slot -> attribute:
//   0 -> 0 position, 1 -> 2 previous position, 2 -> 21 normal, 3 -> 6 colour, 4 -> 41, 5 -> 42, 6 -> 43, 8 -> 17,
//   9 -> 30, 10 -> 3 radius, 11 -> 34, 12 -> 7 alpha, 13 -> 16 alpha 2, 14 -> 18 scratch, 15 -> 26, 16 -> 27,
//   17 -> 8 creation time, 18 -> 1 lifetime, 19 -> 23, 20 -> 9 sequence, 21 -> 44, 22 -> 14, 23 -> 47, 7 -> 15.
// A control point holds one snapshot at cp+0x78. SetControlPointSnapshot (0x180036770) swaps the reference, sets
// cp+0x90 |= 0x80, raises coll+0x944 (the highest CP index in use) and recurses into every child collection.
import { VECTOR_ATTRS, INT_ATTRS, newControlPoint, report } from './common.js';

// The value type of an attribute (DAT_18065a420): 1 vector, 2 int, 0 float.
export const attrType = (a) => (VECTOR_ATTRS.has(a) ? 1 : INT_ATTRS.has(a) ? 2 : 0);

// A snapshot of `count` particles; `streams` maps attribute -> array (3 floats per particle for vector attributes).
export const makeSnapshot = (count, streams) => {
  const attrs = new Map();
  for (const [a, data] of Object.entries(streams)) {
    const k = +a, n = attrType(k) === 1 ? 3 * count : count;
    const out = attrType(k) === 2 ? new Int32Array(n) : new Float32Array(n);
    for (let j = 0, m = Math.min(n, data.length); j < m; j++) out[j] = data[j];
    attrs.set(k, out);
  }
  return { count: count | 0, attrs };
};

// The stream an attribute reads from, or null when the snapshot lacks it or its type differs from `asType`
// (the check of 0x18015b480: stream index != -1 and type == the written attribute's type).
export const snapshotStream = (snap, attr, asType = attrType(attr)) => {
  if (!snap || !snap.count) return null;
  const s = snap.attrs.get(attr);
  return s && attrType(attr) === asType ? s : null;
};

const eachDown = (coll, f) => { f(coll); for (const k of coll.children) eachDown(k, f); };

// SetControlPointSnapshot (0x180036770): the point's snapshot, its children's too.
export const setCpSnapshot = (coll, i, snap) => {
  if (!(i >= 0 && i < 64)) return;
  eachDown(coll, (c) => {
    const cp = (c.controlPoints[i] ||= newControlPoint());
    // non-enumerable: system.js clones control points with a plain deep copy when it builds children
    Object.defineProperty(cp, 'snapshot', { value: snap, writable: true, configurable: true, enumerable: false });
    c.maxCp = Math.max(c.maxCp ?? 0, i);
  });
};

// The snapshot a CP holds. A definition's own m_hSnapshot (a .vsnap asset bound to its m_nSnapshotControlPoint)
// comes from opts.snapshots(path) -> { count, streams } when the stage provides one; the bake does not write .vsnap
// files, so without it the point has no snapshot (reported). UNSETTLED: where the DLL binds the asset (taken as
// collection creation, inherited by children like SetControlPointSnapshot).
export const cpSnapshot = (coll, i) => {
  const cp = coll.controlPoints[i];
  if (cp && cp.snapshot) return cp.snapshot;
  for (let a = coll; a; a = a.parent) {
    const d = a.def;
    if (!d || !d.m_hSnapshot || (d.m_nSnapshotControlPoint | 0) !== i) continue;
    const st = (a._assetSnapshot ||= { loaded: false, snap: null });
    if (!st.loaded) {
      st.loaded = true;
      const got = a.sys.opts.snapshots ? a.sys.opts.snapshots(String(d.m_hSnapshot)) : null;
      if (got && got.count > 0 && got.streams) st.snap = makeSnapshot(got.count, got.streams);
      else report(a, `snapshot asset ${d.m_hSnapshot} is not baked (no opts.snapshots): CP ${i} has no snapshot`);
    }
    if (st.snap) return st.snap;
  }
  return null;
};
