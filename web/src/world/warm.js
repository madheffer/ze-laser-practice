// What a map spawns mid-stage (its point_template lumps: lasers, bosses, cubes), made ready in the background once a
// stage runs, so its first spawn doesn't stall the game: a model fetched and parsed, its probe-lit materials made,
// their shaders compiled and their textures uploaded, a trigger's hull meshes. Readiness (app/readiness.js) only
// prepares what exists at the start; without this the first spawn of each template did all of that inside one frame
// (deadcore's cube arena: 100-200 ms on a fresh browser). The live spawn then reuses every piece: getModel's cache,
// lighting's probe materials (per material and volume), three's program cache, the uploaded textures, render.js
// hullGeometries.
//
// Particle effects are not warmed: their spawn is already asynchronous (the systems are fetched first, so a new
// effect shows a few frames late rather than holding a frame), and warm instances kept alive for their programs
// brought ~1 s stalls on every later spawn of mist's 3.5 s laser cycle (2026-11-06, cause not found).
//
// One piece per idle moment, nearest the player first, at most MAX_MODELS models (westersand's templates name ~400:
// the stage's own area matters, not the whole map), and it stops as soon as the run does.
import * as THREE from 'three';
import { GLTF_TO_SOURCE } from './assets.js';
import { cloneModel } from './anim.js';
import { applySelfIllum } from './selfillum.js';
import { parseVec, isParticleSystem } from './entities/index.js';
import { spawnsHidden } from './entities/render-mode.js';
import { texturesOf } from './gpu-upload.js';

const MAX_MODELS = 80;
const IDLE_TIMEOUT_MS = 250;

const idle = () => new Promise((resolve) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(resolve, 30);
});

// [{ kind: 'model' | 'hull', name, origin }] for every entity in a template lump that render.js draws, placed at its
// template (origin only: it picks the nearest first and the probe volume)
export function templateAssets(engine) {
  const tplOrigin = new Map();
  for (const ds of Object.values(engine.lumps)) for (const d of ds) {
    if (String(d.kv.classname).toLowerCase() === 'point_template' && d.kv.entitylumpname) {
      const k = engine.lumpKeys.get(String(d.kv.entitylumpname).toLowerCase());
      if (k && !tplOrigin.has(k)) tplOrigin.set(k, parseVec(d.kv.origin));
    }
  }
  const out = [], seen = new Set();
  for (const lump of engine.templateLumps) {
    const base = tplOrigin.get(lump) || [0, 0, 0];
    for (const d of engine.lumps[lump] || []) {
      const kv = d.kv, cls = String(kv.classname || '').toLowerCase();
      if (!kv.model) continue;
      let kind;
      if (cls === 'trigger_hurt') kind = 'hull';
      else if (cls.startsWith('trigger_') || isParticleSystem(cls)) continue;
      // render.js addEntity draws nothing for these
      else if (spawnsHidden(kv, engine.renderMigrated)) continue;
      else kind = 'model';
      const name = String(kv.model);
      if (seen.has(kind + name)) continue;
      seen.add(kind + name);
      const o = parseVec(kv.origin);
      out.push({ kind, name, origin: [base[0] + o[0], base[1] + o[1], base[2] + o[2]] });
    }
  }
  return out;
}

// Warm `run`'s map in the background. renderer: world/render.js; isCurrent() false once the run is over.
export async function warmTemplates({ renderer, map, engine, origin, isCurrent }) {
  const gl = renderer.renderer;
  const d2 = (o) => (o[0] - origin[0]) ** 2 + (o[1] - origin[1]) ** 2 + (o[2] - origin[2]) ** 2;
  const items = templateAssets(engine).sort((a, b) => d2(a.origin) - d2(b.origin));
  // what this map has warmed: each stage warms its own nearest, skipping what an earlier stage did
  const done = map.warmDone || (map.warmDone = new Set());
  const uploaded = new Set();
  let models = 0;
  for (const it of items) {
    const key = it.kind + ':' + it.name;
    if (done.has(key) || (it.kind === 'model' && models >= MAX_MODELS)) continue;
    await idle();
    if (!isCurrent()) return;
    done.add(key);
    try {
      if (it.kind === 'hull') { renderer.hullGeometries(it.name, map); continue; }
      models++;
      const src = await map.getModel(it.name);
      if (!src || !isCurrent()) continue;
      // built as render.js addEntity builds an entity's model, so the probe materials it makes are the ones reused
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      group.matrix.makeTranslation(it.origin[0], it.origin[1], it.origin[2]);
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(GLTF_TO_SOURCE);
      holder.add(cloneModel(src));
      group.add(holder);
      group.updateMatrixWorld(true);
      group.traverse((o) => { if (o.isMesh) { applySelfIllum(o, renderer.selfIllum); renderer.lighting?.applyProbes(o); } });
      // shaders off the main thread where the browser can (KHR_parallel_shader_compile), then textures one per idle
      await renderer.compileAsync(group); // into the HDR target, as it is drawn (render.js compileAsync)
      const tex = new Set();
      group.traverse((o) => { if (o.material) texturesOf(o.material, tex); });
      for (const t of tex) {
        if (uploaded.has(t) || !t.image) continue;
        uploaded.add(t);
        await idle();
        if (!isCurrent()) return;
        gl.initTexture(t);
      }
    } catch (e) {
      console.warn('warm-up:', it.name, e);
    }
  }
}
