// Where a sound is relative to you: distance gain (CS2's distance_volume_mapping_curve) and stereo pan.
// Source units, Z up; panned by hand so nothing depends on WebAudio's PannerNode conventions.
import { clamp01 } from '../lib/math.js';
import { DEG } from '../world/entities/math.js';

// Events without a curve: roughly Source's 75 dB falloff.
const DEFAULT_CURVE = [[100, 1], [1000, 0.45], [2500, 0.12], [4500, 0]];

// [[units, gain], ...] at distance d, linear between points, flat past the ends.
export function evalCurve(curve, d) {
  if (!curve || !curve.length) return 1;
  if (d <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [d1, g1] = curve[i];
    if (d <= d1) {
      const [d0, g0] = curve[i - 1];
      return d1 > d0 ? g0 + (g1 - g0) * (d - d0) / (d1 - d0) : g1;
    }
  }
  return curve[curve.length - 1][1];
}

// gain (the voice's own gain x distance curve) and pan (-1 left .. 1 right) for a sound at pos. distMult: the
// event's distance_multiplier (csgo_mega multiplied_distance = distance x it): 0 = always at the curve's start
// (ze_neochrome's intro / door / boss-end / rotating-laser sounds are heard map-wide at full volume).
export function spatialMix(pos, listener, curve, gain, distMult = 1) {
  const L = listener.pos;
  const dx = pos[0] - L[0], dy = pos[1] - L[1], dz = pos[2] - L[2];
  const d = Math.hypot(dx, dy, dz);
  const g = gain * evalCurve(curve || DEFAULT_CURVE, d * (Number.isFinite(distMult) && distMult >= 0 ? distMult : 1));
  let p = 0;
  const hd = Math.hypot(dx, dy);
  if (hd > 1) {
    // Source: forward = (cos yaw, sin yaw); +Y is to the left, so right = (sin yaw, -cos yaw)
    const yaw = listener.yaw * DEG;
    const side = (dx * Math.sin(yaw) - dy * Math.cos(yaw)) / hd;
    // full pan only once the source is clearly off to one side and not on top of you
    p = side * 0.85 * clamp01((d - 16) / 96);
  }
  return { gain: g, pan: p };
}
