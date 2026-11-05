// What every 3D view on the site shares: the previewer modules import it, and the classic viewers (model,
// glove, skin, transparency) load it through window.__moduleImport, so 'three' is one module instance.
// It imports nothing but three, which keeps it cheap for a page that only wants a renderer.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// VRF exports glTF at 0.0254 m per Source unit (GltfModelExporter SourceToGltfScale), and every clip
// constant, bone offset and convar is authored in those inches.
export const METRES_PER_INCH = 0.0254;
export const INCHES_PER_METRE = 1 / METRES_PER_INCH;

// Source's fov convars (fov 90, viewmodel_fov 68) are horizontal degrees at 4:3; a three camera's is vertical.
export const SOURCE_FOV_ASPECT = 4 / 3;
const DEG = Math.PI / 180;
export const vfovFromHfov = (hDeg, aspect) => 2 * Math.atan(Math.tan(hDeg * DEG / 2) / aspect) / DEG;
export const hfovFromVfov = (vDeg, aspect) => 2 * Math.atan(Math.tan(vDeg * DEG / 2) * aspect) / DEG;

// Where a CS2 glb's material slots glTF cannot carry (panning masks, tint mask, moondome cubemap) are served:
// the library's sibling mat-tex route (`endpoint`; an uploaded pack has none, so base is null), or a
// --export-model-mattex dir of <slot>.png beside a baked .glb. Null for any other url.
export function matTexBaseFor(url) {
  if (!url) return null;
  const route = (re) => { const m = url.match(re); return m ? { base: `${m[1]}/mat-tex`, endpoint: true } : null; };
  return route(/^(.*\/custom-weapons\/[^/?#]+)\/gltf(?:[?#]|$)/)
    ?? route(/^(.*\/contributed\/[^/?#]+)\/model-gltf(?:[?#]|$)/)
    ?? route(/^(.*\/models\/[0-9a-f-]{32,36})\/gltf(?:[?#]|$)/i)
    ?? (/\/pack\/model-gltf(?:[?#]|$)/.test(url) ? { base: null, endpoint: true } : null)
    ?? bakedMatTexDir(url);
}

function bakedMatTexDir(url) {
  const path = url.split(/[?#]/)[0];
  if (!/\.glb$/i.test(path)) return null;
  const slash = path.lastIndexOf('/');
  return { base: `${path.slice(0, slash)}/mat-tex/${path.slice(slash + 1, -4)}`, endpoint: false };
}

/// CS2Mat's texUrl(stem, slot) for a matTexBaseFor result, or null when there is nowhere to ask.
export function matTexUrl(cfg) {
  if (!cfg?.base) return null;
  const ext = cfg.endpoint ? '' : '.png';
  return (stem, slot) => (stem
    ? `${cfg.base}/${encodeURIComponent(stem)}/${encodeURIComponent(slot)}${ext}`
    : null);
}

/// A WebGLRenderer set up the way every viewer here starts: device pixel ratio capped, colour space and
/// tone mapping as given. `shaderChecks: false` silences ANGLE's X3557 loop-unroll warnings by the dozen.
export function createRenderer({ canvas, antialias = true, alpha = false, powerPreference = 'default',
                                 preserveDrawingBuffer = false, maxPixelRatio = 2,
                                 pixelRatio = Math.min(globalThis.devicePixelRatio || 1, maxPixelRatio),
                                 toneMapping = THREE.NoToneMapping, exposure = 1,
                                 outputColorSpace = THREE.SRGBColorSpace, shaderChecks = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias, alpha, powerPreference, preserveDrawingBuffer });
  renderer.debug.checkShaderErrors = shaderChecks;
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = outputColorSpace;
  renderer.toneMapping = toneMapping;
  renderer.toneMappingExposure = exposure;
  return renderer;
}

/// The neutral studio IBL: three's RoomEnvironment, PMREM-filtered. Returns the RENDER TARGET, because
/// rt.dispose() is the only full free; disposing its texture alone leaves the framebuffer behind.
export function studioEnv(renderer, blur = 0.04) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  try { return pmrem.fromScene(room, blur); } finally { room.dispose(); pmrem.dispose(); }
}

/// Draw only while something changes: `frame(now)` runs for a short window after bump(), or every frame
/// while animated() says so (at most every `idleInterval` ms), and never while the tab is hidden, the
/// host is scrolled away or laid out at zero size (a zero-area buffer floods GL_INVALID_FRAMEBUFFER errors).
export function onDemandLoop(host, frame, { animated = () => false, idleInterval = 0 } = {}) {
  let raf = 0, stopped = false, onScreen = true, last = 0;
  let activeUntil = performance.now() + 1200;
  const bump = () => { activeUntil = Math.max(activeUntil, performance.now() + 700); };
  const io = typeof IntersectionObserver === 'undefined' ? null
    : new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; if (onScreen) bump(); }, { threshold: 0 });
  io?.observe(host);
  const tick = (now) => {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (document.hidden || !onScreen || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    const interacting = now < activeUntil;
    if (!interacting && (!animated() || now - last < idleInterval)) return;
    last = now;
    frame(now);
  };
  raf = requestAnimationFrame(tick);
  return { bump, stop() { stopped = true; cancelAnimationFrame(raf); io?.disconnect(); } };
}

/// Free a renderer, and its WebGL context once the canvas has left the page: browsers keep ~16 live contexts
/// and evict the oldest, and GC is slow to hand one back. A canvas still in the page keeps its context, as its
/// owner may mount a new renderer on it and a lost context can never be re-acquired from the same element.
export function releaseRenderer(renderer) {
  if (!renderer) return;
  try { renderer.dispose(); } catch { /* already gone */ }
  try { if (!renderer.domElement?.isConnected) renderer.forceContextLoss(); } catch { /* no WEBGL_lose_context */ }
}

const cacheOwned = new WeakSet();
/// Mark a texture, material or geometry as owned by a cache that frees it on eviction, so tearing down
/// whatever subtree has it bound (an arm wearing a cached glove paint) leaves it alone.
export function ownedByCache(resource) {
  if (resource) cacheOwned.add(resource);
  return resource;
}

/// Every geometry, material and material texture under `roots`, for disposeObject's `keep`.
export function resourcesOf(...roots) {
  const out = new Set();
  for (const root of roots) {
    root?.traverse((o) => {
      if (o.geometry) out.add(o.geometry);
      for (const m of [].concat(o.material || [])) {
        if (!m) continue;
        out.add(m);
        for (const k in m) if (m[k]?.isTexture) out.add(m[k]);
      }
    });
  }
  return out;
}

/// Free what a subtree holds on the GPU: geometries, materials, the textures a material holds, and bone
/// textures. `keep` spares what another live subtree still draws; `shared` frees only each clone's skeleton,
/// for SkeletonUtils clones whose geometry and materials stay with their template.
export function disposeObject(root, { keep = null, shared = false } = {}) {
  if (!root) return;
  const spare = (r) => !r || cacheOwned.has(r) || !!keep?.has(r);
  root.traverse((o) => {
    if (o.isSkinnedMesh) o.skeleton?.dispose();
    if (shared) return;
    if (o.geometry && !spare(o.geometry)) o.geometry.dispose();
    for (const m of [].concat(o.material || [])) {
      if (spare(m)) continue;
      for (const k in m) if (m[k]?.isTexture && !spare(m[k])) m[k].dispose();
      m.dispose();
    }
  });
}

/// A Map holding the `cap` most recently used entries; older ones go to `evict(value, key)`, except any
/// `pinned(key)` says is still on screen.
export function lruCache(cap, evict, pinned = () => false) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key); map.set(key, v);
      return v;
    },
    has: (key) => map.has(key),
    set(key, value) {
      map.delete(key); map.set(key, value);
      for (const [k, v] of map) {
        if (map.size <= cap) break;
        if (k === key || pinned(k)) continue;
        map.delete(k);
        evict(v, k);
      }
    },
    clear() { for (const [k, v] of map) evict(v, k); map.clear(); },
  };
}
