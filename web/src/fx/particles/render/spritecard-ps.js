import { FOG_PARS } from '../../../world/lighting.js';

// The spritecard pixel shader, a GLSL port of the dumped combos (VRF 20.1, csgo shaders_vulkan_dir.vpk; cbuffer
// members renamed by packoffset, scratch tools in tools/particles/PORTING.md). Line numbers cite:
//   PS0  spritecard_vulkan_50_ps_s0_f0     (no layers)
//   PSL  spritecard_vulkan_50_ps_s1024_f0  (S_TEXTURE_LAYERS=1; s2048 / s3072 repeat the layer-1 block per layer)
//   PSF  spritecard_vulkan_50_ps_s0_f1     (D_DEPTH_FEATHERING=1)
//   PSR  spritecard_vulkan_50_ps_s64_f0    (S_REFRACT=1)
//   PSM  spritecard_vulkan_50_ps_s1056_f0  (S_MOTION_VECTORS=1, S_TEXTURE_LAYERS=1)
// Defines: LAYERS (1-4 colour layers), FEATHER, REFRACT, MOTION. Layer k reads its blend / zoom / distortion from
// PC_c(8+k).yzw, its clamp bit k and no-sheet bit 12+k from PC_c3.z, its channel / blend from PC_c19.x (8 bits a
// layer) and its type from PC_c19.y >> (16 + 3k) & 15: FUN_1802c0450 packs them that way (controls.js).

export const PS = /* glsl */`
uniform sampler2D uBase;
#if LAYERS > 1
uniform sampler2D uLayer1;
varying vec4 vUv1;
#endif
#if LAYERS > 2
uniform sampler2D uLayer2;
varying vec4 vUv2;
#endif
#if LAYERS > 3
uniform sampler2D uLayer3;
varying vec4 vUv3;
#endif
${FOG_PARS}
uniform vec4 PC_c0, PC_c1, PC_c2, PC_c3, PC_c4, PC_c5, PC_c6, PC_c8, PC_c9, PC_c10, PC_c11;
uniform int PC_c19x, PC_c19y, PC_c19z;
#if FEATHER || REFRACT
uniform sampler2D uSceneColor, uSceneDepth;  // world/scenecopy.js: the frame after opaques
uniform vec2 uViewport;                      // drawing-buffer size in pixels
uniform vec2 uNearFar;
#endif
#if REFRACT
uniform vec4 uRefractTaps[25];               // xy texel offset, z weight (FilterTaps_t c6)
uniform int uRefractTapCount;
#endif
#if MOTION
uniform sampler2D uMotion;                   // the ANIMMOTIONVEC group's texture (g_tMotionVectors)
varying vec4 vUvM;                           // its two frames' UVs (PSM input_6)
#endif
varying vec4 vUv;
varying vec4 vColor;
varying vec3 vWorld;
flat varying vec4 vSheet;
varying vec4 vLight;
const vec3 MOD2X_BIAS = vec3(0.005859375, 0.009765625, 0.005859375);
float hstep(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float lum601(vec3 c) { return dot(c, vec3(0.2989999949932098, 0.5870000123977661, 0.1140000000596046)); }
float lum709(vec3 c) { return dot(c, vec3(0.2125000059604645, 0.7153999805450439, 0.0720999985933304)); }
vec3 srgbEnc(vec3 c) { return mix(c * 12.920000076293945, pow(max(c, vec3(0.0)), vec3(0.4166666567325592)) * 1.0549999475479126 - 0.054999999701976776, step(vec3(0.0031308000907301903), c)); }
// _500[15] (PSL:437): the 1D colour lookup's premultiply / alpha selectors by channel mix
vec2 lookupSel(int ch) {
  if (ch == 0 || ch == 4 || ch == 5 || ch == 9 || ch == 10 || ch == 11) return vec2(1.0, 0.0);
  if (ch == 2 || ch == 7) return vec2(0.0, 1.0);
  return vec2(0.0);
}
// _2797[15].y (PSL:324): channel mixes whose alpha comes from the texture's green (3 RGB_A, 8 RGB_A_RGBALPHA)
float alphaKeep(int ch) { return (ch == 3 || ch == 8) ? 0.0 : 1.0; }
// a layer's texel with the sheet's frame blend (PS0:85-170, PSL:199-275); the MOD2X bias is the base layer's only
vec4 efxFetch(sampler2D t, vec4 uv, float w, bool base) {
  bool mod2x = (PC_c19z & 1) != 0;
#if MOTION
  // PSM:85-122, 255-268: with a sheet, each frame's UV moves along the motion texture's .yw (2x - 1) x PC_c3.xy, the
  // first by the frame blend, the second by 1 - blend (clamped by layer 0's clamp bit, as the base texture)
  if ((PC_c19z & 32768) != 0 && w > -1.0) {
    vec2 m0 = texture2D(uMotion, vUvM.xy).yw * 2.0 - 1.0, m1 = texture2D(uMotion, vUvM.zw).yw * 2.0 - 1.0;
    uv = vec4(uv.xy - m0 * PC_c3.xy * w, uv.zw + m1 * PC_c3.xy * (1.0 - w));
  }
#endif
  vec4 s0 = texture2D(t, uv.xy);
  if (base && mod2x) s0.rgb -= MOD2X_BIAS;
  if ((PC_c19z & 32768) != 0 && w > -1.0) {
    vec4 s1 = texture2D(t, uv.zw);
    if (base && mod2x) s1.rgb -= MOD2X_BIAS;
    if ((PC_c19z & 1024) != 0) return mix(s0, s1, w);
  }
  return s0;
}
// one layer's texture type (PS0:194, PSL:286-503 base, 697-913 layer 1): L its own texel, A what earlier layers made
// (the base layer passes its own texel), luv its UV, buv the base layer's UV, zd = PC_c(8+k).zw
vec4 efxType(int type, int ch, sampler2D t, vec4 L, vec4 A, vec4 luv, vec4 buv, vec2 zd) {
  if (type == 1 || type == 4) {
    float f = fract(zd.x * luv.z);
    float g = f / (-0.39999997615814209 * (1.0 - f) + 1.0);
    vec4 q = luv - 0.5;
    vec4 Z = mix(texture2D(t, (q * mix(1.0, 0.0625, g) + 0.5).xy), texture2D(t, (q * mix(4.0, 1.0, g) + 0.5).xy), g * g);
    if (type == 1) { Z.w = mix(A.w, Z.w, alphaKeep(ch)); return Z; }
    vec2 e = srgbEnc(Z.rgb).xy;
    return texture2D(uBase, buv.xy - (e - 0.5) * 2.0 * (zd.y * luv.w * 0.125 * mix(A.w, Z.w, alphaKeep(ch))));
  }
  if (type == 3) {
    vec2 e = srgbEnc(L.rgb).xy;
    return texture2D(uBase, buv.xy - (e - 0.5) * 2.0 * (zd.y * luv.w * 0.125 * L.w));
  }
  if (type == 2) {
    vec2 s = lookupSel(ch);
    vec4 q = mix(mix(vec4(A.rgb * A.a, 1.0), A, s.x), vec4(A.a), s.y);
    vec4 c = texture2D(t, vec2((lum709(srgbEnc(q.rgb)) + luv.x) * luv.z, luv.y));
    return mix(vec4(c.rgb, A.w), vec4(c.rgb, lum601(c.rgb)), s.y);
  }
  return L;
}
// channel mix (PS0:422-548, PSL:514-640)
vec4 efxChannels(int chan, int bm, vec4 t) {
  float k = bm == 4 ? 0.0 : 1.0;
  if (chan == 0) return vec4(t.rgb, k);
  if (chan == 2) return vec4(vec3(k), t.a);
  if (chan == 4) return vec4(mix(vec3(1.0), t.rgb, t.a), 1.0);
  if (chan == 5) return vec4(mix(vec3(1.0), t.rgb, lum601(t.rgb)), 1.0);
  if (chan == 6) return vec4(t.rgb, lum601(t.rgb));
  if (chan == 7) return vec4(vec3(k), lum601(t.rgb));
  if (chan == 8) return vec4(1.0, 1.0, 1.0, lum601(t.rgb));
  if (chan == 9) return vec4(t.r, k * t.r, k * t.r, k);
  if (chan == 10) return vec4(k * t.g, t.g, k * t.g, k);
  if (chan == 11) return vec4(k * t.b, k * t.b, t.b, k);
  if (chan == 12) return vec4(t.r, k * t.r, k * t.r, t.r);
  if (chan == 13) return vec4(k * t.g, t.g, k * t.g, t.g);
  if (chan == 14) return vec4(k * t.b, k * t.b, t.b, t.b);
  return t;
}
// the base layer's blend (PS0:550-598): against 1
vec4 efxBlend0(int bm, vec4 c) {
  if (bm == 3) return 1.0 + c;
  if (bm == 4) return 1.0 - c;
  if (bm == 1) return c * 2.0;
  if (bm == 5) return (1.0 + c) * 0.5;
  if (bm == 6) return vec4(vec3(lum709(c.rgb)), c.a);
  return c;
}
// a later layer's blend against what the earlier layers made (PSL:1050-1100)
vec4 efxBlendN(int bm, vec4 acc, vec4 c) {
  if (bm == 0) return acc * c;
  if (bm == 3) return acc + c;
  if (bm == 4) return acc - c;
  if (bm == 1) return acc * (c * 2.0);
  if (bm == 5) return (acc + c) * 0.5;
  if (bm == 6) return vec4(acc.rgb * lum709(c.rgb), c.a);
  return c;
}
#define EFX_LAYER(K, TEX, LUV, W, CB) { \\
  vec4 L = efxFetch(TEX, LUV, W, false); \\
  int ch = (PC_c19x >> (8 * K)) & 15, bm = (PC_c19x >> (8 * K + 4)) & 15, ty = (PC_c19y >> (16 + 3 * K)) & 15; \\
  vec4 r = efxChannels(ch, bm, efxType(ty, ch, TEX, L, acc, LUV, vUv, CB.zw)); \\
  float amt = ((int(PC_c3.z) >> (12 + K)) & 1) != 0 ? CB.y * LUV.w : CB.y; \\
  acc = max(mix(acc, efxBlendN(bm, acc, r), amt), 0.0); }
void main() {
  bool mod2x = (PC_c19z & 1) != 0;
  vec4 base = efxFetch(uBase, vUv, vSheet.x, true);
  int chan = PC_c19x & 15, bm = (PC_c19x >> 4) & 15, ty = (PC_c19y >> 16) & 15;
  vec4 c0 = efxChannels(chan, bm, efxType(ty, chan, uBase, base, base, vUv, vUv, PC_c8.zw));
  float amt0 = ((int(PC_c3.z) >> 12) & 1) != 0 ? PC_c8.y * vUv.w : PC_c8.y;        // PS0:413-420
  vec4 acc = max(mix(vec4(1.0), efxBlend0(bm, c0), amt0), vec4(0.0));            // PS0:598
#if LAYERS > 1
  EFX_LAYER(1, uLayer1, vUv1, vSheet.y, PC_c9)
#endif
#if LAYERS > 2
  EFX_LAYER(2, uLayer2, vUv2, vSheet.z, PC_c10)
#endif
#if LAYERS > 3
  EFX_LAYER(3, uLayer3, vUv3, vSheet.w, PC_c11)
#endif
  vec4 c = acc;
#if FEATHER || REFRACT
  vec2 screen = gl_FragCoord.xy / uViewport;
#endif
#if REFRACT
  // PSR:618-660: the texel is a normal; the frame copy is sampled where it points, blurred by the filter taps
  vec2 ruv = screen - (c.xy - 0.5) * 2.0 * (PC_c2.x * c.w);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 25; i++) { if (i >= uRefractTapCount) break; sum += texture2D(uSceneColor, ruv + uRefractTaps[i].xy / uViewport) * uRefractTaps[i].z; }
  c.rgb = sum.rgb;
#endif
  c.rgb *= vColor.rgb;                                                         // PS0:599
  float a0 = c.a;
  if (PC_c0.w < PC_c0.z) c.a = hstep(PC_c0.w, PC_c0.z, a0);                  // PS0:612-614
  if (a0 >= PC_c6.x && a0 <= PC_c6.w) {                                      // PS0:621-642
    float o = a0 <= PC_c6.z ? hstep(PC_c6.x, PC_c6.z, a0) : hstep(PC_c6.w, PC_c6.y, a0);
    c = mix(c, PC_c5, o);
  }
#if FEATHER
  float featherAlpha = c.a;                                                  // PSF:700 (_19283.w)
#endif
  c.rgb = mix(c.rgb, vec3(lum709(c.rgb)), PC_c9.x);                          // PS0:654
  c = PC_c4 * c;                                                             // PS0:659
  c.a += PC_c8.x;                                                            // PS0:660
  if ((PC_c19z & 1024) != 0) c.a = clamp(c.a, 0.0, 1.0);                     // PS0:664-667
  c.a *= vColor.a;                                                           // PS0:686
#if FEATHER
  {
    // PSF:699-711: the scene point on this pixel's ray at the depth buffer's view depth; alpha fades over
    // [PC_c1.x, PC_c1.y] of distance, less an offset for thin texels (and the sprite's rim without a sheet)
    float d = texture2D(uSceneDepth, screen).r;
    float n = uNearFar.x, f = uNearFar.y;
    float viewZ = (n * f) / ((f - n) * d - f);                               // three perspectiveDepthToViewZ
    vec3 v = vWorld - cameraPosition;
    vec3 fwd = normalize((inverse(viewMatrix) * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
    vec3 scenePoint = cameraPosition + v * (-viewZ / max(dot(fwd, v), 1e-4));
    bool noSheet = (PC_c19z & 32768) == 0;
    float off = (1.0 - featherAlpha) + (noSheet ? length(vUv.xy * 2.0 - 1.0) : 0.0);
    c.a *= clamp((distance(vWorld, scenePoint) - off * (PC_c1.y * PC_c2.y) / (noSheet ? 2.0 : 1.0) - PC_c1.x) / (PC_c1.y - PC_c1.x), 0.0, 1.0);
  }
#endif
  vec3 lit = c.rgb * (vLight.rgb * PC_c0.y + PC_c0.x + vLight.w);            // PS0:689
  float a = (PC_c19z & 524288) != 0 ? clamp(c.a * 128.0, 0.0, 1.0) : c.a;    // PS0:695-702
  vec4 o;
  if (mod2x) {                                                               // PS0:705-713, 803-807
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
