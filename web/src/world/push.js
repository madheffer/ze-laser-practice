// Movers push the player. A solid entity that moves into you this tick carries you with its move, as a Source
// pusher does (SV_Push / CPhysicsPushedEntities: each entity the pusher overlaps after its move is moved by the
// pusher's motion, its own velocity untouched). The move is a trace against the world and every other solid, so a
// wall you are pushed into stops you; the pusher then sits in you (Source: "blocked", and a func_tracktrain with
// "Unblockable by Player" carries on). The mover you stand on is player.ride's (world/movement.js), not this.
// ze_the_shifting_pool's wave minigame: walls on mg_chunk_* trains come down the corridor at 700 u/s, and one you
// don't get through shoves you back into the trigger_teleport that sends humans to the kill room.
// UNSETTLED: CS2's VPhysics2 kinematic push isn't decompiled; this is Source's rule (translation and rotation by
// the mover's own transform, no velocity given).
import { boxTouchesHull } from './collision.js';

const SKIN = 0.05; // a hull just touching you (standing against a wall) isn't in you

// before: Map(entity -> its world matrix at the start of the tick); solids: engine.solids() after the tick's moves
export function pushPlayer(player, before, solids) {
  const ground = player.groundEntity;
  const h = player.half();
  const hs = [h[0] - SKIN, h[1] - SKIN, h[2] - SKIN];
  for (const d of solids) {
    const e = d.ref;
    if (e === ground) continue;
    const old = before.get(e);
    if (!old) continue;
    const now = e.getWorld();
    if (old.elements.every((v, i) => v === now.elements[i])) continue;
    const c = player.centre();
    if (c[0] + hs[0] < d.min[0] || c[0] - hs[0] > d.max[0] || c[1] + hs[1] < d.min[1] || c[1] - hs[1] > d.max[1] || c[2] + hs[2] < d.min[2] || c[2] - hs[2] > d.max[2]) continue;
    if (!d.hulls.some((hull) => boxTouchesHull(c, hs, hull))) continue;
    // where the mover's motion takes your feet: through its old frame and back out of its new one
    const o = player.origin;
    const inv = old.clone().invert().elements, a = now.elements;
    const lx = inv[0] * o[0] + inv[4] * o[1] + inv[8] * o[2] + inv[12];
    const ly = inv[1] * o[0] + inv[5] * o[1] + inv[9] * o[2] + inv[13];
    const lz = inv[2] * o[0] + inv[6] * o[1] + inv[10] * o[2] + inv[14];
    const target = [a[0] * lx + a[4] * ly + a[8] * lz + a[12], a[1] * lx + a[5] * ly + a[9] * lz + a[13], a[2] * lx + a[6] * ly + a[10] * lz + a[14]];
    // moved as far as the world and the other solids let you
    const world = player.world, all = world.dynamic;
    world.dynamic = all.filter((x) => x !== d);
    const tr = player.trace(o, target);
    world.dynamic = all;
    if (!tr.allSolid) player.origin = [tr.endPos[0], tr.endPos[1], tr.endPos[2] - player.height / 2];
  }
}

// the solids' world matrices before the tick's moves (the pushPlayer `before`)
export function solidMatrices(solids) {
  const m = new Map();
  for (const d of solids) m.set(d.ref, d.ref.getWorld().clone());
  return m;
}
