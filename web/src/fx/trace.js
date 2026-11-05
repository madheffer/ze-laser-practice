// The world trace particle functions call (ParticleSystem opts.trace): the map's collision (world/collision.js).
//
//   trace(from, dir, length, query?) -> { hit, position, normal, fraction, startSolid }
//
// Interaction layers: a particle trace hits only shapes that interact as one of query.contents' layers (CS2's
// layer bits, CS2Fixes const.h: 0 solid, 3 sky, 4 playerclip, 12 window, 13 passbullets, 15 water, ...). The functions
// pass the mask their particles.dll code uses; without one, 0x1c3001 (C_INIT_PositionPlaceOnGround's, no water).
// So player clips and sky never stop particles. The static world comes from lasers-bake's collision_fx*.bin (every
// shape with its layer bits); moving brush entities are the movement world's, tested by the layers hulls.json gives.
// query.traceSet PARTICLE_TRACE_SET_STATIC traces the static world only; the other sets also hit the moving brushes.
// UNSETTLED: an older bake without collision_fx*.bin falls back to the player-solid collision.bin (player clips hit).
// Players and props are not in the collision world, so no trace hits them.
import { CollisionWorld, makeTrace } from '../world/collision.js';

const DEFAULT_CONTENTS = 0x1c3001;

// world: the movement CollisionWorld (its .dynamic is refreshed each tick); fx: { tris, layers } or null
export function particleTrace(world, fx = null) {
  const fxWorld = fx ? new CollisionWorld(fx.tris, fx.layers) : null;
  const tr = makeTrace();
  const e = [0, 0, 0];
  return (from, dir, length, query) => {
    if (!(length > 0)) return { hit: false, position: from.slice(), normal: [0, 0, 0], fraction: 1, startSolid: false };
    for (let a = 0; a < 3; a++) e[a] = from[a] + dir[a] * length;
    const staticOnly = query?.traceSet === 'PARTICLE_TRACE_SET_STATIC';
    if (fxWorld) {
      fxWorld.dynamic = world.dynamic;
      fxWorld.traceRay(from, e, tr, staticOnly, (query?.contents ?? DEFAULT_CONTENTS) >>> 0);
    } else {
      world.traceRay(from, e, tr, staticOnly);
    }
    const hit = tr.fraction < 1 || tr.startSolid;
    return { hit, position: tr.endPos.slice(), normal: tr.normal.slice(), fraction: tr.fraction, startSolid: tr.startSolid };
  };
}
