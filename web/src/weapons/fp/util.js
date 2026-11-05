import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { INCHES_PER_METRE } from './three-kit.js';

// The CS2 paint-kit weapon glbs (/skins/models/weapon_*.glb) are meshopt-compressed; without the decoder the
// loader throws and the weapon path reports a model that failed to load.
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
// `onProgress` gets a 0..1 fraction (null when the server sends no length) plus the byte counts, so a caller
// summing several loads weights a 130 KB clip and a 6 MB model correctly.
export const loadGltf = (url, onProgress) => new Promise((res, rej) => loader.load(
  url, res,
  onProgress ? (e) => {
    const total = e && e.total > 0 ? e.total : 0;
    onProgress(total ? e.loaded / total : null, e ? e.loaded || 0 : 0, total);
  } : undefined,
  rej));

// Join an asset root to a path unless it is already absolute: prefixing "/library/models/<id>/gltf" gives
// "/tp//library/...", which the SPA fallback answers with index.html ("Unexpected token '<'", not a 404).
export const assetUrl = (base, rel) => (rel && rel.startsWith('/')) ? rel : (base || '') + rel;

// The glb's ROOT extras. three.js hands a node's extras to userData but not the
// document's own, so read them off the parsed json the loader keeps.
export const rootExtras = gltf => gltf?.parser?.json?.extras || {};

export const indexByName = root => {
  const m = new Map();
  root.traverse(o => { if (o.name && !m.has(o.name)) m.set(o.name, o); });
  return m;
};

// VRF exports glTF in metres with a cyclic axis rotation; this wrapper restores raw Source space (inches, z-up),
// where every CS2 clip constant and bone offset is authored, so pose JSON drives bone locals directly.
export const SOURCE_QUAT = new THREE.Quaternion(-0.5, -0.5, -0.5, -0.5);
export function unwrapToSourceSpace(scene) {
  const g = new THREE.Group();
  g.quaternion.copy(SOURCE_QUAT);
  g.scale.setScalar(INCHES_PER_METRE);
  g.add(scene);
  return g;
}

// A vmdl-baked GLB carries every mesh group, so the worldmodel z-fights inside the viewmodel: keep first-person
// only and drop exact (name, vertex-count) duplicates referenced by two groups.
export function dedupeMeshes(root) {
  const seen = new Set();
  root.traverse(o => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    // Do NOT force DoubleSide: glTF doubleSided IS the vmat's F_RENDER_BACKFACES (VRF), and Source 2 culls backfaces.
    // Inverted-hull glow shells (Exg neon knives) must render backfaces only, or the whole weapon paints as glow.
    const nm = (o.name || '').toLowerCase();
    if (nm.includes('worldmodel') || nm.includes('thirdperson')) { o.visible = false; return; }
    const key = o.name + ':' + (o.geometry?.attributes?.position?.count ?? 0);
    if (seen.has(key)) o.visible = false; else seen.add(key);
  });
}

import { chainBeforeCompile } from '../../lib/shader.js';
export { chainBeforeCompile };

export function prepareSkinnedMesh(mesh, hiUniforms, meshBoneIndex, opts = {}) {
  meshBoneIndex.set(mesh, new Map(mesh.skeleton.bones.map((b, i) => [b.name, i])));
  const flat = opts.flatten !== false;
  const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(m => {
    const c = m.clone();
    if (flat) {
      // The tuning job is about SHAPE. Spec highlights and normal-map detail
      // read as geometry and hide the thing being judged, so flatten them.
      c.metalness = 0; c.roughness = 1;
      c.metalnessMap = null; c.roughnessMap = null; c.normalMap = null;
    }
    const u = { uHiBone: { value: -1 }, uHiAmt: { value: 0.5 } };
    chainBeforeCompile(c, (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uHiBone;\nvarying float vHi;')
        .replace('#include <skinning_vertex>', `#include <skinning_vertex>
  vHi = 0.0;
  if (uHiBone >= 0.0) {
    vHi = skinWeight.x * step(abs(skinIndex.x - uHiBone), 0.1)
        + skinWeight.y * step(abs(skinIndex.y - uHiBone), 0.1)
        + skinWeight.z * step(abs(skinIndex.z - uHiBone), 0.1)
        + skinWeight.w * step(abs(skinIndex.w - uHiBone), 0.1);
  }`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uHiAmt;\nvarying float vHi;')
        .replace('#include <dithering_fragment>', 'gl_FragColor.rgb += vHi * uHiAmt * vec3(0.25, 0.45, 1.0);\n#include <dithering_fragment>');
    }, 'bonehi');
    c.needsUpdate = true;
    hiUniforms.push({ mesh, u });
    return c;
  });
  mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
}

export function sanitizeMats(scene) {
  scene.traverse(o => {
    if (!o.isMesh || !o.material) return;
    // A mesh the CS2 material system has already tuned is authoritative - it
    // was built from that material's real vmat. Flattening it back to a generic
    // metal/rough guess is exactly the fidelity this is meant to keep.
    if (o.userData._cs2) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      m.metalness = 0; m.roughness = 0.85;
      m.metalnessMap = null; m.roughnessMap = null;
      m.needsUpdate = true;
    }
  });
}

// Linear-interpolate a [t,x,y,z] key track. Clip keys are sorted, short and
// sampled every frame, so a linear scan beats anything cleverer.
export function sampleVec(keys, t, out) {
  if (!keys || !keys.length) return false;
  if (keys.length === 1 || t <= keys[0][0]) { out.set(keys[0][1], keys[0][2], keys[0][3]); return true; }
  const last = keys[keys.length - 1];
  if (t >= last[0]) { out.set(last[1], last[2], last[3]); return true; }
  for (let i = 1; i < keys.length; i++) {
    if (t > keys[i][0]) continue;
    const a = keys[i - 1], b = keys[i];
    const f = (t - a[0]) / Math.max(b[0] - a[0], 1e-9);
    out.set(a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f);
    return true;
  }
  return false;
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
export function sampleQuat(keys, t, out) {
  if (!keys || !keys.length) return false;
  if (keys.length === 1 || t <= keys[0][0]) { out.set(keys[0][1], keys[0][2], keys[0][3], keys[0][4]); return true; }
  const last = keys[keys.length - 1];
  if (t >= last[0]) { out.set(last[1], last[2], last[3], last[4]); return true; }
  for (let i = 1; i < keys.length; i++) {
    if (t > keys[i][0]) continue;
    const a = keys[i - 1], b = keys[i];
    const f = (t - a[0]) / Math.max(b[0] - a[0], 1e-9);
    _qa.set(a[1], a[2], a[3], a[4]); _qb.set(b[1], b[2], b[3], b[4]);
    out.copy(_qa).slerp(_qb, f);
    return true;
  }
  return false;
}

// CS2 materials: our guarded exporter carries the whole vmat on every material (extras.vmat), and window.CS2Mat
// (the site's own module, loaded not copied) turns it back into Source 2 shading; without it EXG glow parts sit
// dark and still. Controllers are collected so the render loop drives them with one call.
const cs2Controllers = new Set();

export function upgradeCs2Materials(THREE, root, opts = {}) {
  const api = globalThis.CS2Mat;
  if (!api || !root) return null;
  let ctl = null;
  try {
    // emissiveCap 6, not the model viewer's 1.35: 78% of the corpus authors selfillum 2..5 for the game's
    // bloom, so 1.35 rendered them dark, while the full range nukes detail. At 6 the hottest (2^5.1 = 35) glow
    // pale as their thumbnails show and everything below stays exact.
    ctl = api.upgrade(THREE, root, { emissiveCap: 6, ...opts });
  } catch (e) {
    console.warn('[previewer] CS2 material upgrade failed', e);
    return null;
  }
  if (ctl) cs2Controllers.add(ctl);
  return ctl;
}

/// The other half of upgradeCs2Materials, for a root leaving the scene: unreleased, the frame loop ticks
/// every controller ever made, each holding its whole material set (and window.__cs2Root) alive.
export function releaseCs2(ctl) {
  if (!ctl) return;
  cs2Controllers.delete(ctl);
  try { ctl.dispose(); } catch { /* already gone */ }
}

// `ent` carries CS2's per-entity material variables: 187 dynamic expressions across 34 library weapons read
// $ent_ammo (magazine counters, charge bars), so this pushes them each tick or they freeze at the seeded 30.
export function tickCs2Materials(t, ent) {
  for (const c of cs2Controllers) {
    try {
      if (ent) c.setEnt(ent);
      c.update(t);
    } catch { /* one bad material must not stop the frame */ }
  }
}

export function cs2MaterialStats() {
  let materials = 0, animated = 0;
  for (const c of cs2Controllers) { materials += c.materialCount || 0; if (c.animated) animated++; }
  return { controllers: cs2Controllers.size, materials, animated };
}
