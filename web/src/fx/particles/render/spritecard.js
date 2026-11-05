import * as THREE from 'three';
import { MAX_LIGHTS, FOG_PARS } from '../../../world/lighting.js';

// spritecard.vfx as a ShaderMaterial (RE §3, §4), a line-for-line GLSL port of the dumped combos (PS0 =
// spritecard_vulkan_50_ps_s0_f0.cb.hlsl, VS0 = _vs_s0_f0.cb.hlsl), all in Source space: modelViewMatrix carries
// the axis swap and camera vectors arrive as Source-space uniforms. controls.js fills the cbuffer slots.

// Particles take the scene's barn lights per vertex (VS0:3380-3650: the same g_BarnLights list and cluster cull bits
// csgo_complex reads, RE §8), so they share the world's packed set: world/lighting.js barnUniforms() (cs2Barn*,
// MAX_LIGHTS, ranked by setLights), bound by effects.js setFxCamera(). The gather is lighting.js's cs2Barn() term for
// term (colour x gain x 1/max(d^2, 1) x smoothstep(fade), 0 at d >= R, the cone) with no N.L and no pi: the VS sums
// the light and PS0:689 multiplies the colour by it (RE §8: particles have no N.L). The GLSL twin of barn.js.
export const MAX_BARNS = MAX_LIGHTS;
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
uniform int uOrient;
varying vec4 vUv;
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
  if (iBlend > -0.5) {
    // VS0:1731-1738: zoom lerp, then the texture offset/scale, then into each frame's rect. The
    // crop rect R is taken as the whole frame: the sheet JSON carries cropped rects only.
    float w = iBlend;
    vec2 z = (uvc - 0.5) * clamp(1.0 / VC_c3.y, 0.0, 1.0) + 0.5;
    vec2 l0 = mix(uvc, z, w * 0.5 + 0.5) / VC_c5.zw + VC_c5.xy;
    vec2 l1 = mix(uvc, z, w * 0.5) / VC_c5.zw + VC_c5.xy;
    vUv = vec4(iRect0.xy + l0 * (iRect0.zw - iRect0.xy), iRect1.xy + l1 * (iRect1.zw - iRect1.xy));
    vSheet = vec4(w, 0.0, 1.0, 0.0);
  } else {
    // VS0:1025-1135 with every per-particle scale source NONE: rotate about the centre by VC_c4.w,
    // divide by the scale, add frac(offset + 0.5).
    vec2 q = uvc - 0.5;
    float c4 = cos(VC_c4.w), s4 = sin(VC_c4.w);
    vec2 rq = vec2(q.x * c4 - q.y * s4, q.x * s4 + q.y * c4);
    vUv = vec4(rq / VC_c5.zw + fract(VC_c5.xy + 0.5), 1.0, 1.0);
    vSheet = vec4(-1.0, -1.0, 1.0, 0.0);
  }
  vColor = col;
  vWorld = world;
  vLight = vec4(uAmbient + efxBarnSum(world), 0.0);                         // VS0:3380-3650, in5.w = 0
  gl_Position = efxProject(world);
}
`;

// Ropes are tessellated on the CPU (ropes.js, from basis.js); this VS only lights and projects.
const MESH_VS = /* glsl */`
attribute vec4 uv4;
attribute vec4 color4;
${COMMON_VS}
void main() {
  vUv = uv4;
  vColor = color4;
  vWorld = position;
  vSheet = vec4(-1.0, -1.0, 1.0, 0.0);
  vLight = vec4(uAmbient + efxBarnSum(position), 0.0);
  gl_Position = efxProject(position);
}
`;

// PS0 (static 0, dynamic 0), DIFFUSE texture type. Line numbers are PS0's.
const PS = /* glsl */`
uniform sampler2D uBase;
${FOG_PARS}
uniform vec4 PC_c0, PC_c1, PC_c3, PC_c4, PC_c5, PC_c6, PC_c8, PC_c9;
uniform int PC_c19x, PC_c19y, PC_c19z;
varying vec4 vUv;
varying vec4 vColor;
varying vec3 vWorld;
flat varying vec4 vSheet;
varying vec4 vLight;
float hstep(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float lum601(vec3 c) { return dot(c, vec3(0.2989999949932098, 0.5870000123977661, 0.1140000000596046)); }
float lum709(vec3 c) { return dot(c, vec3(0.2125000059604645, 0.7153999805450439, 0.0720999985933304)); }
void main() {
  bool mod2x = (PC_c19z & 1) != 0;
  vec4 s0 = texture2D(uBase, vUv.xy);                                        // 85-88
  if (mod2x) s0.rgb -= vec3(0.005859375, 0.009765625, 0.005859375);          // 94
  vec4 t = s0;
  if ((PC_c19z & 32768) != 0 && vSheet.x > -1.0) {                           // 106-170
    vec4 s1 = texture2D(uBase, vUv.zw);
    if (mod2x) s1.rgb -= vec3(0.005859375, 0.009765625, 0.005859375);
    if ((PC_c19z & 1024) != 0) t = mix(s0, s1, vSheet.x);
  }
  int chan = PC_c19x & 15;
  int bm = (PC_c19x >> 4) & 15;
  float k = bm == 4 ? 0.0 : 1.0;
  float blendAmt = ((int(PC_c3.z) >> 12) & 1) != 0 ? PC_c8.y * vUv.w : PC_c8.y; // 413-420
  vec4 c = t;                                                                // 422-548
  if (chan == 0) c = vec4(t.rgb, k);
  else if (chan == 2) c = vec4(vec3(k), t.a);
  else if (chan == 4) c = vec4(mix(vec3(1.0), t.rgb, t.a), 1.0);
  else if (chan == 5) c = vec4(mix(vec3(1.0), t.rgb, lum601(t.rgb)), 1.0);
  else if (chan == 6) c = vec4(t.rgb, lum601(t.rgb));
  else if (chan == 7) c = vec4(vec3(k), lum601(t.rgb));
  else if (chan == 8) c = vec4(1.0, 1.0, 1.0, lum601(t.rgb));
  else if (chan == 9) c = vec4(t.r, k * t.r, k * t.r, k);
  else if (chan == 10) c = vec4(k * t.g, t.g, k * t.g, k);
  else if (chan == 11) c = vec4(k * t.b, k * t.b, t.b, k);
  else if (chan == 12) c = vec4(t.r, k * t.r, k * t.r, t.r);
  else if (chan == 13) c = vec4(k * t.g, t.g, k * t.g, t.g);
  else if (chan == 14) c = vec4(k * t.b, k * t.b, t.b, t.b);
  if (bm == 3) c = 1.0 + c;                                                  // 550-596
  else if (bm == 4) c = 1.0 - c;
  else if (bm == 1) c = c * 2.0;
  else if (bm == 5) c = (1.0 + c) * 0.5;
  else if (bm == 6) c = vec4(vec3(lum709(c.rgb)), c.a);
  c = max(mix(vec4(1.0), c, blendAmt), vec4(0.0));                           // 598
  c.rgb *= vColor.rgb;                                                       // 599
  float a0 = c.a;
  if (PC_c0.w < PC_c0.z) c.a = hstep(PC_c0.w, PC_c0.z, a0);                  // 612-614
  if (a0 >= PC_c6.x && a0 <= PC_c6.w) {                                      // 621-642
    float o = a0 <= PC_c6.z ? hstep(PC_c6.x, PC_c6.z, a0) : hstep(PC_c6.w, PC_c6.y, a0);
    c = mix(c, PC_c5, o);
  }
  c.rgb = mix(c.rgb, vec3(lum709(c.rgb)), PC_c9.x);                          // 654
  c = PC_c4 * c;                                                             // 659
  c.a += PC_c8.x;                                                            // 660
  if ((PC_c19z & 1024) != 0) c.a = clamp(c.a, 0.0, 1.0);                     // 664-667
  c.a *= vColor.a;                                                           // 686
  vec3 lit = c.rgb * (vLight.rgb * PC_c0.y + PC_c0.x + vLight.w);            // 689
  float a = (PC_c19z & 524288) != 0 ? clamp(c.a * 128.0, 0.0, 1.0) : c.a;    // 695-702
  vec4 o;
  if (mod2x) {                                                               // 705-713, 803-807
    o = vec4(clamp(mix(vec3(0.5), mix(vec3(0.5), c.rgb, vColor.rgb), a), 0.0, 1.0), a * abs(PC_c1.w));
  } else {
    if ((PC_c19z & 16) != 0) lit *= PC_c1.z;                                 // 718-720 (F_ADDSELF: 1 + add self)
    // 733-790, F_FOG_PARTICLES: rgb = lerp(fogColour * PC_c1.w, rgb, 1 - amount), alpha kept. The world's own fog
    // (world/lighting.js cs2ApplyFog, which mixes toward the colour) gives both terms: mix(rgb, C, t) - C t + w C t.
    if ((PC_c19z & 128) != 0) {
      vec3 fogC = cs2ApplyFog(vec3(0.0), vWorld);
      lit = cs2ApplyFog(lit, vWorld) + (PC_c1.w - 1.0) * fogC;
    }
    lit *= mix(a, 1.0, clamp(-PC_c1.w, 0.0, 1.0));                           // 795
    o = vec4(lit, a * abs(PC_c1.w));                                         // 803
  }
  gl_FragColor = o;
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
 * reads (camera vectors, ambient, the world's barn lights and fog: effects.js fxShared), written once per frame.
 */
export function createSpritecardMaterial(kind, shared, texture) {
  const v4 = () => new THREE.Vector4();
  const uniforms = {
    ...shared,
    uBase: { value: texture },
    uOrient: { value: 0 },
    PC_c19x: { value: 0 }, PC_c19y: { value: 0 }, PC_c19z: { value: 0 },
  };
  for (const k of ['VC_c0', 'VC_c1', 'VC_c2', 'VC_c3', 'VC_c4', 'VC_c5', 'PC_c0', 'PC_c1', 'PC_c3', 'PC_c4', 'PC_c5', 'PC_c6', 'PC_c8', 'PC_c9']) uniforms[k] = { value: v4() };
  const mat = new THREE.ShaderMaterial({
    uniforms,
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
  liveMaterials.add(mat);
  mat.addEventListener('dispose', () => liveMaterials.delete(mat));
  return mat;
}

/** Write one renderer's controls (controls.js) into its material, render state included. */
export function applyControls(mat, ctl) {
  const u = mat.uniforms;
  const set4 = (name, a) => u[name].value.set(a[0], a[1], a[2], a[3]);
  for (const k of ['c0', 'c1', 'c3', 'c4', 'c5', 'c6', 'c8', 'c9']) set4('PC_' + k, ctl.pc[k]);
  for (const k of ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']) set4('VC_' + k, ctl.vc[k]);
  u.PC_c19x.value = ctl.pc.c19x; u.PC_c19y.value = ctl.pc.c19y; u.PC_c19z.value = ctl.pc.c19z;
  u.uOrient.value = ctl.vc.orientation;
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
