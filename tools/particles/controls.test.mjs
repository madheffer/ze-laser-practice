// node --test tools/particles/controls.test.mjs
// The renderer field -> spritecard cbuffer mapping (web/src/fx/particles/render/controls.js, flags.js) against what
// particles.dll's fill functions write (addresses in those files), on synthetic renderers and the baked dragon fire.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spritecardControls, BLEND_SCALAR } from '../../web/src/fx/particles/render/controls.js';
import { rendererFlags, FLAG } from '../../web/src/fx/particles/render/flags.js';
import { expandDefaults, resolveFunction } from '../../web/src/fx/particles/system.js';
import defaults from '../../web/src/fx/particles/defaults.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ctx = expandDefaults(defaults);
const lit = (inp, d) => (typeof inp === 'number' ? inp : inp?.m_nType === 'PF_TYPE_LITERAL' ? inp.m_flLiteralValue : d);
const ev = { evalFloat: (inp, _i, d) => lit(inp, d), evalVec: (inp, _i, d) => inp?.m_vLiteralValue || d };
const sprite = (fields) => {
  const raw = { _class: 'C_OP_RenderSprites', ...fields };
  return [resolveFunction(raw, ctx), raw];
};
const ctl = (fields, sheetOf) => { const [p, raw] = sprite(fields); return spritecardControls('C_OP_RenderSprites', p, raw, ev, 0, sheetOf); };

test('class defaults', () => {
  const c = ctl({});
  assert.deepEqual(c.pc.c0, [0, 1, -1000, 1000]);            // self illum 0, diffuse 1, FUN_1802c7600 init
  assert.deepEqual(c.pc.c1, [1, 1, 1, 1]);                    // no feathering, no add self, ALPHA
  assert.deepEqual(c.pc.c4, [1, 1, 1, 1]);                    // overbright 1, 1 / (1 - 0)
  assert.deepEqual(c.pc.c6, [1000, 0, 0, -1000]);             // outline off
  assert.equal(c.pc.c8[0], -0);
  // ALPHA, screen aligned: saturate (default on), fog (game default), blend frames, no normal
  assert.equal(c.flags, FLAG.SATURATE_COLOR_PRE_ALPHA_BLEND | FLAG.FOG_PARTICLES | FLAG.BLENDFRAMES_SEQ0 | FLAG.HAS_NO_NORMAL_FOR_LIGHTING);
  assert.equal(c.pc.c19z, c.vc.c16w);
  assert.equal(c.pc.c3[2], 0x40 | 0x100);                     // +0x2d18: saturate, blend frames
});

test('output blend scalar is DAT_180526f90', () => {
  assert.deepEqual(BLEND_SCALAR, [1, 0, -1, 0.5, -0.5, 1, 1]);
  assert.equal(ctl({ m_nOutputBlendMode: 'PARTICLE_OUTPUT_BLEND_MODE_ADD' }).pc.c1[3], 0);
  const m = ctl({ m_nOutputBlendMode: 'PARTICLE_OUTPUT_BLEND_MODE_MOD2X', m_flAddSelfAmount: 2 });
  assert.equal(m.pc.c1[2], 1);                                // MOD2X keeps c1.z at 1
  assert.ok(m.flags & FLAG.MOD2X);
});

test('add self and overbright', () => {
  const c = ctl({ m_flAddSelfAmount: 0.5, m_flOverbrightFactor: 6 });
  assert.equal(c.pc.c1[2], 1.5);
  assert.ok(c.flags & FLAG.ADDSELF);
  assert.ok(c.pc.c3[2] & 0x800);
  assert.deepEqual(c.pc.c4.slice(0, 3), [6, 6, 6]);
  assert.ok(!(ctl({}).flags & FLAG.ADDSELF));
});

test('fog type, alpha remap, depth bias, soft edges', () => {
  assert.ok(!(ctl({ m_nFogType: 'PARTICLE_FOG_DISABLED' }).flags & FLAG.FOG_PARTICLES));
  assert.ok(ctl({ m_nFogType: 'PARTICLE_FOG_ENABLED' }).flags & FLAG.FOG_PARTICLES);
  const r = ctl({ m_flSourceAlphaValueToMapToZero: 0.25, m_flSourceAlphaValueToMapToOne: 0.75 });
  assert.equal(r.pc.c4[3], 2); assert.equal(r.pc.c8[0], -0.25);
  assert.equal(ctl({ m_flDepthBias: 4 }).vc.c1[0], -4);
  assert.deepEqual(ctl({ m_bDistanceAlpha: true }).pc.c0.slice(2), [0.49900001287460327, 1000]);
  assert.deepEqual(ctl({ m_bDistanceAlpha: true, m_bSoftEdges: true }).pc.c0.slice(2), [0.6, 0.5]);
  assert.deepEqual(ctl({ m_bSoftEdges: true }).pc.c0.slice(2), [-1000, 1000]);  // soft edges need distance alpha
});

test('orientation, sheets, self illum over 1', () => {
  const c = ctl({ m_nOrientationType: 'PARTICLE_ORIENTATION_WORLD_Z_ALIGNED', m_flSelfIllumAmount: 2,
    m_vecTexturesInput: [{ m_hTexture: 'materials/a.vtex' }] }, () => true);
  assert.equal((c.flags >> 1) & 7, 2);
  assert.ok(c.flags & FLAG.NUM_SEQUENCES_PER_PARTICLE);
  assert.ok(c.flags & FLAG.SELF_ILLUM_OVER_1);
  assert.equal(c.pc.c3[2] & (1 << 12), 0);                   // has a sheet: no-sheet bit clear
  const n = ctl({ m_nOrientationType: 'PARTICLE_ORIENTATION_ALIGN_TO_PARTICLE_NORMAL', m_vecTexturesInput: [{ m_hTexture: 'x' }] });
  assert.ok(!(n.flags & FLAG.HAS_NO_NORMAL_FOR_LIGHTING));
  assert.ok(n.pc.c3[2] & (1 << 12));
  assert.equal(rendererFlags({ m_nLightingMode: 'PARTICLE_LIGHTING_PER_PIXEL' }) & FLAG.PER_PIXEL_LIGHTING, FLAG.PER_PIXEL_LIGHTING);
});

test('the dragon fire (westersand custom_particle_137 and children) maps without unsupported features', () => {
  const dir = path.join(ROOT, 'web/public/maps/ze_ffxii_westersand_v8/fx/systems/particles/westersand_particles_1');
  if (!fs.existsSync(dir)) return;                            // the bake is gitignored
  for (const n of [137, 138, 134, 140, 139, 141]) {
    const sys = JSON.parse(fs.readFileSync(path.join(dir, `custom_particle_${n}.vpcf.json`), 'utf8'));
    for (const raw of sys.m_Renderers || []) {
      if (raw._class !== 'C_OP_RenderSprites') continue;
      const p = resolveFunction(raw, ctx);
      const c = spritecardControls(raw._class, p, raw, ev, 0, () => true);
      assert.deepEqual(c.unsupported, [], `${n}: ${c.unsupported}`);
      if (n === 137) {
        assert.equal(c.pc.c0[0], 1);                          // self illum 1
        assert.equal(c.pc.c1[3], 0);                          // ADD
        assert.equal(c.vc.c1[3], 1.801);                      // animation rate, FIT_LIFETIME
        assert.equal(c.vc.animationType, 1);
        assert.equal(c.vc.orientation, 1);                    // SCREEN_Z
      }
    }
  }
});
