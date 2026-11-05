// The world as CS2's bullets see it. A bullet's trace (CCSPlayer FireBullet, FUN_180a71600 in server.dll 2026-09-23,
// called from FX_FireBullets FUN_180298330) builds its CTraceFilter with interacts-with 0x1c300b (at 0x180a71821):
// layers solid, hitboxes, sky, window, passbullets, player, npc, debris (CS2Fixes sdk/public/const.h layer indices).
// Player clips (layer 4) are not in it: they never stop a bullet.
//
// The static world with layer bits is lasers-bake's particle collision set (collision_fx.bin + collision_fx_layers.bin:
// every shape on a layer in 0x1db001). UNSETTLED: shapes only on hitboxes / sky (bits 1, 3) aren't in that set, so a
// sky brush doesn't stop a bullet here. Without the set (an older bake) the player-solid world stands in.
//
//   bulletWorld(fx, fallback) -> a CollisionWorld (built once per map and kept on fx: fx/trace.js shares it)
//   world.traceRay(eye, end, tr, true, BULLET_MASK)
import { CollisionWorld, TriangleBVH } from './collision.js';

export const BULLET_MASK = 0x1c300b;

// fx: { tris, layers } (the browser's collisionFx) or { bvh, layers } (the server's map-store); fallback: the
// player-solid CollisionWorld
export function bulletWorld(fx, fallback = null) {
  if (!fx?.layers || !(fx.tris || fx.bvh)) return fallback;
  if (!fx.world) fx.world = new CollisionWorld(fx.bvh instanceof TriangleBVH ? fx.bvh : fx.tris, fx.layers);
  return fx.world;
}
