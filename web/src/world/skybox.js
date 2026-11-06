// The 3D skybox (bake/SkyboxBake.cs: maps/<map>/skybox.json). A CS2 map's skybox_reference loads a second world into
// the same entity system, so the main map's I/O reaches its entities by name (ze_rush_b's relays Enable the Matrix
// tube in it and step its skins). Its sky_camera draws it behind everything: a skybox point P is seen from
// skyOrigin + eye / scale, which puts it on the main world at scale * (P - skyOrigin) whatever the eye.
//
// Here its lumps join the map's entities as "skybox/<world>/<lump>" (after the main lumps, so the main world's
// entities keep their order) with entities.skybox = { lump: { origin, scale } }; the engine marks their entities
// e.sky (never solid, never touching: entities/engine.js) and the renderer draws them through skyMatrix().
// Untrusted: only plain world names, lumps as arrays, numbers checked (the engine checks them again).
import * as THREE from 'three';
import { isMapName } from '../lib/paths.js';

const MAX_WORLDS = 4;

export function mergeSkybox(entities, json) {
  if (!entities?.lumps || !Array.isArray(json?.worlds)) return 0;
  const sky = {};
  let n = 0;
  for (const w of json.worlds.slice(0, MAX_WORLDS)) {
    const name = String(w?.map ?? '');
    const cam = w?.camera;
    if (!isMapName(name) || !cam || !w.lumps || typeof w.lumps !== 'object') continue;
    const origin = Array.isArray(cam.origin) ? cam.origin.map(Number) : [];
    const scale = Number(cam.scale);
    if (origin.length !== 3 || !origin.every(Number.isFinite) || !(scale > 0)) continue;
    for (const [lump, list] of Object.entries(w.lumps)) {
      if (!Array.isArray(list)) continue;
      const key = `skybox/${name}/${lump}`;
      entities.lumps[key] = list;
      sky[key] = { origin, scale };
    }
    n++;
  }
  if (n) entities.skybox = sky;
  return n;
}

// the sky entity's world matrix on the main world: translate(-scale * origin) * scale(scale) * its own (cached per world)
const cache = new WeakMap();
export function skyMatrix(sky) {
  let m = cache.get(sky);
  if (!m) {
    const [x, y, z] = sky.origin, s = sky.scale;
    m = new THREE.Matrix4().makeScale(s, s, s).setPosition(-s * x, -s * y, -s * z);
    cache.set(sky, m);
  }
  return m;
}
