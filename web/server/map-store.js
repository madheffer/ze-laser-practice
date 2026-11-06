// The baked maps the co-op server's checker simulates (the same files the game loads: web/public/maps/<map>/).
// Loaded once per map and shared by every player check of every round on it: the entity data is read-only to the
// engine (each entity copies its keyvalues), and the static collision BVH is shared (each check has its own
// CollisionWorld for the moving brushes). A few maps stay cached; the least recently used one is dropped.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMapName } from '../src/lib/paths.js';
import { applyStripper } from '../src/lib/stripper.js';
import { normaliseHulls } from '../src/world/hulls.js';
import { TriangleBVH } from '../src/world/collision.js';
import { mapItems } from '../src/world/items.js';
import { soundDurations } from '../src/lib/sound-durations.js';
import { loadPhysics } from '../src/world/physics-world.js';

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
      const [entities, hullsRaw, col, entwatch, animations, fxCol, fxLayers, stripper, soundevents, physicsBin, physicsOk] = await Promise.all([
        readFile(path.join(folder, 'entities.json'), 'utf8').then(JSON.parse),
        readFile(path.join(folder, 'hulls.json'), 'utf8').then(JSON.parse).catch(() => ({})),
        readFile(path.join(folder, 'collision.bin')),
        readFile(path.join(folder, 'entwatch.json'), 'utf8').then(JSON.parse).catch(() => null), // optional
        // prop_dynamic sequence lengths, for OnAnimationDone (lasers-bake --models; optional)
        readFile(path.join(folder, 'animations.json'), 'utf8').then(JSON.parse).catch(() => null),
        // the static world with layer bits (lasers-bake collision_fx*.bin; optional): what bullets see (world/bullets.js)
        readFile(path.join(folder, 'collision_fx.bin')).catch(() => null),
        readFile(path.join(folder, 'collision_fx_layers.bin')).catch(() => null),
        // GFL's StripperCS2 edits to the map (tools/stripper.mjs; optional)
        readFile(path.join(folder, 'stripper.json'), 'utf8').then(JSON.parse).catch(() => null),
        // the sound events' lengths: point_soundevent's OnSoundFinished times by them, as on the clients (optional)
        readFile(path.join(folder, 'soundevents.json'), 'utf8').then(JSON.parse).catch(() => null),
        // CS2's physics, as the clients run it (world/physics-world.js): the map's physics.bin (optional) and the
        // runtime the browser gets from /rubikon/_framework, loaded from the same files once per process
        readFile(path.join(folder, 'physics.bin')).catch(() => null),
        loadPhysics(pathToFileURL(path.join(dir, '..', 'rubikon', '_framework', 'dotnet.js')).href),
      ]);
      // the same edits the client applies (world/assets.js): the anti-cheat's copy of the map must be the player's
      applyStripper(entities, stripper, map);
      const { hulls, bounds } = normaliseHulls(hullsRaw);
      const tris = new Float32Array(col.buffer.slice(col.byteOffset, col.byteOffset + col.byteLength));
      const fx = fxCol && fxLayers && fxCol.byteLength === fxLayers.byteLength * 9
        ? { bvh: new TriangleBVH(new Float32Array(fxCol.buffer.slice(fxCol.byteOffset, fxCol.byteOffset + fxCol.byteLength))),
            layers: new Uint32Array(fxLayers.buffer.slice(fxLayers.byteOffset, fxLayers.byteOffset + fxLayers.byteLength)) }
        : null;
      // the map's EntWatch items, as the browser reads them (world/items.js): a round's holders get theirs
      const physics = physicsOk && physicsBin ? physicsBin.buffer.slice(physicsBin.byteOffset, physicsBin.byteOffset + physicsBin.byteLength) : null;
      return { map, entities, hulls, bounds, animations, soundDurations: soundDurations(soundevents), bvh: new TriangleBVH(tris), fx, physics, items: mapItems(entities, entwatch) };
    })();
    p.catch(() => cache.delete(map));
    cache.set(map, p);
    while (cache.size > KEEP) cache.delete(cache.keys().next().value);
    return p;
  };
}
