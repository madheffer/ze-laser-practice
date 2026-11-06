// Textures onto the GPU before anything draws with them. three.js uploads a texture the first time a mesh using it is
// drawn, inside that frame: turning to face a new part of the map, or a world chunk streaming in, then held the frame
// while its textures went up (mist: 30 of the 67 textures in view were still waiting when the stage started).
//
//   texturesOf(material, out)                 every texture a material (or an array of them) samples, into the set out
//   pendingTextures(renderer, root)           the textures under root (an Object3D) not on the GPU yet
//   uploadNow(renderer, root)                 all of them at once (behind the loading screen)
//   uploadSpread(renderer, root, alive, budget)  a few per frame while the game runs; alive() false stops it;
//                                             budget() the ms a frame may spend (default FRAME_BUDGET_MS)
//
// renderer: the THREE.WebGLRenderer.

// the most time a frame spends uploading while the game runs (at least one texture goes up per frame)
export const FRAME_BUDGET_MS = 3;
const FRAME_TIMEOUT_MS = 100; // a hidden tab gets no animation frames: it goes on without them

export function texturesOf(material, out) {
  for (const m of Array.isArray(material) ? material : [material]) {
    if (!m) continue;
    for (const v of Object.values(m)) if (v?.isTexture) out.add(v);
    // a shader material's samplers live in its uniforms (particles, water, the lightmapped world's own maps)
    if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u?.value?.isTexture) out.add(u.value);
  }
  return out;
}

// a texture three has put on the GPU (or can't yet: no image loaded, a render target's own texture)
function waiting(renderer, t) {
  if (t.isRenderTargetTexture || t.isDepthTexture) return false;
  const img = t.image;
  if (!img || (Array.isArray(img) ? !img.length : !(img.width > 0 || img.data))) return false;
  return !renderer.properties.get(t).__webglInit;
}

export function pendingTextures(renderer, root) {
  const all = new Set();
  root.traverse((o) => { if (o.material) texturesOf(o.material, all); });
  return [...all].filter((t) => waiting(renderer, t));
}

export function uploadNow(renderer, root) {
  for (const t of pendingTextures(renderer, root)) renderer.initTexture(t);
}

const nextFrame = () => new Promise((resolve) => {
  const t = setTimeout(resolve, FRAME_TIMEOUT_MS);
  requestAnimationFrame(() => { clearTimeout(t); resolve(); });
});

export async function uploadSpread(renderer, root, alive = () => true, budget = () => FRAME_BUDGET_MS) {
  const list = pendingTextures(renderer, root);
  let i = 0;
  while (i < list.length) {
    await nextFrame();
    if (!alive()) return;
    const start = performance.now();
    do {
      const t = list[i++];
      if (waiting(renderer, t)) renderer.initTexture(t);
    } while (i < list.length && performance.now() - start < budget());
  }
}
