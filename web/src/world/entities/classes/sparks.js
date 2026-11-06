// Source's spark / tesla / shake entities (CEnvSpark env_spark.cpp, CTesla point_tesla.cpp, CEnvShake env_shake.cpp).
// Like sounds, they emit requests the client draws (engine 'tempfx': world/temp-effects.js; 'shake': app/view-shake.js),
// so the engine stays the same on every client and on the co-op server; their timing draws from the engine's random
// stream, their look from the client's own.
//  - env_spark: StartSpark / StopSpark / ToggleSpark / SparkOnce; spawnflag 64 starts it on. While on, SparkThink runs
//    every 0.1 + RandomFloat(0, MaxDelay) s: a burst (Magnitude 1/2/5/8, TrailLength 1/2/3) and "DoSpark" unless
//    spawnflag 256 (Silent)
//  - point_tesla: TurnOn / TurnOff / DoSpark. On, it sparks every RandomFloat(interval_min, interval_max) s: m_SoundName
//    at its origin and RandomInt(beamcount_min, beamcount_max) beams to where random traces out to m_flRadius end,
//    each RandomFloat(thick_min, thick_max) wide and lasting RandomFloat(lifetime_min, lifetime_max), m_Color
//  - env_shake: StartShake / StopShake / Amplitude / Frequency (UTIL_ScreenShake): amplitude (max 16), frequency,
//    duration; spawnflag 1 = everywhere, else falling off linearly to 0 at radius; 4 = also shakes players in the air
import { register } from '../registry.js';
import { num, parseVec } from '../math.js';

const rand = (engine, lo, hi) => lo + engine.random() * (hi - lo);

// ---- env_spark
function spark(e) {
  const sf = num(e.kv.spawnflags) | 0;
  e.engine.emit('tempfx', { kind: 'sparks', pos: e.worldOrigin(), magnitude: num(e.kv.magnitude, 1), trail: num(e.kv.traillength, 1), seed: e.engine.random() });
  if (!(sf & 256)) e.engine.emit('sound', { type: 'start', ent: e, name: 'DoSpark', pos: e.worldOrigin(), slot: 'spark' });
}
function sparkThink(e, token) {
  if (!e.alive || e.state.sparkToken !== token) return;
  spark(e);
  e.engine.after(0.1 + rand(e.engine, 0, num(e.kv.maxdelay, 0)), () => sparkThink(e, token));
}
const startSpark = (e) => { const t = e.state.sparkToken = (e.state.sparkToken || 0) + 1; e.state.sparking = true; e.engine.after(0, () => sparkThink(e, t)); };
const stopSpark = (e) => { e.state.sparkToken = (e.state.sparkToken || 0) + 1; e.state.sparking = false; };

register('env_spark', {
  spawn(e) { if (num(e.kv.spawnflags) & 64) startSpark(e); },
  input(e, inp) {
    switch (inp) {
      case 'startspark': startSpark(e); return true;
      case 'stopspark': stopSpark(e); return true;
      case 'togglespark': if (e.state.sparking) stopSpark(e); else startSpark(e); return true;
      case 'sparkonce': spark(e); return true;
    }
  },
});

// ---- point_tesla
function tesla(e) {
  const kv = e.kv, en = e.engine;
  const n = Math.round(rand(en, num(kv.beamcount_min, 6), num(kv.beamcount_max, 8)));
  const beams = [];
  for (let i = 0; i < n && i < 64; i++) {
    beams.push({ dir: [rand(en, -1, 1), rand(en, -1, 1), rand(en, -1, 1)], width: rand(en, num(kv.thick_min, 5), num(kv.thick_max, 5)), life: rand(en, num(kv.lifetime_min, 0.3), num(kv.lifetime_max, 0.3)) });
  }
  en.emit('tempfx', { kind: 'tesla', pos: e.worldOrigin(), radius: num(kv.m_flradius, 200), color: parseVec(kv.m_color, [255, 255, 255]), beams, texture: String(kv.texture || '') });
  if (kv.m_soundname) en.emit('sound', { type: 'start', ent: e, name: String(kv.m_soundname), pos: e.worldOrigin(), slot: 'tesla' });
}
function teslaThink(e, token) {
  if (!e.alive || e.state.teslaToken !== token) return;
  tesla(e);
  const lo = num(e.kv.interval_min, 0.5), hi = num(e.kv.interval_max, 2);
  e.engine.after(Math.max(0.05, rand(e.engine, Math.min(lo, hi), Math.max(lo, hi))), () => teslaThink(e, token));
}
register('point_tesla', {
  input(e, inp) {
    switch (inp) {
      case 'turnon': { const t = e.state.teslaToken = (e.state.teslaToken || 0) + 1; e.engine.after(0, () => teslaThink(e, t)); return true; }
      case 'turnoff': e.state.teslaToken = (e.state.teslaToken || 0) + 1; return true;
      case 'dospark': tesla(e); return true;
    }
  },
});

// ---- env_shake: the request carries what each player works out for themself (ComputeShakeAmplitude needs where they
// are): the client scales by distance and skips it in the air unless `inAir`
function shake(e, cmd, extra = {}) {
  const sf = num(e.kv.spawnflags) | 0;
  e.engine.emit('shake', {
    cmd, pos: e.worldOrigin(), amplitude: Math.min(16, num(e.kv.amplitude, 4)), frequency: num(e.kv.frequency, 2.5),
    duration: num(e.kv.duration, 1), radius: (sf & 1) ? 0 : num(e.kv.radius, 500), inAir: (sf & 4) !== 0, noView: (sf & 32) !== 0, ...extra,
  });
}
register('env_shake', {
  input(e, inp, p) {
    switch (inp) {
      case 'startshake': shake(e, 'start'); return true;
      case 'stopshake': shake(e, 'stop'); return true;
      case 'amplitude': e.kv.amplitude = String(num(p, 0)); shake(e, 'amplitude'); return true;
      case 'frequency': e.kv.frequency = String(num(p, 0)); shake(e, 'frequency'); return true;
    }
  },
});
