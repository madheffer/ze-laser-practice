// What the two CS2 water shaders (water-fancy.js, water-basic.js) share: reading a vmat's parameters with the
// shader's defaults, and the material options every water surface draws with.
import * as THREE from 'three';

export const num = (v, d) => (Number.isFinite(+v) ? +v : d);

// sRGB -> linear (CS2's SrgbGammaToLinear)
export const srgbToLinear = (c) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));

// a vmat vector, its missing components from `def`, the first three decoded from sRGB when `srgb`
export function vec(v, def, srgb) {
  const a = def.map((d, i) => num(Array.isArray(v) ? v[i] : undefined, d));
  if (srgb) for (let i = 0; i < 3; i++) a[i] = srgbToLinear(a[i]);
  return a.length === 2 ? new THREE.Vector2(...a) : a.length === 3 ? new THREE.Vector3(...a) : new THREE.Vector4(...a);
}

// a one-texel texture (a slot the bake has no file for)
export function texel(rgba, srgb, array = false) {
  const t = array ? new THREE.DataArrayTexture(new Uint8Array(rgba), 1, 1, 1) : new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// the vmat's floats / ints / vectors as uniforms, each with the shader's default when the vmat leaves it out
export function paramUniforms(vmat, { floats = {}, ints = {}, vectors = {} }) {
  const F = vmat.FloatParams || {}, I = vmat.IntParams || {}, V = vmat.VectorParams || {};
  const u = {};
  for (const [k, d] of Object.entries(floats)) u[k] = { value: num(F[k], d) };
  for (const [k, d] of Object.entries(ints)) u[k] = { value: Math.round(num(I[k], d)) };
  for (const [k, [d, srgb]] of Object.entries(vectors)) u[k] = { value: vec(V[k], d, srgb) };
  return u;
}

// drawn after the opaques and the scene copy marker (world/scenecopy.js), since both shaders read the frame behind
// the water; their output is opaque
export const waterMaterialOptions = (src) => ({ transparent: true, blending: THREE.NoBlending, depthWrite: true, side: src.side });
