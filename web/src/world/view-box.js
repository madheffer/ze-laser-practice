// A stage's view box (scenario.view: { min: [x, y, z], max: [x, y, z] }, Source units): what of the map it draws.
// A boss fought on one floating platform (westersand's Chaos) only needs that platform; the rest of the map is
// hundreds of thousands of triangles drawn for nothing. Rendering only: collision, hulls and entities stay whole,
// so the stage plays the same. Outside the box: world chunks are not streamed, world meshes and entity models are
// hidden (particles and the sky stay).
import * as THREE from 'three';

// scenario.view -> a THREE.Box3 in Source units, or null (none, or malformed: scenarios are untrusted data)
export function viewBox(scenario) {
  const v = scenario?.view;
  const ok = (a) => Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === 'number' && Number.isFinite(n));
  if (!v || !ok(v.min) || !ok(v.max) || v.min.some((n, k) => n > v.max[k])) return null;
  return new THREE.Box3(new THREE.Vector3(...v.min), new THREE.Vector3(...v.max));
}

// does a box given as min / max arrays (a chunks.json entry) reach into the view box? Always, without one.
export function inView(box, min, max) {
  if (!box) return true;
  return min[0] <= box.max.x && max[0] >= box.min.x && min[1] <= box.max.y && max[1] >= box.min.y
    && min[2] <= box.max.z && max[2] >= box.min.z;
}

const _b = new THREE.Box3();

// does a box in an object's own space, placed by `matrix` (into Source units), reach into the view box?
// An empty box (nothing loaded yet) counts as in: it is decided again once there is something to draw.
export function boxInView(box, local, matrix) {
  if (!box || local.isEmpty()) return true;
  return _b.copy(local).applyMatrix4(matrix).intersectsBox(box);
}
