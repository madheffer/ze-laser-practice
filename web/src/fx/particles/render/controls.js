// Renderer fields -> the spritecard cbuffers (VC b3, PC b4) and render state, in ONE table so a mapping is fixed
// in one place; no three.js, node tests it. Shader slots are settled (RE §3, §4); the vpcf field filling each is
// UNSETTLED (RE §1-4 #1, #2) unless `settled`. `why` holds the evidence (PS0 / VS0 / TVS cite dump lines).
import { evalFloat, evalVec } from '../inputs.js';

const ENUMS = {
  orientation: ['PARTICLE_ORIENTATION_SCREEN_ALIGNED', 'PARTICLE_ORIENTATION_SCREEN_Z_ALIGNED', 'PARTICLE_ORIENTATION_WORLD_Z_ALIGNED',
    'PARTICLE_ORIENTATION_ALIGN_TO_PARTICLE_NORMAL', 'PARTICLE_ORIENTATION_SCREENALIGN_TO_PARTICLE_NORMAL', 'PARTICLE_ORIENTATION_FULL_3AXIS_ROTATION'],
  output: ['PARTICLE_OUTPUT_BLEND_MODE_ALPHA', 'PARTICLE_OUTPUT_BLEND_MODE_ADD', 'PARTICLE_OUTPUT_BLEND_MODE_BLEND_ADD',
    'PARTICLE_OUTPUT_BLEND_MODE_HALF_BLEND_ADD', 'PARTICLE_OUTPUT_BLEND_MODE_NEG_HALF_BLEND_ADD', 'PARTICLE_OUTPUT_BLEND_MODE_MOD2X',
    'PARTICLE_OUTPUT_BLEND_MODE_LIGHTEN'],
  channel: ['RGB', 'RGBA', 'A', 'RGB_A', 'RGB_ALPHAMASK', 'RGB_RGBMASK', 'RGBA_RGBALPHA', 'A_RGBALPHA', 'RGB_A_RGBALPHA', 'R', 'G', 'B',
    'RALPHA', 'GALPHA', 'BALPHA'].map((s) => 'SPRITECARD_TEXTURE_CHANNEL_MIX_' + s),
  texBlend: ['MULTIPLY', 'MOD2X', 'REPLACE', 'ADD', 'SUBTRACT', 'AVERAGE', 'LUMINANCE'].map((s) => 'SPRITECARD_TEXTURE_BLEND_' + s),
  texType: ['DIFFUSE', 'ZOOM', '1D_COLOR_LOOKUP', 'UVDISTORTION', 'UVDISTORTION_ZOOM', 'NORMALMAP', 'ANIMMOTIONVEC',
    'SPHERICAL_HARMONICS_A', 'SPHERICAL_HARMONICS_B', 'SPHERICAL_HARMONICS_C', 'DEPTH', 'ILLUMINATION_GRADIENT'].map((s) => 'SPRITECARD_TEXTURE_' + s),
  colorBlend: ['MULTIPLY', 'MULTIPLY2X', 'DIVIDE', 'ADD', 'SUBTRACT', 'MOD2X', 'SCREEN', 'MAX', 'MIN', 'REPLACE', 'AVERAGE', 'NEGATE',
    'LUMINANCE'].map((s) => 'PARTICLE_COLOR_BLEND_' + s),
  animation: ['ANIMATION_TYPE_FIXED_RATE', 'ANIMATION_TYPE_FIT_LIFETIME', 'ANIMATION_TYPE_MANUAL_FRAMES'],
  lightType: ['PARTICLE_LIGHT_TYPE_POINT', 'PARTICLE_LIGHT_TYPE_SPOT', 'PARTICLE_LIGHT_TYPE_FX', 'PARTICLE_LIGHT_TYPE_CAPSULE'],
};

/** Enum string or number -> its index (schema.json enum values are 0..n in these lists). */
export function enumIndex(kind, v, fallback = 0) {
  if (typeof v === 'number') return v;
  const i = ENUMS[kind].indexOf(v);
  return i >= 0 ? i : fallback;
}

// TextureGroup_t has no MGetKV3ClassDefaults (it faults, RE §11), so defaults come from the 2,679 stock files:
// across 4,339 texture groups no file writes these values while every other value appears, and compiled files
// omit defaults (RE §11).
export const TEXTURE_GROUP_DEFAULTS = {
  m_bEnabled: true, m_nTextureType: 0, m_nTextureChannels: 1, m_nTextureBlendMode: 0, m_flTextureBlend: 1,
};

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Renderer inputs through inputs.js, the one evaluator (README "Renderers"): `i` is a particle
 * index, -1 for a collection-level input. `dflt` stands in for an input the data leaves out.
 * Reports land on the collection's system (sys.reports) as inputs.js files them.
 */
export function makeInputs(col) {
  const evalF = (inp, i = -1, dflt = 0) => evalFloat(inp ?? dflt, col, i);
  const evalV = (inp, i = -1, dflt = [1, 1, 1]) => (inp == null ? dflt : evalVec(inp, col, i));
  return { evalFloat: evalF, evalVec: evalV };
}

/** Texture groups of a renderer from its RAW vpcf data, with the stock-corpus defaults above. */
export function textureGroups(raw) {
  const list = Array.isArray(raw?.m_vecTexturesInput) ? raw.m_vecTexturesInput : [];
  return list.map((g) => ({
    ...TEXTURE_GROUP_DEFAULTS,
    ...g,
    m_nTextureType: enumIndex('texType', g.m_nTextureType ?? 0),
    m_nTextureChannels: enumIndex('channel', g.m_nTextureChannels ?? 1, 1),
    m_nTextureBlendMode: enumIndex('texBlend', g.m_nTextureBlendMode ?? 0),
    m_TextureControls: g.m_TextureControls || {},
  })).filter((g) => g.m_bEnabled !== false);
}

/**
 * The control table. Each row: slot, field, settled, why. spritecardControls() below is the code
 * form of exactly these rows, so a correction is one row plus its line there.
 */
export const CONTROL_TABLE = [
  { slot: 'PC_c19.x & 15', field: 'texture m_nTextureChannels', settled: true, why: 'PS0:422 case values = SpriteCardTextureChannel_t' },
  { slot: 'PC_c19.x >> 4 & 15', field: 'texture m_nTextureBlendMode', settled: true, why: 'PS0:550 case values = ParticleTextureLayerBlendType_t' },
  { slot: 'PC_c19.y >> 16 & 15', field: 'texture m_nTextureType', settled: true, why: 'PS0:194 case values = SpriteCardTextureType_t' },
  { slot: 'PC_c19z & 1 (F_MOD2X)', field: 'm_nOutputBlendMode MOD2X', settled: true, why: 'render state SrcBlend DEST_COLOR (RE §4 table); PS0:94,707' },
  { slot: 'F_LIGHTEN_MODE', field: 'm_nOutputBlendMode LIGHTEN', settled: true, why: 'render state BlendOp MAX (RE §4 table)' },
  { slot: 'F_DISABLE_DEPTHTEST', field: 'm_bDisableZBuffering', settled: false, why: 'name; DepthFunc ALWAYS (RE §4 table)' },
  { slot: 'PC_c1.w', field: 'm_nOutputBlendMode: ALPHA +1, ADD 0, BLEND_ADD -1, HALF_BLEND_ADD +0.5, NEG_HALF_BLEND_ADD -0.5', settled: false,
    why: 'PS0:795,803 signed scalar; ALPHA must premultiply under ONE/INV_SRC_ALPHA, ADD must output alpha 0. The two HALF modes are guesses' },
  { slot: 'PC_c0.x', field: 'm_flSelfIllumAmount', settled: false,
    why: 'PS0:689 additive term. RE lists 1 - diffuse; but 1,046 of 1,077 stock renderers with diffuse 0 also set self-illum, pointless if it were unused' },
  { slot: 'PC_c0.y', field: 'm_flDiffuseAmount', settled: false, why: 'PS0:689 scales the vertex light sum (RE §4 candidate)' },
  { slot: 'PC_c0.zw', field: 'm_flEdgeSoftnessStart / End when m_bSoftEdges, else 0, 0', settled: false,
    why: 'PS0:612 applies only when w < z; defaults 0.6 / 0.5 are in that order. Map-to-zero/one are not placed' },
  { slot: 'PC_c1.z + PC_c19z & 16', field: 'm_flOverbrightFactor (flag always set)', settled: false, why: 'PS0:718-720; a factor of 1 is a no-op either way' },
  { slot: 'PC_c3.z & 1', field: 'texture m_bClampUVs', settled: false, why: 'PS0:82-88 clamp vs wrap sampler (RE §4 step 1)' },
  { slot: 'PC_c4', field: '(1, 1, 1, 1): colour scale and alpha scale go into the vertex colour instead', settled: false,
    why: 'the 13 colour blend types have no shader code (VS0 and PS0), so the C++ combines them per particle, as the light does before its sRGB decode (RE §10)' },
  { slot: 'PC_c5 / PC_c6', field: 'm_OutlineColor + m_nOutlineAlpha / (m_flOutlineStart0, End0, Start1, End1), gated by m_bOutline', settled: false,
    why: 'PS0:621-642: a band rising x..z and falling w..y' },
  { slot: 'PC_c8.x', field: 'none known (0)', settled: false, why: 'PS0:660 alpha bias' },
  { slot: 'PC_c8.y', field: 'texture m_flTextureBlend', settled: false, why: 'PS0:598 lerp(1, texture, x): the layer blend amount' },
  { slot: 'PC_c9.x', field: 'm_flDesaturation', settled: false, why: 'PS0:654 lerp to Rec.709 luminance' },
  { slot: 'PC_c19z & 1024', field: 'm_bBlendFramesSeq0', settled: false, why: 'PS0:139 frame lerp; the same bit saturates alpha at PS0:664' },
  { slot: 'PC_c19z & 32768, VC_c16w & 32768', field: 'texture has a sheet', settled: false, why: 'VS0:191, PS0:106' },
  { slot: 'VC_c16w >> 1 & 7', field: 'm_nOrientationType (enum value, clamped to 4)', settled: false, why: 'VS0:153; RE §1-4 #3' },
  { slot: 'VC_c4.z >> 8 & 15', field: 'm_bGammaCorrectVertexColors', settled: false, why: 'VS0:3129-3158 exact sRGB decode' },
  { slot: 'VC_c0', field: '(m_flMinSize, m_flStartFadeSize, m_flEndFadeSize, m_flMaxSize), unscaled', settled: false, why: 'VS0:3300-3321; the unit is unknown' },
  { slot: 'VC_c2.z', field: 'sprites: 1 (world space); ropes: m_bEnableFadingAndClamping', settled: false, why: 'VS0:157 aspect block would scale a world centre; RE §1-4 #4' },
  { slot: 'VC_c2.xy', field: 'm_flStartFadeDot / m_flEndFadeDot', settled: false, why: 'VS0:3232,3246; TVS:2768-2775' },
  { slot: 'VC_c1.x', field: 'm_flDepthBias', settled: false, why: 'VS0:3335' },
  { slot: 'VC_c1.yz', field: 'm_flCenterXOffset / m_flCenterYOffset', settled: false, why: 'VS0:3294' },
  { slot: 'VC_c1.w', field: 'm_flAnimationRate', settled: false, why: 'VS0:1693' },
  { slot: 'VC_c16w & 4096', field: 'm_bAnimateInFPS', settled: false, why: 'VS0:1685 divides by the sequence time' },
  { slot: 'VC_c5', field: 'texture m_flFinalTextureOffsetU/V, m_flFinalTextureScaleU/V', settled: false, why: 'VS0:1135,1732' },
  { slot: 'VC_c4.w', field: 'texture m_flFinalTextureUVRotation (radians)', settled: false, why: 'VS0:1026 rotates the no-sheet UV' },
  { slot: 'VC_c3.y', field: 'texture m_flZoomScale', settled: false, why: 'VS0:1731 saturate(1/x) zoom' },
  { slot: 'VC_c3.zw', field: 'ropes: (m_flTextureVOffset + m_flTextureVScrollRate * time) * worldSize, 1/m_flTextureVWorldSize', settled: false, why: 'TVS:173' },
];

// RE §4 render-state table, decoded from csgo_spritecard_vulkan_50_ps.json.
export function renderState(mod2x, lighten, disableDepth) {
  return {
    blendOp: lighten ? 'MAX' : 'ADD',
    src: mod2x ? 'DEST_COLOR' : 'ONE',
    dst: lighten ? 'ONE' : (mod2x ? 'SRC_COLOR' : 'INV_SRC_ALPHA'),
    srcAlpha: mod2x ? 'ZERO' : 'INV_DEST_ALPHA',
    dstAlpha: 'ONE',
    // UNSETTLED: BlendOpAlpha is not in the table; D3D's default is ADD.
    blendOpAlpha: 'ADD',
    depthWrite: false,
    depthFunc: disableDepth ? 'ALWAYS' : 'LESS_EQUAL',
  };
}

const BLEND_SCALAR = [1, 0, -1, 0.5, -0.5, 1, 1];

/**
 * Evaluate the table for one renderer. `p` is the renderer with class defaults applied, `raw` its
 * vpcf data (texture groups need it), `ev` the input evaluator. Returns the cbuffer values, the
 * render state, and the features this renderer asks for that are not drawn as the game draws them.
 */
export function spritecardControls(cls, p, raw, ev, time = 0) {
  const unsupported = [];
  const isRope = cls === 'C_OP_RenderRopes' || cls === 'C_OP_RenderTrails';
  const groups = textureGroups(raw);
  const g = groups[0] || { ...TEXTURE_GROUP_DEFAULTS, m_TextureControls: {} };
  if (groups.length > 1) unsupported.push(`${groups.length} texture layers (S_TEXTURE_LAYERS > 0 is not dumped, RE UNSETTLED #10)`);
  if (g.m_nTextureType !== 0) unsupported.push(`texture type ${ENUMS.texType[g.m_nTextureType] || g.m_nTextureType} (only DIFFUSE is ported)`);
  const tc = g.m_TextureControls || {};
  const output = enumIndex('output', p.m_nOutputBlendMode ?? 0);
  const mod2x = output === 5, lighten = output === 6;
  const f = (k, d) => ev.evalFloat(p[k], -1, d);
  const tf = (k, d) => ev.evalFloat(tc[k], -1, d);
  if (p.m_bRefract) unsupported.push('m_bRefract (S_REFRACT is not dumped)');
  if (p.m_nHSVShiftControlPoint >= 0) unsupported.push('HSV shift (S_HSV_SHIFT is not dumped)');
  if (p.m_bParticleShadows) unsupported.push('particle shadows (not dumped)');
  if ((p.m_nFeatheringMode ?? 'PARTICLE_DEPTH_FEATHERING_OFF') !== 'PARTICLE_DEPTH_FEATHERING_OFF') unsupported.push('depth feathering');
  if ((p.m_nPerParticleAlphaReference ?? 'SPRITECARD_TEXTURE_PP_SCALE_NONE') !== 'SPRITECARD_TEXTURE_PP_SCALE_NONE') unsupported.push('per-particle alpha reference');
  if (p.m_nOrientationControlPoint >= 0) unsupported.push('m_nOrientationControlPoint');
  const orient = enumIndex('orientation', p.m_nOrientationType ?? 0);
  if (orient === 5) unsupported.push('FULL_3AXIS_ROTATION, which the shader clamps to 4 (VS0:153)');
  const softEdges = !!p.m_bSoftEdges;
  const outline = !!p.m_bOutline;
  const oc = p.m_OutlineColor || [255, 255, 255];
  const anim = enumIndex('animation', p.m_nAnimationType ?? 0);
  if (anim === 2) unsupported.push('ANIMATION_TYPE_MANUAL_FRAMES');
  const zoom = tf('m_flZoomScale', 1);
  const pc = {
    c0: [f('m_flSelfIllumAmount', 0), f('m_flDiffuseAmount', 1),
      softEdges ? num(p.m_flEdgeSoftnessStart, 0.6) : 0, softEdges ? num(p.m_flEdgeSoftnessEnd, 0.5) : 0],
    c1: [0, 0, f('m_flOverbrightFactor', 1), BLEND_SCALAR[output] ?? 1],
    c3: [0, 0, tc.m_bClampUVs ? 1 : 0, 0],
    c4: [1, 1, 1, 1],
    c5: [oc[0] / 255, oc[1] / 255, oc[2] / 255, num(p.m_nOutlineAlpha, 255) / 255],
    c6: outline ? [num(p.m_flOutlineStart0, 0.5), num(p.m_flOutlineEnd0, 0.7), num(p.m_flOutlineStart1, 0.6), num(p.m_flOutlineEnd1, 0.8)] : [2, 0, 0, -1],
    c8: [0, ev.evalFloat(g.m_flTextureBlend, -1, 1), 0, 0],
    c9: [f('m_flDesaturation', 0), 0, 0, 0],
    c19x: (g.m_nTextureChannels & 15) | ((g.m_nTextureBlendMode & 15) << 4),
    c19y: (g.m_nTextureType & 15) << 16,
    c19z: (mod2x ? 1 : 0) | 16 | (p.m_bBlendFramesSeq0 !== false ? 1024 : 0),
  };
  const vc = {
    c0: [f('m_flMinSize', 0), f('m_flStartFadeSize', isRope ? 1000 : 1e8), f('m_flEndFadeSize', isRope ? 2000 : 2e8), f('m_flMaxSize', isRope ? 2000 : 5000)],
    c1: [f('m_flDepthBias', 0), f('m_flCenterXOffset', 0), f('m_flCenterYOffset', 0), num(p.m_flAnimationRate, 0.1)],
    c2: [num(p.m_flStartFadeDot, 1), num(p.m_flEndFadeDot, 2), isRope ? (p.m_bEnableFadingAndClamping ? 1 : 0) : 1, 0],
    c3: [0, zoom, 0, 0],
    c4: [0, 0, p.m_bGammaCorrectVertexColors !== false ? 256 : 0, tf('m_flFinalTextureUVRotation', 0)],
    c5: [tf('m_flFinalTextureOffsetU', 0), tf('m_flFinalTextureOffsetV', 0), tf('m_flFinalTextureScaleU', 1), tf('m_flFinalTextureScaleV', 1)],
    c16w: (orient & 7) << 1 | (p.m_bAnimateInFPS ? 4096 : 0),
    orientation: Math.min(4, orient),
    animationType: anim,
  };
  if (isRope) {
    const ws = f('m_flTextureVWorldSize', 10);
    const inv = ws > 0 ? 1 / ws : 0;
    vc.c3[3] = inv;
    vc.c3[2] = (f('m_flTextureVOffset', 0) + f('m_flTextureVScrollRate', 0) * time) * ws;
    if (num(p.m_flRadiusTaper, 1) !== 1) unsupported.push('m_flRadiusTaper');
    if (p.m_bClampV) unsupported.push('m_bClampV');
  }
  return {
    pc, vc, state: renderState(mod2x, lighten, !!p.m_bDisableZBuffering),
    texture: g.m_hTexture ? normalizeRef(g.m_hTexture) : null,
    clampUVs: !!tc.m_bClampUVs,
    colorBlendType: enumIndex('colorBlend', p.m_nColorBlendType ?? 0),
    unsupported,
  };
}

/** A resource reference as the catalog keys it (EffectAssetCodec.Normalize). */
export function normalizeRef(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/^"|"$/g, '').replace(/\\/g, '/').toLowerCase();
  if (s.startsWith('resource:')) s = s.slice(9).replace(/^"|"$/g, '');
  if (s.endsWith('_c')) s = s.slice(0, -2);
  return s || null;
}
