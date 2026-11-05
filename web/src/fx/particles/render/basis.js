// Geometry rules of the spritecard vertex shaders (RE §3, §6), without three.js. sprites.js runs
// the same maths in GLSL; ropes.js builds its strips on the CPU from these functions. VS0 and TVS
// cite spritecard_vulkan_50_vs_s0_f0 / _vs_s16_f0 .cb.hlsl by line.

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const normalize = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? mul(a, 1 / l) : [0, 0, 0]; };
export const vec = { cross, dot, add, sub, mul, normalize };

/**
* Up and right of a sprite (VS0:3177-3260); `mode` is clamped like VS0:153, so FULL_3AXIS (5) draws as 4.
* For mode 4 this follows the dump (up = normalize(cross(n, fwd)), right = n, VS0:3240-3245), not RE §3's table.
*/
export function spriteBasis(mode, camUp, camFwd, n = [0, 0, 1]) {
  mode = Math.min(4, mode);
  if (mode === 0) return { up: camUp, right: cross(camFwd, camUp) };
  if (mode === 1) return { up: [0, 0, 1], right: cross([0, 0, 1], camFwd) };
  if (mode === 2) return { up: [1, 0, 0], right: [0, -1, 0] };
  if (mode === 3) {
    const ref = Math.abs(n[2]) > 0.1 ? [0, -1, 0] : [0, 0, 1];
    const up = normalize(cross(n, ref));
    return { up, right: cross(up, n) };
  }
  return { up: normalize(cross(n, camFwd)), right: n };
}

/**
 * Corner offset before the radius scale (VS0:3271-3294): roll turns up into
 * up' = up cos - right sin, yaw is a Rodrigues rotation about up', and
 * offset = R_yaw (right cos + up sin)(x + cx) + up'(y + cy). The world corner is centre + offset * r.
 */
export function spriteOffset(basis, roll, yaw, x, y, cx = 0, cy = 0) {
  const c = Math.cos(roll), s = Math.sin(roll);
  const { up, right } = basis;
  const up2 = sub(mul(up, c), mul(right, s));
  const side = add(mul(right, c), mul(up, s));
  const [ax, ay, az] = up2, cy2 = Math.cos(yaw), sy2 = Math.sin(yaw), k = 1 - cy2;
  const R = [
    [ax * ax + (1 - ax * ax) * cy2, ax * ay * k - az * sy2, az * ax * k + ay * sy2],
    [ax * ay * k + az * sy2, ay * ay + (1 - ay * ay) * cy2, ay * az * k - ax * sy2],
    [az * ax * k - ay * sy2, ay * az * k + ax * sy2, az * az + (1 - az * az) * cy2],
  ];
  const rs = [dot(R[0], side), dot(R[1], side), dot(R[2], side)];
  return add(mul(rs, x + cx), mul(up2, y + cy));
}

/**
 * Screen-size limits (VS0:3300-3321), d = |cam - centre|, c0 = VC_c0: fades the colour between
 * c0.y*d and c0.z*d, then clamps r into [c0.x*d, c0.w*d].
 */
export function screenSizeLimit(r, d, c0) {
  let colorMul = 1;
  if (r > c0[1] * d) colorMul = r > c0[2] * d ? 0 : 1 - (r - c0[1] * d) / (d * (c0[2] - c0[1]));
  return { r: Math.min(Math.max(r, c0[0] * d), c0[3] * d), colorMul };
}

/** Uniform Catmull-Rom, tension 0.5, between p1 and p2 (TVS:2743-2753); scalars or vectors. */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
  return Array.isArray(p1) ? [0, 1, 2].map((i) => f(p0[i], p1[i], p2[i], p3[i])) : f(p0, p1, p2, p3);
}

/** Its derivative, the tangent the trail side is crossed from (TVS:2754-2785). */
export function catmullRomTangent(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const f = (a, b, c, d) => 0.5 * (c - a) + (2 * a - 5 * b + 4 * c - d) * t + 1.5 * (3 * b - a - 3 * c + d) * t2;
  return [0, 1, 2].map((i) => f(p0[i], p1[i], p2[i], p3[i]));
}

/**
 * The strip's side vector, normalize(cross(tangent, N)) (TVS:2765-2783, 3041): N is the
 * interpolated particle normal for mode 3, world up for mode 2, otherwise cam - spline position.
 * The vertex is spline + side * width * x with x in [-1, 1], so the full width is 2 x radius.
 */
export function ropeSide(mode, tangent, camPos, splinePos, normal) {
  mode = Math.min(4, mode);
  const N = mode === 3 ? normal : mode === 2 ? [0, 0, 1] : sub(camPos, splinePos);
  return normalize(cross(tangent, N));
}

/**
 * V along a rope (TVS:173): when 1/worldSize > 0, (lerp(distStart, distEnd, t) + offset) / worldSize.
 * UNSETTLED (RE §1-4 #6): that the two distances (T2.z, T7.x) are the running length along the
 * rope at each end of the segment, and that the scroll lands in the offset term.
 */
export function ropeV(distStart, distEnd, t, offset, invWorldSize) {
  return (distStart + (distEnd - distStart) * t + offset) * invWorldSize;
}

/**
* A sprite-sheet sample (VS0:1577-1740) on the CPU: the catalog serves per-frame JSON (EffectAssetCodec.SheetJson).
* Advances k*age*rate per second: k = 1/totalTime with VC_c16w & 4096 (taken as m_bAnimateInFPS, UNSETTLED), else 1.
* An out-of-range sequence reads 0; a clamped one holds its last frame; blend weights toward the next frame.
*/
export function sheetSample(sheet, sequence, age, rate, inFps) {
  if (!Array.isArray(sheet) || !sheet.length) return null;
  const seq = sheet[sequence >= 0 && sequence < sheet.length ? Math.floor(sequence) : 0];
  const frames = seq.frames || [];
  if (!frames.length) return null;
  const times = frames.map((f) => Math.max(0, f.time || 0));
  const total = times.reduce((a, b) => a + b, 0) || frames.length;
  const step = (j) => (times[j] > 0 ? times[j] : total / frames.length);
  const k = inFps ? 1 / total : 1;
  let pos = k * age * rate * total;
  if (seq.clamp) pos = Math.min(Math.max(pos, 0), total * (1 - 1e-6));
  else pos = ((pos % total) + total) % total;
  let i = 0, start = 0;
  while (i < frames.length - 1 && start + step(i) <= pos) { start += step(i); i++; }
  const next = i + 1 < frames.length ? i + 1 : (seq.clamp ? i : 0);
  const rect = (f) => (f.uv && f.uv.length === 4 ? f.uv : [0, 0, 1, 1]);
  return { rect0: rect(frames[i]), rect1: rect(frames[next]), blend: Math.min(1, Math.max(0, (pos - start) / step(i))) };
}
