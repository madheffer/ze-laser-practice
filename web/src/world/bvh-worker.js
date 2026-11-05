// Builds a TriangleBVH off the page's main thread (world/bvh-build.js): gets the triangles, sends back the tree.
import { TriangleBVH } from './collision.js';

self.onmessage = (ev) => {
  const b = new TriangleBVH(ev.data);
  self.postMessage({ idx: b.idx, nodeB: b.nodeB, nodeI: b.nodeI }, [b.idx.buffer, b.nodeB.buffer, b.nodeI.buffer]);
};
