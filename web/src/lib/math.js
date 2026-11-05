// Small numeric helpers. (Source angle / keyvalue maths lives in world/entities/math.js.)

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const clamp01 = (v) => clamp(v, 0, 1);

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
