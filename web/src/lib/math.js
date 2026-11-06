// Small numeric helpers. (Source angle / keyvalue maths lives in world/entities/math.js.)

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const clamp01 = (v) => clamp(v, 0, 1);
// a to b by t (degrees), the short way round
export const lerpAngle = (a, b, t) => a + ((((b - a) % 360) + 540) % 360 - 180) * t;

// Move `from` toward `to` by at most `step`, landing exactly on `to` (movers, spin-up, handles).
export const approach = (from, to, step) => {
  const d = to - from;
  return Math.abs(d) <= step ? to : from + Math.sign(d) * step;
};

// Grow an AABB (min/max arrays of 3) to include another one.
export function growBounds(min, max, lo, hi) {
  for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], lo[a]); max[a] = Math.max(max[a], hi[a]); }
}
export const emptyBounds = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

// 3-vectors as [x, y, z] arrays.
export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
