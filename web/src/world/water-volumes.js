// CS2's water as its traces see it: everything on the water or slime interaction layer (mask 0x18000, CS2Fixes
// const.h layer 15 water, 16 slime). The player's CheckWater, the knife's splash ray and a bullet's water entry trace
// with that mask (cs2_server 2026-09-23: FUN_180ab78d0 CheckWater 0x18000, the knife FUN_180a28f90 0x1d9003, the
// bullet FUN_180a70890 0x18000). The shapes:
//   - func_water: CS2's water volume entity. Its compiled physics carries no water layer (ze_the_shifting_pool: the
//     pool's water_main and 5 more are collision group "default" with no InteractAs strings, only water_mg_wave says
//     "water"), so the entity itself is the water (CFuncWater), every shape of it. UNSETTLED: CFuncWater's Spawn not
//     decompiled; a func_water is water by what the class is for (CS2 FGD "Water volume")
//   - any other entity's shape whose own layers say water / slime: ze_the_shifting_pool's tidal waves (passable
//     func_tracktrains train_wave1 / 2 / finale) are water moving over the pool
//   - the static world's water / slime triangles (collision_fx*.bin; ze__hell_p, ze_visualizer)
//
//   const water = waterQuery(engine, fx)    // fx: the map's { tris | bvh, layers } (S.map.collisionFx), or null
//   water.trace(s, e) -> { fraction, slime }   // where s -> e first meets water: 0 if s is in it, 1 for a miss
//   water.in(p) -> 'water' | 'slime' | null    // the water a point is in (a hull's inside)
import { makeTrace, rayHullEntry, TriangleBVH, CollisionWorld } from './collision.js';

export const LAYER_WATER = 1 << 15;
export const LAYER_SLIME = 1 << 16;
export const WATER_MASK = LAYER_WATER | LAYER_SLIME;

// Is this entity's model water, and which shapes? Cached on the entity (the model never changes).
function waterKind(e) {
  if (e.waterKind !== undefined) return e.waterKind;
  const src = e.model ? e.engine.assets.hulls?.[e.model] : null;
  let kind = null;
  if (src?.length) {
    if (e.cls === 'func_water') kind = src.some((h) => (h.layers & WATER_MASK) === LAYER_SLIME) ? 'slime' : 'water';
    else if (src.some((h) => h.layers & WATER_MASK)) kind = 'shapes';
  }
  e.waterKind = kind;
  return kind;
}

// the placed hulls of every live water entity, each { hull, slime }
function waterHulls(engine, out) {
  out.length = 0;
  for (const e of engine.ents) {
    if (!e.alive) continue;
    const kind = waterKind(e);
    if (!kind) continue;
    const src = engine.assets.hulls[e.model];
    const placed = e.hulls();
    if (!placed) continue;
    // placed hulls skip mesh-only shapes (entity.js placeHulls): src and placed line up over the convex ones
    let i = 0;
    for (const s of src) {
      if (!s.planes) continue;
      const hull = placed[i++];
      if (!hull) break;
      if (kind === 'shapes' && !(s.layers & WATER_MASK)) continue;
      const slime = kind === 'slime' || (kind === 'shapes' && (s.layers & WATER_MASK) === LAYER_SLIME);
      out.push({ hull, slime });
    }
  }
  return out;
}

function staticWorld(fx) {
  if (!fx?.layers) return null;
  if (!fx.world) fx.world = new CollisionWorld(fx.bvh instanceof TriangleBVH ? fx.bvh : fx.tris, fx.layers);
  return fx.world;
}

// Does the static world have water at all (most maps don't: skip its BVH walk)
function worldHasWater(fx) {
  if (fx?.hasWater !== undefined) return fx.hasWater;
  let w = false;
  if (fx?.layers) for (let i = 0; i < fx.layers.length && !w; i++) if (fx.layers[i] & WATER_MASK) w = true;
  if (fx) fx.hasWater = w;
  return w;
}

export function waterQuery(engine, fx = null) {
  const list = [];
  const tr = makeTrace();
  const d = [0, 0, 0];
  const world = worldHasWater(fx) ? staticWorld(fx) : null;
  let stamp = -1;
  const hulls = () => {
    // once per engine tick (a tick's movement, checks and shots all see the water where it is this tick)
    if (stamp !== engine.time) { waterHulls(engine, list); stamp = engine.time; }
    return list;
  };
  return {
    trace(s, e) {
      d[0] = e[0] - s[0]; d[1] = e[1] - s[1]; d[2] = e[2] - s[2];
      const len = Math.hypot(d[0], d[1], d[2]);
      let best = 1, slime = false;
      if (len > 1e-6) {
        const u = [d[0] / len, d[1] / len, d[2] / len];
        for (const w of hulls()) {
          const h = w.hull;
          // its bounds first
          if (Math.max(s[0], e[0]) < h.min[0] || Math.min(s[0], e[0]) > h.max[0] || Math.max(s[1], e[1]) < h.min[1] || Math.min(s[1], e[1]) > h.max[1] || Math.max(s[2], e[2]) < h.min[2] || Math.min(s[2], e[2]) > h.max[2]) continue;
          const t = rayHullEntry(s, u, h);
          if (t != null && t / len < best) { best = t / len; slime = w.slime; }
        }
      } else if (this.in(s)) return { fraction: 0, slime: this.in(s) === 'slime' };
      if (world) {
        for (const [mask, isSlime] of [[LAYER_WATER, false], [LAYER_SLIME, true]]) {
          world.traceRay(s, e, tr, true, mask);
          const f = tr.startSolid ? 0 : tr.fraction;
          if (f < best) { best = f; slime = isSlime; }
        }
      }
      return { fraction: best, slime };
    },
    in(p) {
      for (const w of hulls()) {
        const h = w.hull;
        if (p[0] < h.min[0] || p[0] > h.max[0] || p[1] < h.min[1] || p[1] > h.max[1] || p[2] < h.min[2] || p[2] > h.max[2]) continue;
        const P = h.planes;
        let inside = true;
        for (let i = 0; i < P.length && inside; i += 4) if (P[i] * p[0] + P[i + 1] * p[1] + P[i + 2] * p[2] > P[i + 3]) inside = false;
        if (inside) return w.slime ? 'slime' : 'water';
      }
      return null;
    },
  };
}
