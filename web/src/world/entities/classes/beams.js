// Damage that isn't a trigger volume: env_laser beams and point_hurt.
//
// env_laser (CS2 CEnvLaser, Source CBeam::BeamDamage): a beam from the laser to its `lasertarget`, cut short where the
// static world blocks it; while it passes through you it does `damage` per second (scaled by the time since the last
// strike, DMG_ENERGYBEAM: no armor). Spawnflags 1 = start on; TurnOn / TurnOff / Toggle. `width` is how wide it is
// drawn (render.js), the hit is the beam's line, as Source traces it. ze_dreamin: 6 pairs (laser_1 -> laser_2 ...), 100.
//
// point_hurt (CPointHurt): Hurt does `damage` to `damagetarget` once; TurnOn repeats it every `damagedelay` (0.1 s
// when unset) until TurnOff. Only the player takes it here (the one human the map's damage is for).
import { register } from '../registry.js';
import { num } from '../math.js';
import { queueEvent } from './triggers.js';

register('env_laser', {
  spawn(e) {
    e.state.active = !!(num(e.kv.spawnflags) & 1); // render.js draws the beam while active
    e.state.touching = false;
  },
  input(e, inp) {
    const s = e.state;
    switch (inp) {
      case 'turnon': s.active = true; return true;
      case 'turnoff': s.active = false; return true;
      case 'toggle': s.active = !s.active; return true;
    }
  },
  think(e, dt) {
    const s = e.state;
    const target = e.kv.lasertarget ? e.engine.findOne(e.kv.lasertarget) : null;
    if (!s.active || !target) { s.beamEnd = null; s.touching = false; return; }
    const a = e.worldOrigin();
    let b = target.worldOrigin();
    if (e.engine.traceBox) {
      const tr = e.engine.traceBox(a, b, [0, 0, 0]);
      if (tr.fraction < 1) b = [...tr.endPos];
    }
    s.beamStart = a; s.beamEnd = b;
    const ph = e.engine.playerHull;
    const hit = !!ph && segmentHitsBox(a, b, ph.c, ph.h);
    if (hit) {
      const dmg = num(e.kv.damage) * dt;
      if (dmg > 0) queueEvent(e.engine, { type: 'hurt', ent: e, damage: dmg, first: !s.touching });
    }
    s.touching = hit;
  },
});

register('point_hurt', {
  input(e, inp, p, act) {
    const s = e.state;
    switch (inp) {
      case 'hurt': hurt(e, act); return true;
      case 'turnon': s.on = true; s.next = e.engine.time; s.act = act; return true;
      case 'turnoff': s.on = false; return true;
      case 'toggle': s.on = !s.on; s.next = e.engine.time; s.act = act; return true;
    }
  },
  think(e) {
    const s = e.state;
    if (!s.on || e.engine.time < s.next) return;
    hurt(e, s.act);
    s.next = e.engine.time + (num(e.kv.damagedelay) > 0 ? num(e.kv.damagedelay) : 0.1);
  },
});

function hurt(e, activator) {
  const targets = e.engine.find(e.kv.damagetarget || '', e, activator);
  const dmg = num(e.kv.damage);
  if (dmg > 0 && targets.includes(e.engine.playerEnt)) queueEvent(e.engine, { type: 'hurt', ent: e, damage: dmg, first: true });
}

// Does the segment a->b pass through the box centred on c with half extents h? (slab test)
function segmentHitsBox(a, b, c, h) {
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i];
    const lo = c[i] - h[i] - a[i], hi = c[i] + h[i] - a[i];
    if (Math.abs(d) < 1e-9) { if (lo > 0 || hi < 0) return false; continue; }
    let u = lo / d, v = hi / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t0 > t1) return false;
  }
  return true;
}
