// The spritecard flag words, as particles.dll builds them for the procedural spritecard (no three.js; node tests it).
//
// One uint, CBaseRendererSource2 +0x2cc8, reaches the GPU twice: SpriteCardPixelControls_t c19.z and
// SpritecardVertexControls_t c16.w (particles.dll md5 63babcbf3245e56855a777134323e74a: FUN_1802c7600 writes it to
// PC +0x138 and VC +0x10c). It is built by FUN_1802c9670 (every renderer) and the class's slot 70 (sprites:
// FUN_1802cb440) through FUN_1802c94f0(index, on): on the procedural path (DAT_18065af43 set) feature index i >= 0x11
// sets bit (DAT_18052c440[i] - 0x13); the names are PTR_s_UNUSED_18052aa00[i]. Indices below 0x11 are real shader
// combos (F_TEXTURE_LAYERS, F_REFRACT, F_DISABLE_DEPTHTEST, F_LIGHTEN_MODE, ...).
//
// The second word, +0x2d18, is PC c3.z (FUN_1802c32b0 writes it, FUN_1802c0450 builds it).

export const FLAG = {
  MOD2X: 0x1,                          // 0x11, output blend MOD2X
  // 0x12 F_PARTICLE_ORIENTATION: orientation << 1 (slot 70), bits 1..3
  ADDSELF: 0x10,                       // 0x13
  SATURATE_COLOR_PRE_ALPHA_BLEND: 0x20,// 0x14, read by no dumped spritecard combo
  TINT_BY_FOW: 0x40,                   // 0x15, not read by spritecard
  FOG_PARTICLES: 0x80,                 // 0x16, PS0:733
  GLOBAL_LIGHT: 0x100,                 // 0x17, not read by spritecard
  SELF_ILLUM_OVER_1: 0x200,            // 0x18, not read by spritecard
  BLENDFRAMES_SEQ0: 0x400,             // 0x19, PS0:139, 664
  PER_PIXEL_LIGHTING: 0x800,           // 0x1a, VS0:3348 picks the normal output (no PS0 input reads it)
  ANIMATE_IN_FPS: 0x1000,              // 0x1b, VS0:1685
  HAS_NO_NORMAL_FOR_LIGHTING: 0x2000,  // 0x1c
  NUM_SEQUENCES_PER_PARTICLE: 0x8000,  // 0x1e: a texture has a sheet, PS0:106 / VS0:191
  MAXLUMINANCE_BLENDING: 0x10000,      // 0x1f, PS0:141
  ALPHA_REFERENCE: 0x40000,            // 0x21, PS0:606
  REFRACT_SOLID: 0x80000,              // 0x22, PS0:695 hard alpha
};

// PARTICLE_FOG_GAME_DEFAULT reads DAT_18065af47, a byte of particles.dll's manager (0x18065af00) that particles.dll
// only zeroes (0x1800b087a): the game sets it from outside. UNSETTLED: taken as on (CS2's world fog reaches particles).
export const FOG_GAME_DEFAULT = true;

const FOG_TYPES = ['PARTICLE_FOG_GAME_DEFAULT', 'PARTICLE_FOG_ENABLED', 'PARTICLE_FOG_DISABLED'];
const LIGHTING = { PARTICLE_LIGHTING_PER_PARTICLE: 0, PARTICLE_LIGHTING_PER_VERTEX: 1, PARTICLE_LIGHTING_PER_PIXEL: -1 };

/**
 * The value the flag tests read: FUN_1802c9670 / FUN_1802cb440 take a float input's literal when its type is
 * PF_TYPE_LITERAL (+0x10 == 0) and a fixed stand-in otherwise (`other`).
 */
export function literalOr(inp, dflt, other) {
  if (inp == null) return dflt;
  if (typeof inp === 'number') return inp;
  return inp.m_nType === 'PF_TYPE_LITERAL' || inp.m_nType === 0 ? (+inp.m_flLiteralValue || 0) : other;
}

/**
 * c19.z / c16.w for one renderer. `p` has class defaults applied (or is raw: every field falls back to its default),
 * `orient` the orientation index, `output` the output blend index, `hasSheet` whether a texture has a sprite sheet.
 */
export function rendererFlags(p, { orient = 0, output = 0, hasSheet = false } = {}) {
  let f = 0;
  if (output === 5) f |= FLAG.MOD2X;                                                     // FUN_1802c9670 idx 0x11
  f |= (orient & 7) << 1;                                                                 // FUN_1802cb440
  if (literalOr(p.m_flAddSelfAmount, 0, 1) > 0) f |= FLAG.ADDSELF;                        // 0x13: 0 < literal (else 1.0)
  if (p.m_bSaturateColorPreAlphaBlend !== false) f |= FLAG.SATURATE_COLOR_PRE_ALPHA_BLEND;
  if (p.m_bTintByFOW) f |= FLAG.TINT_BY_FOW;
  const fog = typeof p.m_nFogType === 'number' ? p.m_nFogType : Math.max(0, FOG_TYPES.indexOf(p.m_nFogType ?? FOG_TYPES[0]));
  if (fog === 1 || (fog === 0 && FOG_GAME_DEFAULT)) f |= FLAG.FOG_PARTICLES;              // 0x16
  if (p.m_bTintByGlobalLight) f |= FLAG.GLOBAL_LIGHT;
  if (literalOr(p.m_flSelfIllumAmount, 0, 1.1) > 1) f |= FLAG.SELF_ILLUM_OVER_1;          // 0x18: DAT_180534210 = 1.1
  if (p.m_bBlendFramesSeq0 !== false) f |= FLAG.BLENDFRAMES_SEQ0;
  // 0x1a: m_nLightingMode PER_PIXEL (-1) and diffuse > 0.001 (DAT_180534150); a non-literal diffuse reads 1
  const lm = typeof p.m_nLightingMode === 'number' ? p.m_nLightingMode : (LIGHTING[p.m_nLightingMode] ?? 0);
  if (lm === -1 && literalOr(p.m_flDiffuseAmount, 1, 1) > 0.001) f |= FLAG.PER_PIXEL_LIGHTING;
  if (p.m_bAnimateInFPS) f |= FLAG.ANIMATE_IN_FPS;
  if (orient !== 3) f |= FLAG.HAS_NO_NORMAL_FOR_LIGHTING;
  if (hasSheet) f |= FLAG.NUM_SEQUENCES_PER_PARTICLE;
  if (p.m_bMaxLuminanceBlendingSequence0) f |= FLAG.MAXLUMINANCE_BLENDING;
  const alphaRef = (p.m_nPerParticleAlphaReference ?? 'SPRITECARD_TEXTURE_PP_SCALE_NONE') !== 'SPRITECARD_TEXTURE_PP_SCALE_NONE'
    && p.m_nPerParticleAlphaReference !== 0;
  if (alphaRef) f |= FLAG.ALPHA_REFERENCE;
  if (p.m_bRefract && p.m_bRefractSolid) f |= FLAG.REFRACT_SOLID;
  return f >>> 0;
}

/**
 * PC c3.z, FUN_1802c0450 (0x1802c13d2 .. 0x1802c1588) + FUN_1802c32b0 (0x800): per texture layer i, bit i = its
 * m_bClampUVs and bit 12 + i = no sprite sheet (type below UVDISTORTION); then the renderer bits.
 */
export function layerFlags(p, groups, sheetOf, addSelf) {
  let f = 0;
  groups.slice(0, 5).forEach((g, i) => {
    if (g.m_TextureControls?.m_bClampUVs) f |= 1 << i;
    if (g.m_nTextureType < 3 && !sheetOf(g)) f |= 1 << (12 + i);
  });
  if (p.m_bRefract && p.m_bRefractSolid) f |= 0x20;
  if (p.m_bSaturateColorPreAlphaBlend !== false) f |= 0x40;
  if (rendererFlags(p) & FLAG.ALPHA_REFERENCE) f |= 0x80;
  if (p.m_bBlendFramesSeq0 !== false) f |= 0x100;
  if (p.m_bMaxLuminanceBlendingSequence0) f |= 0x200;
  if (p.m_bAnimateInFPS) f |= 0x400;
  if (addSelf > 0) f |= 0x800;
  return f;
}
