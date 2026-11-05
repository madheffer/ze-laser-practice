// C_OP_RenderStandardLight as the barn light the scene system turns it into (RE §10). No three.js:
// node runs this for ParticleRenderTests, which pins it to light.json (the float32 port of both
// flashlights). light.js feeds the result to the GPU; the GLSL there evaluates barnScalar().

const f32 = Math.fround;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** HLSL smoothstep: also defined for edge0 > edge1, which GLSL's is not. */
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** particles 0x18035f2e0: sRGB EOTF, x/12.92 or ((x + 0.055)/1.055)^2.4. */
export function srgbToLinear(v) {
  v = clamp01(v);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export const lum709 = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// RE §10 "Colour" per ParticleColorBlendType_t, in 0..1 (tint = particle colour, s = colour scale). UNSETTLED
// (RE §10 #3): a literal colour scale may be 1.0 or 255 per channel (only shows away from white). Type 12's
// luminance weights are not in the notes; Rec.709 is what the range clamp uses (light.json formulas).
export function colorBlend(type, s, t) {
  const out = [0, 0, 0];
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

/** particles 0x1803786f0 SetupOldStyleAttenuation(q = 1 - lin, l = lin, c = 0); scale multiplies the colour. */
export function oldStyleAttenuation(linearity) {
  const eps = f32(0.001);
  let q = f32(1 - f32(linearity)), l = f32(linearity), c = 0;
  if (q < eps) q = 0;
  if (l < eps) l = 0;
  if (c < eps) { c = 0; if (l < eps && q < eps) c = 1; }
  return { c, l, q, scale: f32(f32(f32(q * 10000) + f32(l * 100)) + c) };
}

// particles 0x1803774b0 RecalculateDerivedValues(desc, 0.001), only when constant == 0: the range is
// cut to where luminance(C) * atten(d) = 0.001 (light.json formulas.range).
function rangeClamp(R, C, { c, l, q }) {
  const lum = lum709(C);
  let dthr = 0;
  if (lum > 0) {
    const kk = 0.001 / lum, A = kk * q, B = kk * l, Cc = kk * c - 1;
    let roots;
    if (A === 0) roots = B !== 0 ? [-Cc / B] : [0];
    else {
      const disc = B * B - 4 * A * Cc;
      roots = disc >= 0 ? [(Math.sqrt(disc) - B) / (2 * A), (-B - Math.sqrt(disc)) / (2 * A)] : [0];
    }
    dthr = Math.max(0, ...roots);
  }
  if (R > 0 && R <= dthr) dthr = R;
  return dthr;
}

const rad = (deg) => (deg * Math.PI) / 180;

/**
* One particle's light description and barn record (RE §10 "Fields" to "Conversion to a barn light"); null when
* radius, alpha, intensity or range is at most 0. Tint, desaturation and light style default to no-ops:
* UNSETTLED (RE §10 #4) feeds the first two, and no catalog look names a style.
*/
export function particleLightToBarn(o) {
  const R0 = o.radius * (o.radiusMultiplier ?? 8);
  if (!(o.radius > 0) || !(o.alpha > 0) || !((o.intensity ?? 1) > 0) || !(R0 > 0)) return null;
  const tint = o.tint || [1, 1, 1];
  const scale = o.colorScale || [1, 1, 1];
  // Colour(bytes) into 0x18035f2e0: the blend is clamped to 0-255 bytes first. Truncation, as
  // flashlight.py does; UNSETTLED whether the DLL rounds instead.
  const bytes = colorBlend(o.blendType ?? 0, scale, tint).map((v) => Math.min(255, Math.trunc(255 * v)));
  const desat = o.desaturation ?? 0;
  let C = bytes.map((b) => srgbToLinear(b / 255));
  const L = lum709(C);
  C = C.map((x) => (x + (L - x) * desat) * (o.style ?? 1) * (o.rendererTint ?? 1) * (o.intensity ?? 1) * o.alpha);
  let att, colourScale = 1;
  if ((o.attenuation ?? 'OLD') === 'NEW') {
    const fifty = Math.min(Math.max(o.fifty ?? 0.5, 1.1920929e-07), Math.max(o.zero ?? 1, 2.3841858e-07) - 1.1920929e-07);
    att = newStyleAttenuation(R0 * fifty, R0 * Math.max(o.zero ?? 1, 2.3841858e-07));
  } else {
    att = oldStyleAttenuation(clamp01(o.linearity ?? 0));
    colourScale = att.scale;
    C = C.map((x) => x * colourScale);
  }
  const { c, l, q } = att;
  const R = c === 0 ? rangeClamp(R0, C, att) : R0;
  if (!(R > 0)) return null;
  let m = R * (o.matchPoint ?? 0.15);
  if (m <= 0) m = 100;
  const k = (m * m) / (c + l * m + q * m * m);
  const theta = o.theta ?? 45, phi = o.phi ?? 60;
  const s = R - R * 0.25;
  return {
    type: o.type ?? 'SPOT',
    range: R, rangeBeforeClamp: R0,
    descColor: C, atten: { c, l, q }, solverOk: att.ok ?? true,
    matchDistance: m, k,
    color: C.map((x) => x * k),
    innerT: Math.tan(rad(theta)) / Math.tan(rad(phi)),
    tanPhi: Math.tan(rad(phi)),
    theta, phi,
    // record 0xc8/0xcc: (R/(R - s), 1/(s - R)), s = 0.75R: full to 75% of the range, 0 at it.
    distanceFade: [R / (R - s), 1 / (s - R)],
    diffuse: o.diffuse !== false, specular: o.specular !== false,
  };
}

/**
* The per-pixel barn result without colour (RE §10): k / max(d^2, 1) * smoothstep(0, 1, 4 - 4d/R) *
* smoothstep(0, 1, (1 - r)/(1 - t)), r = tan a / tan phi; zLight is depth along the axis (frustum near 1, far R).
* A POINT light keeps only the distance terms: UNSETTLED, the notes give the spot record alone.
*/
export function barnScalar(b, d, angleDeg = 0, zLight = d * Math.cos(rad(angleDeg))) {
  const dist = smoothstep(0, 1, b.distanceFade[0] + b.distanceFade[1] * d);
  const fall = b.k / Math.max(d * d, 1);
  if (b.type !== 'SPOT') return fall * dist;
  if (zLight < 1 || zLight > b.range || angleDeg >= 90) return 0;
  const r = Math.tan(rad(angleDeg)) / b.tanPhi;
  if (r > 1) return 0;
  const cone = b.innerT < 1 ? smoothstep(0, 1, (1 - r) / (1 - b.innerT)) : 1;
  return fall * dist * cone;
}

/** Source AngleVectors (particles 0x18035db20), degrees: forward and up. */
export function angleVectors(pitch, yaw, roll = 0) {
  const sp = Math.sin(rad(pitch)), cp = Math.cos(rad(pitch));
  const sy = Math.sin(rad(yaw)), cy = Math.cos(rad(yaw));
  const sr = Math.sin(rad(roll)), cr = Math.cos(rad(roll));
  return {
    forward: [cp * cy, cp * sy, -sp],
    right: [-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp],
    up: [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp],
  };
}
