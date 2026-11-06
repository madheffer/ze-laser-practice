// Source 1's distance falloff for a sound level (CS:GO's update_default operator stack: calc_falloff =
// S_GetGainFromSoundLevel / SND_GetGainFromMult, snd_refdb 60, snd_refdist 36, snd_gain_max 1, snd_gain_min 0.01):
//   mult = 10^(snd_refdb / 20) / 10^(level / 20) / snd_refdist, relative distance r = distance x mult,
//   gain = 1 / r (at most 1); under snd_gain_min it falls linearly to 0 at twice the distance: 0.01 x (2 - r x 0.01).
// SNDLVL_NONE (0) has no falloff. Returned as audio/spatial.js's curve ([[units, gain], ...], linear between points:
// exact at each point). A Source 1 map's soundevents.json carries each event's `soundlevel` (lasers-bake source1);
// an ambient_generic sends its own (from its radius, classes/ambient-source1.js).
const REF_DB = 60, REF_DIST = 36, GAIN_MIN = 0.01;
const POINTS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 25, 35, 50, 70, 100, 150, 200];
const cache = new Map();

export function sourceCurve(level) {
  const lv = Math.max(0, Math.round(Number(level) || 0));
  if (cache.has(lv)) return cache.get(lv);
  let curve;
  if (lv <= 0) curve = [[0, 1]];
  else {
    const mult = Math.pow(10, REF_DB / 20) / Math.pow(10, lv / 20) / REF_DIST;
    curve = POINTS.map((r) => {
      let g = Math.min(1, 1 / r);
      if (g < GAIN_MIN) g = Math.max(0, GAIN_MIN * (2 - r * GAIN_MIN));
      return [r / mult, g];
    });
  }
  if (cache.size < 512) cache.set(lv, curve);
  return curve;
}

// CAmbientGeneric's ComputeSoundlevel: a radius (not "play everywhere") is the level at which a sound is 40 dB at it
export const ambientLevel = (radius, everywhere) => (radius > 0 && !everywhere ? Math.trunc(40 + 20 * Math.log10(radius / 36)) : 0);
