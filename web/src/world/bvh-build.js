// A map's collision BVH, built in a worker (world/bvh-worker.js). A big map's tree is ~0.2-0.6 s of work on a
// desktop and several seconds on a phone; on the main thread that froze the page (and a tab close waited for it).
// Same tree as `new TriangleBVH(tris)`; built here instead when workers are missing or fail.
import { TriangleBVH } from './collision.js';

// tris: Float32Array, 9 floats per triangle (it stays here: the worker gets a copy). Never rejects.
export function buildBVH(tris) {
  if (typeof Worker === 'undefined' || !tris?.length) return Promise.resolve(new TriangleBVH(tris));
  return new Promise((resolve) => {
    let w;
    const done = (bvh) => { w?.terminate(); resolve(bvh); };
    try {
      w = new Worker(new URL('./bvh-worker.js', import.meta.url), { type: 'module' });
    } catch { done(new TriangleBVH(tris)); return; }
    w.onmessage = (ev) => {
      const p = ev.data;
      done(p?.idx instanceof Uint32Array && p.nodeB instanceof Float32Array && p.nodeI instanceof Uint32Array
        ? new TriangleBVH(tris, p) : new TriangleBVH(tris));
    };
    w.onerror = () => done(new TriangleBVH(tris));
    w.postMessage(tris);
  });
}
