// The baked maps the co-op server's checker simulates (the same files the game loads: web/public/maps/<map>/).
// Loaded once per map and shared by every player check of every round on it: the entity data is read-only to the
// engine (each entity copies its keyvalues), and the static collision BVH is shared (each check has its own
// CollisionWorld for the moving brushes). A few maps stay cached; the least recently used one is dropped.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isMapName } from '../src/lib/paths.js';
import { normaliseHulls } from '../src/world/hulls.js';
import { TriangleBVH } from '../src/world/collision.js';
import { mapItems, usableHeals } from '../src/world/items.js';

const KEEP = 3;

export function mapStore(dir) {
  const cache = new Map(); // map -> Promise<assets>
  return function load(map) {
    if (!isMapName(map)) return Promise.reject(new Error('bad map name'));
    if (cache.has(map)) {
      const p = cache.get(map);
      cache.delete(map); cache.set(map, p); // most recent last
      return p;
    }
    const folder = path.join(dir, map); // [a-z0-9_-] only: never leaves dir
    const p = (async () => {
      const [entities, hullsRaw, col, entwatch, animations, fxCol, fxLayers] = await Promise.all([
        readFile(path.join(folder, 'entities.json'), 'utf8').then(JSON.parse),
        readFile(path.join(folder, 'hulls.json'), 'utf8').then(JSON.parse).catch(() => ({})),
        readFile(path.join(folder, 'collision.bin')),
        readFile(path.join(folder, 'entwatch.json'), 'utf8').then(JSON.parse).catch(() => null), // optional
        // prop_dynamic sequence lengths, for OnAnimationDone (lasers-bake --models; optional)
        readFile(path.join(folder, 'animations.json'), 'utf8').then(JSON.parse).catch(() => null),
        // the static world with layer bits (lasers-bake collision_fx*.bin; optional): what bullets see (world/bullets.js)
        readFile(path.join(folder, 'collision_fx.bin')).catch(() => null),
        readFile(path.join(folder, 'collision_fx_layers.bin')).catch(() => null),
      ]);
      const { hulls, bounds } = normaliseHulls(hullsRaw);
      const tris = new Float32Array(col.buffer.slice(col.byteOffset, col.byteOffset + col.byteLength));
      const fx = fxCol && fxLayers && fxCol.byteLength === fxLayers.byteLength * 9
        ? { bvh: new TriangleBVH(new Float32Array(fxCol.buffer.slice(fxCol.byteOffset, fxCol.byteOffset + fxCol.byteLength))),
            layers: new Uint32Array(fxLayers.buffer.slice(fxLayers.byteOffset, fxLayers.byteOffset + fxLayers.byteLength)) }
        : null;
      // the map's EntWatch items, as the browser reads them (world/items.js): a round's heal holders get its heals
      return { map, entities, hulls, bounds, animations, bvh: new TriangleBVH(tris), fx, heals: usableHeals(mapItems(entities, entwatch)) };
    })();
    p.catch(() => cache.delete(map));
    cache.set(map, p);
    while (cache.size > KEEP) cache.delete(cache.keys().next().value);
    return p;
  };
}
