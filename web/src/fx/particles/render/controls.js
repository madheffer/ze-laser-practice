// Renderer fields -> the spritecard cbuffers (VC b3, PC b4) and render state, in ONE table so a mapping is fixed
// in one place; no three.js, node tests it (tools/particles/controls.test.mjs). Shader slots: RE §3, §4 (PS0 / VS0 /
// TVS cite dump lines, re-dumped with VRF 20.1 from shaders_vulkan_dir.vpk). The field filling each slot is read from
// particles.dll (md5 63babcbf3245e56855a777134323e74a) unless a row says UNSETTLED:
//   FUN_1802c32b0  CBaseRendererSource2: fills SpriteCardPixelControls_t (param_3 = PC as floats, index i = c(i/4))
//   FUN_1802c9e80  C_OP_RenderSprites slot 68: the sprite-only PC fields (soft edges, outline)
//   FUN_1802ca010  C_OP_RenderSprites slot 69: SpritecardVertexControls_t
//   FUN_1802c7600  allocates both buffers: PC zeroed then c0.z = -1000, c0.w = 1000, c1.z = 1, c6.x = 1000,
//                  c6.w = -1000, c8.y..c12.y layer blends = 1; then the flag word into PC c19.z and VC c16.w (flags.js)
import { evalFloat, evalVec } from '../inputs.js';
import { rendererFlags, layerFlags } from './flags.js';

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
 * The control table. Each row: slot, field, settled, why. spritecardControls() below is the code form of exactly
 * these rows, so a correction is one row plus its line there. Bare addresses are particles.dll's.
 */
export const CONTROL_TABLE = [
  { slot: 'PC_c0.x', field: 'm_flSelfIllumAmount', settled: true, why: 'FUN_1802c32b0 param_3[0] = input +0x1390; PS0:689 additive term' },
  { slot: 'PC_c0.y', field: 'm_flDiffuseAmount', settled: true, why: 'param_3[1] = input +0x1508; PS0:689 scales the vertex light sum' },
  { slot: 'PC_c0.zw', field: 'm_bDistanceAlpha: m_bSoftEdges ? (m_flEdgeSoftnessStart, End) : (0.49900, 1000); else (-1000, 1000)', settled: true,
    why: 'FUN_1802c9e80 (no alpha reference): +8 = 0x3eff7cee or +0x37c4, +0xc = +0x37c8; buffer init FUN_1802c7600; PS0:612 runs when w < z' },
  { slot: 'PC_c1.xy', field: 'feathering ? (m_flFeatheringMinDist, MaxDist) : (1, 1)', settled: true, why: 'param_3[4], [5] when +0x24fc != 0' },
  { slot: 'PC_c1.z', field: 'MOD2X ? 1 : 1 + m_flAddSelfAmount', settled: true, why: 'param_3[6]; PS0:718-720 under F_ADDSELF (flags.js)' },
  { slot: 'PC_c1.w', field: 'output blend: ALPHA 1, ADD 0, BLEND_ADD -1, HALF_BLEND_ADD 0.5, NEG_HALF_BLEND_ADD -0.5, MOD2X 1, LIGHTEN 1', settled: true,
    why: 'param_3[7] = DAT_180526f90[m_nOutputBlendMode]; PS0:795,803' },
  { slot: 'PC_c2', field: '(m_flRefractAmount, m_flFeatheringFilter, m_flFogAmount or 0 if fog DISABLED, m_flBumpStrength)', settled: true,
    why: 'param_3[8..10], FUN_1802c9e80 +0x2c. c2 is in no dumped combo but feathering (f1: c2.y), so fog amount is read by none' },
  { slot: 'PC_c3.xy', field: 'motion vector scale U/V x sheet ratio', settled: true, why: 'param_3[0xc], [0xd]; motion vectors are not ported' },
  { slot: 'PC_c3.z', field: 'layer flags (clamp bit i, no-sheet bit 12+i) | renderer bits (flags.js layerFlags)', settled: true,
    why: 'param_3[0xe] = +0x2d18 | 0x800 (add self > 0); PS0:82 (bit 0), PS0:413 (bit 12)' },
  { slot: 'PC_c3.w', field: 'm_nLightingMode', settled: true, why: 'FUN_1802c9e80 +0x3c' },
  { slot: 'PC_c4', field: '(tint x m_flOverbrightFactor, 1 / (m_flSourceAlphaValueToMapToOne - ToZero))', settled: true,
    why: 'param_3[0x10..0x13]; PS0:659. The tint (local_1998) is 1 unless the draw carries one (param_2 +0x50): UNSETTLED, taken as 1' },
  { slot: 'PC_c5 / PC_c6', field: 'm_bOutline: (m_OutlineColor/255, m_nOutlineAlpha/255) / (Start0, End0, Start1, End1); else c6 (1000, 0, 0, -1000)', settled: true,
    why: 'FUN_1802c9e80 +0x50..0x6c; FUN_18035f2e0 converts the Color (UNSETTLED: /255 assumed, no gamma)' },
  { slot: 'PC_c8', field: '(-ToZero, layer 0 m_flTextureBlend, frac(zoom / 10) x 10, m_flDistortion)', settled: true, why: 'param_3[0x20..0x23]; PS0:598, 660' },
  { slot: 'PC_c9.x', field: 'saturate(m_flDesaturation + draw desaturation (0))', settled: true, why: 'param_3[0x24]; PS0:654' },
  { slot: 'PC_c19.xy', field: 'texture layer channel | blend << 4 (8 bits a layer); types << 16 (3 bits a layer)', settled: true, why: 'FUN_1802c0450 +0x2d10, +0x2d14; PS0:194, 422, 550' },
  { slot: 'PC_c19.z = VC_c16.w', field: 'the flag word (flags.js)', settled: true, why: 'FUN_1802c7600 +0x138, +0x10c' },
  { slot: 'F_DISABLE_DEPTHTEST / F_LIGHTEN_MODE', field: 'm_bDisableZBuffering / output LIGHTEN', settled: true, why: 'FUN_1802c9670 features 0xd (+0x24f8), 0xe (+0x17fc == 6)' },
  { slot: 'VC_c0', field: '(m_flMinSize, m_flStartFadeSize, m_flEndFadeSize, m_flMaxSize)', settled: true, why: 'FUN_1802ca010 param_3[0..3]; VS0:3300-3321' },
  { slot: 'VC_c1.x', field: '-m_flDepthBias', settled: true, why: 'param_3[4] = input +0x2ae0 ^ 0x80000000; VS0:3335' },
  { slot: 'VC_c1.yz', field: 'm_flCenterXOffset / m_flCenterYOffset', settled: false, why: 'VS0:3294; not written by FUN_1802ca010 itself (FUN_1802c5970)' },
  { slot: 'VC_c1.w', field: 'm_flAnimationRate (not for MANUAL_FRAMES)', settled: true, why: 'param_3[7] = +0x1090 when +0x1094 != 2; VS0:1693' },
  { slot: 'VC_c2', field: '(m_flStartFadeDot, m_flEndFadeDot, 1 for sprites, m_flSubPixelAAScale x k)', settled: true, why: 'param_3[8..0xb]; VS0:3232' },
  { slot: 'FIT_LIFETIME age', field: '(time - creation) / lifetime, 0 when lifetime <= 0', settled: true, why: 'FUN_180033400 (FIT_LIFETIME vertex writer): divps age by attr 1' },
  { slot: 'VC_c3.y', field: 'texture m_flZoomScale', settled: false, why: 'VS0:1731 saturate(1/x) zoom' },
  { slot: 'VC_c4.z >> 8 & 15', field: 'm_bGammaCorrectVertexColors', settled: false, why: 'VS0:3129-3158 exact sRGB decode' },
  { slot: 'VC_c5', field: 'texture m_flFinalTextureOffsetU/V, m_flFinalTextureScaleU/V', settled: false, why: 'VS0:1135,1732' },
  { slot: 'VC_c4.w', field: 'texture m_flFinalTextureUVRotation (radians)', settled: false, why: 'VS0:1026 rotates the no-sheet UV' },
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

// DAT_180526f90, indexed by m_nOutputBlendMode (FUN_1802c32b0 param_3[7])
export const BLEND_SCALAR = [1, 0, -1, 0.5, -0.5, 1, 1];

/**
 * Evaluate the table for one renderer. `p` is the renderer with class defaults applied, `raw` its vpcf data
 * (texture groups need it), `ev` the input evaluator, `sheetOf(group)` whether a layer's texture has a sprite sheet.
 * Returns the cbuffer values, the render state, and the features this renderer asks for that are not drawn as the
 * game draws them.
 */
export function spritecardControls(cls, p, raw, ev, time = 0, sheetOf = () => false) {
  const unsupported = [];
  const isRope = cls === 'C_OP_RenderRopes' || cls === 'C_OP_RenderTrails';
  const groups = textureGroups(raw);
  const g = groups[0] || { ...TEXTURE_GROUP_DEFAULTS, m_TextureControls: {} };
  if (groups.length > 1) unsupported.push(`${groups.length} texture layers (S_TEXTURE_LAYERS 1-4 are dumped, not ported)`);
  if (g.m_nTextureType !== 0) unsupported.push(`texture type ${ENUMS.texType[g.m_nTextureType] || g.m_nTextureType} (only DIFFUSE is ported)`);
  const tc = g.m_TextureControls || {};
  const output = enumIndex('output', p.m_nOutputBlendMode ?? 0);
  const mod2x = output === 5, lighten = output === 6;
  const f = (k, d) => ev.evalFloat(p[k], -1, d);
  const tf = (k, d) => ev.evalFloat(tc[k], -1, d);
  if (p.m_bRefract) unsupported.push('m_bRefract (S_REFRACT is not dumped)');
  if (p.m_nHSVShiftControlPoint >= 0) unsupported.push('HSV shift (S_HSV_SHIFT is not dumped)');
  if (p.m_bParticleShadows) unsupported.push('particle shadows (not dumped)');
  const feather = (p.m_nFeatheringMode ?? 'PARTICLE_DEPTH_FEATHERING_OFF') !== 'PARTICLE_DEPTH_FEATHERING_OFF' && p.m_nFeatheringMode !== 0;
  if (feather) unsupported.push('depth feathering (D_DEPTH_FEATHERING=1 is dumped; the scene depth is not sampled here)');
  if ((p.m_nPerParticleAlphaReference ?? 'SPRITECARD_TEXTURE_PP_SCALE_NONE') !== 'SPRITECARD_TEXTURE_PP_SCALE_NONE') unsupported.push('per-particle alpha reference');
  if (p.m_nOrientationControlPoint >= 0) unsupported.push('m_nOrientationControlPoint');
  const orient = enumIndex('orientation', p.m_nOrientationType ?? 0);
  if (orient === 5) unsupported.push('FULL_3AXIS_ROTATION, which the shader clamps to 4 (VS0:153)');
  const anim = enumIndex('animation', p.m_nAnimationType ?? 0);
  if (anim === 2) unsupported.push('ANIMATION_TYPE_MANUAL_FRAMES');
  const zoom = tf('m_flZoomScale', 1);
  const addSelf = f('m_flAddSelfAmount', 0);
  const toZero = f('m_flSourceAlphaValueToMapToZero', 0), toOne = f('m_flSourceAlphaValueToMapToOne', 1);
  const overbright = f('m_flOverbrightFactor', 1);
  // FUN_1802c9e80: alpha reference off -> distance alpha / soft edges; outline
  const alphaRef = (p.m_nPerParticleAlphaReference ?? 'SPRITECARD_TEXTURE_PP_SCALE_NONE') !== 'SPRITECARD_TEXTURE_PP_SCALE_NONE';
  let c0z = -1000, c0w = 1000;
  if (!alphaRef && p.m_bDistanceAlpha) {
    if (p.m_bSoftEdges) { c0z = num(p.m_flEdgeSoftnessStart, 0.6); c0w = num(p.m_flEdgeSoftnessEnd, 0.5); } else c0z = 0.49900001287460327;
  }
  const outline = !alphaRef && !!p.m_bOutline;
  const oc = p.m_OutlineColor || [255, 255, 255];
  const hasSheet = groups.some((x) => sheetOf(x));
  const flags = rendererFlags(p, { orient, output, hasSheet });
  const pc = {
    c0: [f('m_flSelfIllumAmount', 0), f('m_flDiffuseAmount', 1), c0z, c0w],
    c1: [feather ? f('m_flFeatheringMinDist', 0) : 1, feather ? f('m_flFeatheringMaxDist', 15) : 1, mod2x ? 1 : 1 + addSelf, BLEND_SCALAR[output] ?? 1],
    c3: [0, 0, layerFlags(p, groups, sheetOf, addSelf), 0],
    c4: [overbright, overbright, overbright, 1 / (toOne - toZero)],
    c5: outline ? [oc[0] / 255, oc[1] / 255, oc[2] / 255, num(p.m_nOutlineAlpha, 255) / 255] : [0, 0, 0, 0],
    c6: outline ? [num(p.m_flOutlineStart0, 0.5), num(p.m_flOutlineEnd0, 0.7), num(p.m_flOutlineStart1, 0.6), num(p.m_flOutlineEnd1, 0.8)] : [1000, 0, 0, -1000],
    c8: [-toZero, ev.evalFloat(g.m_flTextureBlend, -1, 1), (zoom / 10 - Math.floor(zoom / 10)) * 10, tf('m_flDistortion', 0)],
    c9: [Math.min(1, Math.max(0, f('m_flDesaturation', 0))), 1, 1, 1],
    c19x: (g.m_nTextureChannels & 15) | ((g.m_nTextureBlendMode & 15) << 4),
    c19y: g.m_nTextureType << 16,
    c19z: flags,
  };
  const vc = {
    c0: [f('m_flMinSize', 0), f('m_flStartFadeSize', isRope ? 1000 : 1e8), f('m_flEndFadeSize', isRope ? 2000 : 2e8), f('m_flMaxSize', isRope ? 2000 : 5000)],
    c1: [-f('m_flDepthBias', 0), f('m_flCenterXOffset', 0), f('m_flCenterYOffset', 0), anim === 2 ? 1 : num(p.m_flAnimationRate, 0.1)],
    c2: [num(p.m_flStartFadeDot, 1), num(p.m_flEndFadeDot, 2), isRope ? (p.m_bEnableFadingAndClamping ? 1 : 0) : 1, 0],
    c3: [0, zoom, 0, 0],
    c4: [0, 0, p.m_bGammaCorrectVertexColors !== false ? 256 : 0, tf('m_flFinalTextureUVRotation', 0)],
    c5: [tf('m_flFinalTextureOffsetU', 0), tf('m_flFinalTextureOffsetV', 0), tf('m_flFinalTextureScaleU', 1), tf('m_flFinalTextureScaleV', 1)],
    c16w: flags,
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
    pc, vc, flags, state: renderState(mod2x, lighten, !!p.m_bDisableZBuffering),
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
