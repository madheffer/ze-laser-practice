import * as THREE from 'three';
import { MAX_LIGHTS } from '../../../world/lighting.js';
import { PS } from './spritecard-ps.js';

// spritecard.vfx as a ShaderMaterial (RE §3, §4), a line-for-line GLSL port of the dumped combos (VS0 =
// spritecard_vulkan_50_vs_s0_f0, VSL = _vs_s128_f0 (S_TEXTURE_LAYERS=1; s256 / s384 repeat the layer block); the pixel
// shader is spritecard-ps.js), all in Source space: modelViewMatrix carries the axis swap and camera vectors arrive as
// Source-space uniforms. controls.js fills the cbuffer slots.

// Particles take the scene's barn lights per vertex (VS0:3380-3650: the same g_BarnLights list and cluster cull bits
// csgo_complex reads, RE §8), so they share the world's packed set: world/lighting.js barnUniforms() (cs2Barn*,
// MAX_LIGHTS, ranked by setLights), bound by effects.js setFxCamera(). The gather is lighting.js's cs2Barn() term for
// term (colour x gain x 1/max(d^2, 1) x smoothstep(fade), 0 at d >= R, the cone) with no N.L and no pi: the VS sums
// the light and PS0:689 multiplies the colour by it (RE §8: particles have no N.L). The GLSL twin of barn.js.
export const BARN_GLSL = /* glsl */`
uniform int cs2BarnCount;
uniform vec3 cs2BarnPos[${MAX_LIGHTS}];
uniform vec3 cs2BarnAxis[${MAX_LIGHTS}];
uniform vec3 cs2BarnColor[${MAX_LIGHTS}];
uniform vec4 cs2BarnShape[${MAX_LIGHTS}];  // range, inner t, tan(phi) (< 0 = point), renders specular
uniform vec2 cs2BarnFade[${MAX_LIGHTS}];
uniform float cs2BarnUnit, cs2BarnGain;
float efxStep(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
vec3 efxBarn(int i, vec3 p) {
  vec3 v = (p - cs2BarnPos[i]) * cs2BarnUnit;
  float d = length(v);
  vec4 s = cs2BarnShape[i];
  if (d >= s.x) return vec3(0.0);
  float fall = efxStep(0.0, 1.0, cs2BarnFade[i].x + cs2BarnFade[i].y * d) / max(d * d, 1.0);
  float cone = 1.0;
  if (s.z >= 0.0) {
    float z = dot(v, cs2BarnAxis[i]);
    float c = z / max(d, 1e-6);
    float r = sqrt(max(0.0, 1.0 - c * c)) / max(c, 1e-6) / s.z;
    cone = (z < 1.0 || r > 1.0) ? 0.0 : (s.y < 1.0 ? efxStep(0.0, 1.0, (1.0 - r) / max(1.0 - s.y, 1e-6)) : 1.0);
  }
  return cs2BarnColor[i] * cs2BarnGain * fall * cone;
}
vec3 efxBarnSum(vec3 p) {
  vec3 L = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) { if (i >= cs2BarnCount) break; L += efxBarn(i, p); }
  return L;
}
`;

const COMMON_VS = /* glsl */`
uniform vec3 uCamPos, uCamUp, uCamFwd;
uniform vec3 uAmbient;
uniform vec4 VC_c0, VC_c1, VC_c2, VC_c3, VC_c4, VC_c5;
uniform vec4 uLayerOS[3];   // layers 1-3: offset U/V, scale U/V (VSL VC_c6.. as VC_c5 for the base layer)
uniform vec2 uLayerRZ[3];   // layers 1-3: UV rotation, zoom
uniform int uOrient;
varying vec4 vUv;
#if LAYERS > 1
varying vec4 vUv1;
#endif
#if LAYERS > 2
varying vec4 vUv2;
#endif
#if LAYERS > 3
varying vec4 vUv3;
#endif
#if MOTION
varying vec4 vUvM;
#endif
varying vec4 vColor;
varying vec3 vWorld;
flat varying vec4 vSheet;
varying vec4 vLight;
${BARN_GLSL}
vec3 srgb2lin(vec3 c) { return mix(c * 0.077399380505084991, pow(c * 0.947867333889007568 + 0.052132703363895416, vec3(2.4)), step(vec3(0.04045), c)); }
// Depth bias (VS0:3335-3337): depth comes from pos + camFwd * VC_c1.x, x/y/w from pos. The D3D
// min(0.001, z) near guard has no GL counterpart and is left out.
vec4 efxProject(vec3 p) {
  vec4 cp = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  if (VC_c1.x != 0.0) { vec4 b = projectionMatrix * modelViewMatrix * vec4(p + uCamFwd * VC_c1.x, 1.0); cp.z = cp.w * (b.z / b.w); }
  return cp;
}
// One layer's UV (VS0:1025-1135 / 1731-1738; VSL:4300-4470 for layer 1 with its own VC_c6, zoom and sheet rows).
// With a sheet (w > -0.5): the zoom lerp, then offset/scale, into each frame's rect (the crop rect R is taken as the
// whole frame: the sheet JSON carries cropped rects only). Without: rotate about the centre, divide by the scale,
// add frac(offset + 0.5). Every per-particle scale source is NONE (controls.js reports the others).
vec4 efxLayerUV(vec2 uvc, vec4 os, float rot, float zoom, vec4 r0, vec4 r1, float w) {
  if (w > -0.5) {
    vec2 z = (uvc - 0.5) * clamp(1.0 / zoom, 0.0, 1.0) + 0.5;
    vec2 l0 = mix(uvc, z, w * 0.5 + 0.5) / os.zw + os.xy;
    vec2 l1 = mix(uvc, z, w * 0.5) / os.zw + os.xy;
    return vec4(r0.xy + l0 * (r0.zw - r0.xy), r1.xy + l1 * (r1.zw - r1.xy));
  }
  vec2 q = uvc - 0.5;
  float c = cos(rot), s = sin(rot);
  return vec4(vec2(q.x * c - q.y * s, q.x * s + q.y * c) / os.zw + fract(os.xy + 0.5), 1.0, 1.0);
}
`;

const SPRITE_VS = /* glsl */`
attribute vec2 corner;
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec4 iRot;      // roll, yaw, pitch, radius (T3)
attribute vec3 iNormal;   // T4
attribute vec4 iRect0;
attribute vec4 iRect1;
attribute float iBlend;   // sheet blend weight, < -0.5 without a sheet
// only what the combo reads is declared: WebGL allows 16 vertex attributes, some drivers count declared ones
#if LAYERS > 1
attribute vec3 iLBlend;   // layers 1-3: sheet blend weights
attribute vec4 iL1a, iL1b;  // layer 1's frame rects
#endif
#if LAYERS > 2
attribute vec4 iL2a, iL2b;
#endif
#if LAYERS > 3
attribute vec4 iL3a, iL3b;
#endif
#if MOTION
attribute vec4 iMa, iMb;  // the motion-vector texture's two frame rects (PSM input_6; UNSETTLED: VS s160 not ported, raw frame UVs)
#endif
${COMMON_VS}
void main() {
  vec3 centre = iPos;
  vec2 uvc = vec2(corner.x * 0.5 + 0.5, corner.y * -0.5 + 0.5);              // VS0:186
  vec4 col = iColor;
  if (VC_c4.z >= 256.0) col.rgb = srgb2lin(col.rgb);                         // VS0:3129-3158
  vec3 n = (uOrient == 3 || uOrient == 4) ? iNormal : vec3(0.0, 0.0, 1.0);
  vec3 up, right;                                                            // VS0:3194-3260
  if (uOrient == 0) { up = uCamUp; right = cross(uCamFwd, uCamUp); }
  else if (uOrient == 1) { up = vec3(0.0, 0.0, 1.0); right = cross(vec3(0.0, 0.0, 1.0), uCamFwd); }
  else if (uOrient == 2) { up = vec3(1.0, 0.0, 0.0); right = vec3(0.0, -1.0, 0.0); }
  else if (uOrient == 3) {
    up = normalize(cross(n, abs(n.z) > 0.1 ? vec3(0.0, -1.0, 0.0) : vec3(0.0, 0.0, 1.0)));
    right = cross(up, n);
    col.a *= 1.0 - efxStep(VC_c2.x, VC_c2.y, abs(dot(normalize(n), normalize(uCamPos - centre))));
  } else {
    up = normalize(cross(n, uCamFwd)); right = normalize(n);
    col.a *= 1.0 - efxStep(VC_c2.x, VC_c2.y, abs(dot(normalize(n), normalize(uCamPos - centre))));
  }
  float cr = cos(iRot.x), sr = sin(iRot.x);                                  // VS0:3271-3294
  vec3 a = up * cr - right * sr;
  float cy = cos(iRot.y), sy = sin(iRot.y), k = 1.0 - cy;
  mat3 R = mat3(a.x * a.x + (1.0 - a.x * a.x) * cy, a.x * a.y * k + a.z * sy, a.z * a.x * k - a.y * sy,
                a.x * a.y * k - a.z * sy, a.y * a.y + (1.0 - a.y * a.y) * cy, a.y * a.z * k + a.x * sy,
                a.z * a.x * k + a.y * sy, a.y * a.z * k - a.x * sy, a.z * a.z + (1.0 - a.z * a.z) * cy);
  vec3 off = (R * (right * cr + up * sr)) * (corner.x + VC_c1.y) + a * (corner.y + VC_c1.z);
  float r = iRot.w;
  float d = length(uCamPos - centre);
  if (VC_c2.z > 0.0) {                                                       // VS0:3300-3321
    if (r > VC_c0.y * d) col = r > VC_c0.z * d ? vec4(0.0) : col * (1.0 - (r - VC_c0.y * d) / (d * (VC_c0.z - VC_c0.y)));
    r = min(max(r, VC_c0.x * d), VC_c0.w * d);
  }
  vec3 world = centre + off * (col.a < 0.0039215688593685627 ? 0.0 : r);     // VS0:3329
  vUv = efxLayerUV(uvc, VC_c5, VC_c4.w, VC_c3.y, iRect0, iRect1, iBlend);
#if LAYERS > 1
  vSheet = vec4(iBlend > -0.5 ? iBlend : -1.0, iLBlend.x > -0.5 ? iLBlend.x : -1.0, iLBlend.y > -0.5 ? iLBlend.y : -1.0, iLBlend.z > -0.5 ? iLBlend.z : -1.0);
#else
  vSheet = vec4(iBlend > -0.5 ? iBlend : -1.0, -1.0, -1.0, -1.0);
#endif
#if LAYERS > 1
  vUv1 = efxLayerUV(uvc, uLayerOS[0], uLayerRZ[0].x, uLayerRZ[0].y, iL1a, iL1b, iLBlend.x);
#endif
#if LAYERS > 2
  vUv2 = efxLayerUV(uvc, uLayerOS[1], uLayerRZ[1].x, uLayerRZ[1].y, iL2a, iL2b, iLBlend.y);
#endif
#if LAYERS > 3
  vUv3 = efxLayerUV(uvc, uLayerOS[2], uLayerRZ[2].x, uLayerRZ[2].y, iL3a, iL3b, iLBlend.z);
#endif
#if MOTION
  vUvM = vec4(iMa.xy + uvc * (iMa.zw - iMa.xy), iMb.xy + uvc * (iMb.zw - iMb.xy));
#endif
  vColor = col;
  vWorld = world;
  vLight = vec4(uAmbient + efxBarnSum(world), 0.0);                         // VS0:3380-3650, in5.w = 0
  gl_Position = efxProject(world);
}
`;

// Ropes and trails are tessellated on the CPU (ropes.js / trails.js); this VS only lights and projects. Their extra
// layers read the strip's UV. UNSETTLED: the trail combo's per-layer UVs (S_DRAW_AS_TRAIL with layers not dumped).
const MESH_VS = /* glsl */`
attribute vec4 uv4;
attribute vec4 color4;
${COMMON_VS}
void main() {
  vUv = uv4;
#if LAYERS > 1
  vUv1 = uv4;
#endif
#if LAYERS > 2
  vUv2 = uv4;
#endif
#if LAYERS > 3
  vUv3 = uv4;
#endif
  vColor = color4;
  vWorld = position;
  vSheet = vec4(-1.0);
  vLight = vec4(uAmbient + efxBarnSum(position), 0.0);
  gl_Position = efxProject(position);
}
`;

const FACTOR = {
  ONE: THREE.OneFactor, ZERO: THREE.ZeroFactor, DEST_COLOR: THREE.DstColorFactor, SRC_COLOR: THREE.SrcColorFactor,
  INV_SRC_ALPHA: THREE.OneMinusSrcAlphaFactor, INV_DEST_ALPHA: THREE.OneMinusDstAlphaFactor,
};
const EQUATION = { ADD: THREE.AddEquation, MAX: THREE.MaxEquation };

// Every live spritecard material, so effects.js can point them all at a newly bound lighting set (setFxCamera).
export const liveMaterials = new Set();

/**
 * A spritecard material. `shared` holds the per-frame uniforms every particle material of a side
 * reads (camera vectors, ambient, the world's barn lights and fog, the scene copy: effects.js fxShared).
 */
export function createSpritecardMaterial(kind, shared, texture) {
  const v4 = () => new THREE.Vector4();
  const uniforms = {
    ...shared,
    uBase: { value: texture }, uLayer1: { value: texture }, uLayer2: { value: texture }, uLayer3: { value: texture },
    uMotion: { value: texture },
    uOrient: { value: 0 },
    uLayerOS: { value: [v4().set(0, 0, 1, 1), v4().set(0, 0, 1, 1), v4().set(0, 0, 1, 1)] },
    uLayerRZ: { value: [new THREE.Vector2(0, 1), new THREE.Vector2(0, 1), new THREE.Vector2(0, 1)] },
    uRefractTaps: { value: Array.from({ length: 25 }, () => v4()) }, uRefractTapCount: { value: 0 },
    PC_c19x: { value: 0 }, PC_c19y: { value: 0 }, PC_c19z: { value: 0 },
  };
  for (const k of ['VC_c0', 'VC_c1', 'VC_c2', 'VC_c3', 'VC_c4', 'VC_c5', 'PC_c0', 'PC_c1', 'PC_c2', 'PC_c3', 'PC_c4', 'PC_c5',
    'PC_c6', 'PC_c8', 'PC_c9', 'PC_c10', 'PC_c11']) uniforms[k] = { value: v4() };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    defines: { LAYERS: 1, FEATHER: 0, REFRACT: 0, MOTION: 0 },
    vertexShader: kind === 'sprite' ? SPRITE_VS : MESH_VS,
    fragmentShader: PS,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    blending: THREE.CustomBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  mat.userData.kind = kind;
  liveMaterials.add(mat);
  mat.addEventListener('dispose', () => liveMaterials.delete(mat));
  return mat;
}

/** Write one renderer's controls (controls.js) into its material, render state and shader defines included. */
export function applyControls(mat, ctl) {
  const u = mat.uniforms;
  const set4 = (name, a) => u[name].value.set(a[0], a[1], a[2], a[3]);
  for (const k of ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c8', 'c9', 'c10', 'c11']) set4('PC_' + k, ctl.pc[k]);
  for (const k of ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']) set4('VC_' + k, ctl.vc[k]);
  u.PC_c19x.value = ctl.pc.c19x; u.PC_c19y.value = ctl.pc.c19y; u.PC_c19z.value = ctl.pc.c19z;
  u.uOrient.value = ctl.vc.orientation;
  ctl.layers.slice(1, 4).forEach((l, i) => { u.uLayerOS.value[i].set(...l.os); u.uLayerRZ.value[i].set(l.rot, l.zoom); });
  const taps = ctl.refractTaps || [];
  taps.slice(0, 25).forEach((t, i) => u.uRefractTaps.value[i].set(t[0], t[1], t[2], 0));
  u.uRefractTapCount.value = Math.min(25, taps.length);
  const d = mat.defines, layers = Math.max(1, Math.min(4, ctl.layers.length)), feather = ctl.feather ? 1 : 0, refract = ctl.refract ? 1 : 0;
  // motion vectors on sprites only: no dumped trail combo carries S_MOTION_VECTORS
  // (and with at most 3 layers: 4 layers + motion would pass WebGL's 16 vertex attributes; the dumped motion combos have 2)
  const motion = ctl.motion && mat.userData.kind === 'sprite' && layers < 4 ? 1 : 0;
  if (d.LAYERS !== layers || d.FEATHER !== feather || d.REFRACT !== refract || d.MOTION !== motion) {
    d.LAYERS = layers; d.FEATHER = feather; d.REFRACT = refract; d.MOTION = motion; mat.needsUpdate = true;
  }
  const s = ctl.state;
  mat.blendEquation = EQUATION[s.blendOp];
  mat.blendSrc = FACTOR[s.src];
  mat.blendDst = FACTOR[s.dst];
  mat.blendEquationAlpha = EQUATION[s.blendOpAlpha];
  mat.blendSrcAlpha = FACTOR[s.srcAlpha];
  mat.blendDstAlpha = FACTOR[s.dstAlpha];
  mat.depthWrite = s.depthWrite;
  mat.depthFunc = s.depthFunc === 'ALWAYS' ? THREE.AlwaysDepth : THREE.LessEqualDepth;
}

/** Does some live particle material read the scene copy (world/scenecopy.js): depth feathering or refraction. */
export function sceneCopyWanted() {
  for (const m of liveMaterials) if (m.defines.FEATHER || m.defines.REFRACT) return true;
  return false;
}

const LAYER_UNIFORMS = ['uBase', 'uLayer1', 'uLayer2', 'uLayer3'];
/**
 * Point a material's layer samplers at the controls' textures (assets: effects.js MapEffects.assets()); a layer with
 * m_bReplaceTextureWithGradient samples its gradient as a 1D strip (gradientTexture).
 */
export function bindTextures(mat, ctl, assets) {
  LAYER_UNIFORMS.forEach((name, k) => {
    const l = ctl.layers[k];
    const tex = l?.gradient ? gradientTexture(l.gradient) : l?.texture ? assets.texture(l.texture, l.clamp) : null;
    mat.uniforms[name].value = tex || whiteTexture();
  });
  mat.uniforms.uMotion.value = (ctl.motion && assets.texture(ctl.motion.texture, ctl.motion.clamp)) || whiteTexture();
}

// A texture group's m_Gradient as a 256 x 1 sRGB strip: the stops' colours (0-255) lerped by position, clamped at the
// ends. UNSETTLED: the game bakes the gradient C++ side (its width and the colour space of the lerp are not read).
const gradients = new Map();
export function gradientTexture(gradient) {
  const stops = (gradient?.m_Stops || []).filter((s) => Array.isArray(s?.m_Color))
    .slice().sort((a, b) => (a.m_flPosition ?? 0) - (b.m_flPosition ?? 0));
  const key = JSON.stringify(stops);
  if (gradients.has(key)) return gradients.get(key);
  const W = 256, data = new Uint8Array(W * 4);
  for (let x = 0; x < W && stops.length; x++) {
    const t = x / (W - 1);
    let j = 0;
    while (j < stops.length - 1 && (stops[j + 1].m_flPosition ?? 0) <= t) j++;
    const a = stops[j], b = stops[Math.min(j + 1, stops.length - 1)];
    const pa = a.m_flPosition ?? 0, pb = b.m_flPosition ?? 0;
    const f = t <= pa ? 0 : pb > pa ? Math.min(1, (t - pa) / (pb - pa)) : 0;
    for (let q = 0; q < 3; q++) data[4 * x + q] = Math.round((a.m_Color[q] ?? 0) + ((b.m_Color[q] ?? 0) - (a.m_Color[q] ?? 0)) * f);
    data[4 * x + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  gradients.set(key, tex);
  return tex;
}

// A missing texture (a stock vtex no game pak supplied) samples white; the stage reports it.
let white = null;
export function whiteTexture() {
  if (!white) {
    white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.colorSpace = THREE.SRGBColorSpace;
    white.needsUpdate = true;
  }
  return white;
}
