// C_OP_RenderStandardLight's maths, no three.js (node runs it): a particle -> the light description particles.dll
// hands the scene system -> the barn light record scenesystem.dll turns it into. lights.js runs it per particle;
// light.js packs records for the GPU; spritecard.js's GLSL evaluates barnScalar().
//
// Evidence: particles.dll md5 63babcbf3245e56855a777134323e74a (render 0x1802ee5f0, vtable slot 48, and the helpers
// cited below), scenesystem.dll md5 243931a0d9a3cc7bd05984d9eda02c1f (0x1804a3ce0, convar default at 0x1800110d7),
// and source2-compiler docs/PARTICLE_RENDERING.md (branch research/particles) "RE §8 / §10" for the GPU side.

const f32 = Math.fround;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** HLSL smoothstep: also defined for edge0 > edge1, which GLSL's is not. */
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** particles 0x18035f2e0: byte * (1/255), clamped, sRGB EOTF: x/12.92 at most 0.04045, else ((x + 0.055)/1.055)^2.4. */
export function srgbToLinear(v) {
  v = clamp01(v);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// Luminance weights. RecalculateDerivedValues (0x1803774b0) uses 0x180468a00/08/1804689fc = Rec.709; the render
// function's desaturation and LUMINANCE blend use 0x1805341a4/c0/190 = 0.2125, 0.7154, 0.0721.
export const lum709 = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const lumDesat = (c) => 0.2125 * c[0] + 0.7154 * c[1] + 0.0721 * c[2];

// The sprite renderers' colour blend per ParticleColorBlendType_t, in 0..1 (tint = particle colour, s = colour
// scale). The light does its own byte version below (lightColorBytes).
// out: an array to write into (the sprite loop reuses one per renderer: no garbage per particle)
export function colorBlend(type, s, t, out = [0, 0, 0]) {
  for (let i = 0; i < 3; i++) {
    let v;
    switch (type) {
      case 0: v = s[i] * t[i]; break;
      case 1: case 5: v = 2 * s[i] * t[i]; break;
      case 2: v = s[i] === 0 ? (t[i] > 0 ? 1 : 0) : t[i] / s[i]; break;
      case 3: v = t[i] + s[i]; break;
      case 4: v = t[i] - s[i]; break;
      case 6: v = 1 - (1 - t[i]) * (1 - s[i]); break;
      case 7: v = Math.max(t[i], s[i]); break;
      case 8: v = Math.min(t[i], s[i]); break;
      case 9: v = s[i]; break;
      case 10: v = (t[i] + s[i]) / 2; break;
      case 11: v = 1 - t[i] * s[i]; break;
      case 12: v = t[i] * lum709(s); break;
      default: v = s[i] * t[i];
    }
    out[i] = clamp01(v);
  }
  return out;
}

// cvttss2si then movzx al (0x1802ef485 - 0x1802ef4b8): the particle colour truncates to an int and keeps its low byte, so
// 1.0 -> 255 but 1.01 -> 1 and -0.001 -> 0; NaN / out of int range -> 0x80000000 -> 0.
const toByteWrap = (x) => (Number.isFinite(x) && Math.abs(x) < 2147483648 ? Math.trunc(x) & 0xff : 0);
// cvtps2dq (round to nearest even) -> packusdw (int32 -> u16 unsigned saturate) -> packuswb (as signed i16 -> u8):
// 256..32767 -> 255 but 32768..65535 -> 0; NaN / inf -> 0x80000000 -> 0 (0x1802ef61d).
function packByte(x) {
  if (!Number.isFinite(x) || Math.abs(x) >= 2147483648) return 0;
  let r = Math.round(x);
  if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) r -= 1;                          // ties to even
  let u = r < 0 ? 0 : r > 65535 ? 65535 : r;
  if (u > 32767) u -= 65536;
  return u < 0 ? 0 : u > 255 ? 255 : u;
}

/**
* The light's colour bytes (render 0x1802ee5f0: scale preprocessing at 0x1802ee889, the per-particle switch at
* 0x1802ef4e7): scale s from m_vecColorScale (0..1: a literal colour reads x 1/255, inputs.js), tint the particle
* colour attribute (0..1). Scale first: x2 for MULTIPLY2X / MOD2X, x255 for ADD, SUBTRACT, MAX, MIN, REPLACE,
* AVERAGE, 1 - s for SCREEN; then against the 0-255 tint byte.
*/
export function lightColorBytes(type, scale, tint) {
  const s = scale.map((v) => f32(v));
  if (type === 1 || type === 5) for (let i = 0; i < 3; i++) s[i] = f32(s[i] + s[i]);
  else if ([3, 4, 7, 8, 9, 10].includes(type)) for (let i = 0; i < 3; i++) s[i] = f32(s[i] * 255);
  else if (type === 6) for (let i = 0; i < 3; i++) s[i] = f32(1 - s[i]);
  const L = f32(s[1] * 0.7154 + s[0] * 0.2125 + s[2] * 0.0721);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const t = toByteWrap(f32(tint[i] * 255));
    let v;
    switch (type) {
      case 2: v = t / s[i]; break;
      case 3: v = s[i] + t; break;
      case 4: v = t - s[i]; break;
      case 6: v = 255 - (255 - t) * s[i]; break;
      case 7: v = Math.max(t, s[i]); break;
      case 8: v = Math.min(t, s[i]); break;
      case 9: v = s[i]; break;
      case 10: v = (s[i] + t) * 0.5; break;
      case 11: v = 255 - s[i] * t; break;
      case 12: v = L * t; break;
      default: v = s[i] * t;                                                    // 0, 1, 5 and anything past 12
    }
    out[i] = packByte(f32(v));
  }
  return out;
}

/** particles 0x18035e120 SolveInverseQuadraticMonotonic, float32 like the DLL. y = a x^2 + b x + c. */
export function solveInverseQuadraticMonotonic(x1, y1, x2, y2, x3, y3) {
  [x1, y1, x2, y2, x3, y3] = [x1, y1, x2, y2, x3, y3].map(f32);
  if (x2 < x1) [x1, y1, x2, y2] = [x2, y2, x1, y1];
  if (x3 < x2) [x2, y2, x3, y3] = [x3, y3, x2, y2];
  if (x2 < x1) [x1, y1, x2, y2] = [x2, y2, x1, y1];
  const m = (a, b) => f32(a * b), s = (a, b) => f32(a - b), p = (a, b) => f32(a + b), d = (a, b) => f32(a / b);
  let t = 0, a = 0, b = 0, c = 0;
  const det = m(m(s(x1, x2), s(x1, x3)), s(x2, x3));
  for (;;) {
    if (det === 0) return { ok: false, a, b, c };
    const lin = p(d(m(s(x2, x1), s(y3, y1)), s(x3, x1)), y1);
    const ty2 = p(m(lin, t), m(s(1, t), y2));
    a = d(p(p(m(s(ty2, y1), x3), m(s(y1, y3), x2)), m(s(y3, ty2), x1)), det);
    b = d(p(p(m(m(s(y1, ty2), x3), x3), m(m(s(ty2, y3), x1), x1)), m(m(x2, x2), s(y3, y1))), det);
    c = d(p(p(m(m(s(m(y1, x3), m(x1, y3)), x2), x2), m(m(m(x1, x3), s(x3, x1)), ty2)), m(s(m(m(x1, x1), y3), m(m(x3, x3), y1)), x2)), det);
    const deriv = p(p(a, a), b);
    if (y1 < y2 && y2 < y3) { if (!(deriv < 0)) return { ok: true, a, b, c }; }
    else if (y1 > y2 && y2 > y3) { if (!(deriv > 0)) return { ok: true, a, b, c }; }
    else return { ok: true, a, b, c };
    t = f32(t + f32(0.05));
    if (!(t <= 1)) return { ok: true, a, b, c };
  }
}

/** particles 0x180378580 SetupNewStyleAttenuation: 1/atten through (0,1), (d50,2), (d0,256), then 50% at d50. */
export function newStyleAttenuation(d50, d0) {
  d50 = f32(d50); d0 = f32(d0);
  if (d0 < d50) d0 = f32(d50 + d50);
  const q = solveInverseQuadraticMonotonic(0, 1, d50, 2, d0, 256);
  const s = f32(2 / f32(f32(f32(f32(q.a * d50) + q.b) * d50) + q.c));
  return { c: f32(q.c * s), l: f32(q.b * s), q: f32(q.a * s), ok: q.ok };
}

/** particles 0x1803786f0 SetupOldStyleAttenuation(q = 1 - lin, l = lin, c = 0); scale (if > 0) multiplies the colours. */
export function oldStyleAttenuation(linearity) {
  const eps = f32(0.001);
  let q = f32(1 - f32(linearity)), l = f32(linearity), c = 0;
  if (q < eps) q = 0;
  if (l < eps) l = 0;
  if (c < eps) { c = 0; if (l < eps && q < eps) c = 1; }
  return { c, l, q, scale: f32(f32(f32(q * 10000) + f32(l * 100)) + c) };
}

/** particles 0x18035e400 SolveQuadratic: both roots of a x^2 + b x + c, or null. */
function solveQuadratic(a, b, c) {
  if (a === 0) {
    if (b !== 0) { const r = -c / b; return [r, r]; }
    return c === 0 ? [0, 0] : null;
  }
  const disc = b * b - 4 * a * c;
  if (!(disc >= 0)) return null;
  const sq = Math.sqrt(disc);
  return [(sq - b) / (a + a), (-b - sq) / (a + a)];
}

/**
* particles 0x1803774b0 RecalculateDerivedValues(desc, 0.001), the part a point / spot light uses: when the
* constant term is 0 (every OLD light) the range is cut to where lum709(colour) * atten(d) = 0.001; a colour of
* luminance 0 gets range 0.
*/
function clampRange(R, C, { c, l, q }) {
  const lum = lum709(C);
  let dthr = 0;
  if (lum > 0) {
    const k = 0.001 / lum;
    const r = solveQuadratic(k * q, k * l, k * c - 1);
    if (r) dthr = Math.max(0, Math.max(r[0], r[1]));
  }
  return R > 0 && R <= dthr ? R : dthr;
}

/** Source AngleVectors (particles 0x18035db20), degrees: forward and up (the render function passes no right). */
export function angleVectors(pitch, yaw, roll = 0) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const sp = Math.sin(rad(pitch)), cp = Math.cos(rad(pitch));
  const sy = Math.sin(rad(yaw)), cy = Math.cos(rad(yaw));
  const sr = Math.sin(rad(roll)), cr = Math.cos(rad(roll));
  return {
    forward: [cp * cy, cp * sy, -sp],
    up: [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp],
  };
}

/** particles 0x1800522b0 VectorNormalize in place; returns the length (0 leaves the vector alone here). */
export function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len > 0) { v[0] /= len; v[1] /= len; v[2] /= len; }
  return len;
}

/** particles 0x18035eba0: a unit vector perpendicular to the unit axis a (the capsule light's forward). */
export function perpendicular(a) {
  const p = [(1 - a[2]) * (a[1] * a[1]) + a[2], 0, -a[0]];
  normalize(p);
  const d = p[0] * a[0] + p[1] * a[1] + p[2] * a[2];
  p[0] -= d * a[0]; p[1] -= d * a[1]; p[2] -= d * a[2];
  normalize(p);
  return p;
}

/**
* One particle's light description (render 0x1802ee5f0 from 0x1802eed9c to the scene-system call at 0x1802efa83),
* the fields the renderer hands over. `o` (per particle, already evaluated):
*   tint [r,g,b] 0..1 particle colour, alpha, intensity, radius (or (r + r_next)/2 for a rope capsule),
*   scale [r,g,b] m_vecColorScale, blendType, radiusMultiplier, lightType 0..3, attenuation 0 OLD / 1 NEW,
*   linearity (clamped 0..1), fifty / zero (clamped as the DLL does), theta, phi, diffuse, specular, fogMode,
*   fogContribution, castShadows, style (light style factor, 1), rendererTint [1,1,1], desaturation (0),
*   position, forward, capsule (axis vector or null), color2 (second capsule colour, else the first).
*/
export function particleLightDesc(o) {
  const C0 = lightColorBytes(o.blendType ?? 0, o.scale || [1, 1, 1], o.tint || [1, 1, 1]).map((b) => srgbToLinear(f32(b * 0.003921569)));
  const shade = (C, alpha) => {
    const L = lumDesat(C), tint = o.rendererTint || [1, 1, 1], desat = o.desaturation ?? 0, st = o.style ?? 1;
    return C.map((x, i) => ((L - x) * desat + x) * st * tint[i] * o.intensity * alpha);
  };
  const fx = o.lightType === 2;
  const desc = {
    type: o.lightType === 1 ? 3 : 1,                                            // desc +0x00: SPOT 3, else 1 (0x1802ef53e)
    color: shade(C0, o.alpha),                                                  // +0x04
    color2: o.color2 ? shade(o.color2.map((b) => srgbToLinear(f32(b * 0.003921569))), o.alpha) : null, // +0x10
    range: o.radius * o.radiusMultiplier,                                       // +0x1c
    theta: o.theta, phi: o.lightType === 3 ? 0 : o.phi,                         // +0x30 / +0x34 (degrees)
    castShadows: fx ? false : !!o.castShadows,                                  // +0x3d
    dynamicBounce: fx ? false : !!o.dynamicBounce,                              // +0x75 (bit 2)
    fogMode: fx ? 0 : (o.fogMode ?? 0),                                         // +0x77
    diffuse: fx ? true : o.diffuse !== false,                                   // +0x78
    specular: fx ? false : o.specular !== false,                                // +0x79
    capsuleFlag: o.lightType === 3,                                             // +0x7b
    fogContribution: o.fogContribution ?? 1,                                    // +0x90
    position: o.position, forward: o.forward, capsule: o.capsule ?? null,       // +0x98, +0xa4, +0xb0
  };
  const scaleColours = (k) => {
    desc.color = desc.color.map((x) => x * k);
    if (desc.color2) desc.color2 = desc.color2.map((x) => x * k);
  };
  if ((o.attenuation ?? 0) === 0) {
    const a = oldStyleAttenuation(fx ? 1 : o.linearity);                        // FX forces linearity 1 (0x1802ef2c3 branch)
    if (a.scale > 0) scaleColours(a.scale);
    desc.atten = { c: a.c, l: a.l, q: a.q };
  } else {
    const a = newStyleAttenuation(desc.range * o.fifty, desc.range * o.zero);
    desc.atten = { c: a.c, l: a.l, q: a.q };
    desc.solverOk = a.ok;
  }
  desc.rangeBeforeClamp = desc.range;
  if (desc.atten.c === 0) desc.range = clampRange(desc.range, desc.color, desc.atten);
  const { c, l, q } = desc.atten, R = desc.range;
  desc.attenAtRange = c > 0 || !(R > 0) ? 0 : 1 / (R * R * q + R * l + 1.1920929e-07); // +0xcc
  return desc;
}

/**
* scenesystem 0x1804a3ce0 (called by the light binner at 0x1801a205c with the convar
* lb_convert_to_barn_lights_falloff_match_point, default 0.15f at 0x1800110d7): a point or spot description becomes
* a barn light whose falloff is plain 1/d^2 matched to the description's curve at m = 0.15 x range:
*   m = 0.15 R (100 if that is at most 0); k = m^2 / ((m^2 q + m l) + c); record colour = k x colour;
*   distance fade (record +0xc8 / +0xcc) = (R'/(R' - s), 1/(s - R')), s = R - 0.25 R, R' = max(R, s + 1 ulp).
* Returns null for a range of at most 0 (it lights nothing).
*/
export function descToBarn(desc, matchPoint = 0.15) {
  const R = desc.range;
  if (!(R > 0)) return null;
  let m = R * matchPoint;
  if (!(m > 0)) m = 100;
  const { c, l, q } = desc.atten;
  const k = (m * m) / ((m * m * q + m * l) + c);
  const s = R - R * 0.25;
  return {
    k, matchDistance: m,
    color: desc.color.map((x) => x * k),
    color2: desc.color2 ? desc.color2.map((x) => x * k) : null,
    fade: [R / (R - s), 1 / (s - R)],
  };
}

/**
* The per-pixel barn result without colour (RE §8 runtime shader, §10): 1 / max(d^2, 1) *
* smoothstep(0, 1, fade.x + fade.y d) [* the spot cone]. size^2 = 1 (description +0x94 defaults to 1, 0x1801bf620).
* UNSETTLED: the spot cone (RE §8 reads a saturated linear ramp in cosine, §10 a smoothstep in tan); no baked
* map uses a spot particle light.
*/
export function barnScalar(b, d) {
  return (1 / Math.max(d * d, 1)) * smoothstep(0, 1, b.fade[0] + b.fade[1] * d);
}
