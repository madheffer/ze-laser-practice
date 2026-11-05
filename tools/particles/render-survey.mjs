// Renderer feature survey over every baked map: which renderer fields (and texture-group fields) the baked
// systems set, how many renderers / systems use each, and whether the web renderers read the field at all.
//
//   node tools/particles/render-survey.mjs [--focus ze_ffxii_westersand_v8] [--roots a.vpcf,b.vpcf] [--json out.json]
//
// A compiled vpcf omits every field equal to its class default (PARTICLE_RENDERING.md section 11), so a field
// present in the baked JSON is a field the author changed. "read" = the field name appears in a web renderer
// source file (web/src/fx/particles/render/*.js); "unsupported" = controls.js spritecardControls() reports it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spritecardControls } from '../../web/src/fx/particles/render/controls.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAPS = path.join(ROOT, 'web/public/maps');
const RENDER_SRC = path.join(ROOT, 'web/src/fx/particles/render');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const focusMap = opt('--focus') || 'ze_ffxii_westersand_v8';
const W1 = 'particles/westersand_particles_1/custom_particle_';
const focusRoots = (opt('--roots')?.split(',') || [137, 230, 227, 161, 168, 141, 115, 228, 191].map((n) => `${W1}${n}.vpcf`)
  .concat(['particles/tesla/tesla_main.vpcf']));

const srcText = fs.readdirSync(RENDER_SRC).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(RENDER_SRC, f), 'utf8')).join('\n');
const read = (k) => new RegExp(`\\b${k}\\b`).test(srcText);

// a stub evaluator: literals read, anything else stands at its default (the survey needs presence, not values)
const lit = (inp, d) => (typeof inp === 'number' ? inp : inp?.m_nType === 'PF_TYPE_LITERAL' ? inp.m_flLiteralValue : d);
const ev = { evalFloat: (inp, _i, d) => lit(inp, d), evalVec: (inp, _i, d) => (Array.isArray(inp) ? inp : inp?.m_vLiteralValue || d) };

const fields = new Map(); // key -> { renderers, systems:Set, focus:Set, values:Map }
const unsup = new Map();
const classes = new Map();
const bump = (m, key, sys, inFocus, value) => {
  let e = m.get(key);
  if (!e) m.set(key, e = { renderers: 0, systems: new Set(), focus: new Set(), values: new Map() });
  e.renderers++; e.systems.add(sys); if (inFocus) e.focus.add(sys);
  if (value !== undefined) { const v = typeof value === 'object' ? (value?.m_nType || 'obj') : String(value); e.values.set(v, (e.values.get(v) || 0) + 1); }
};

for (const map of fs.readdirSync(MAPS)) {
  const idxFile = path.join(MAPS, map, 'fx/index.json');
  if (!fs.existsSync(idxFile)) continue;
  const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  const load = (p) => { const f = idx.systems[p]; try { return f ? JSON.parse(fs.readFileSync(path.join(MAPS, map, 'fx', f), 'utf8')) : null; } catch { return null; } };
  // the focus set: the named roots of the focus map and every child they reach
  const focus = new Set();
  if (map === focusMap) {
    const walk = (p) => { if (focus.has(p)) return; const d = load(p); if (!d) return; focus.add(p); for (const c of d.m_Children || []) if (c?.m_ChildRef) walk(c.m_ChildRef.toLowerCase()); };
    focusRoots.forEach(walk);
  }
  for (const sysPath of Object.keys(idx.systems)) {
    const d = load(sysPath);
    if (!d) continue;
    const sys = `${map}:${sysPath}`, inFocus = focus.has(sysPath);
    for (const r of d.m_Renderers || []) {
      bump(classes, r._class, sys, inFocus);
      if (!/RenderSprites|RenderRopes|RenderTrails/.test(r._class)) continue;
      for (const [k, v] of Object.entries(r)) {
        if (k === '_class' || k === 'm_vecTexturesInput') continue;
        bump(fields, k, sys, inFocus, v);
      }
      const groups = r.m_vecTexturesInput || [];
      if (groups.length > 1) bump(fields, `m_vecTexturesInput[${groups.length} layers]`, sys, inFocus);
      groups.forEach((g, gi) => {
        for (const [k, v] of Object.entries(g)) {
          if (k === 'm_hTexture') continue;
          if (k === 'm_TextureControls') { for (const [tk, tv] of Object.entries(v || {})) bump(fields, `tex.${tk}`, sys, inFocus, tv); continue; }
          bump(fields, `tex.${k}`, sys, inFocus, v);
        }
        if (gi > 0) bump(fields, 'tex(layer>0)', sys, inFocus);
      });
      const ctl = spritecardControls(r._class, r, r, ev, 0);
      for (const u of ctl.unsupported) bump(unsup, u.replace(/^\d+ texture layers/, 'N texture layers'), sys, inFocus);
    }
  }
}

const rows = [...fields.entries()].map(([k, e]) => ({
  field: k, renderers: e.renderers, systems: e.systems.size, focus: e.focus.size,
  read: read(k.replace(/^tex\./, '').replace(/\[.*$/, '')),
  values: [...e.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([v, n]) => `${v}x${n}`).join(' '),
})).sort((a, b) => b.focus - a.focus || b.systems - a.systems);
const pad = (s, n) => String(s).padEnd(n);
console.log('RENDERER CLASSES (renderers / systems / focus systems)');
for (const [k, e] of [...classes].sort((a, b) => b[1].renderers - a[1].renderers)) console.log(' ', pad(k, 34), e.renderers, e.systems.size, e.focus.size);
console.log('\nFIELDS SET (focus = in the dragon-fight closure); read = named by a web renderer');
console.log(' ', pad('field', 44), pad('rend', 5), pad('sys', 5), pad('focus', 6), pad('read', 5), 'top values');
for (const r of rows) console.log(' ', pad(r.field, 44), pad(r.renderers, 5), pad(r.systems, 5), pad(r.focus, 6), pad(r.read ? 'yes' : 'NO', 5), r.values.slice(0, 90));
console.log('\ncontrols.js UNSUPPORTED');
for (const [k, e] of [...unsup].sort((a, b) => b[1].focus.size - a[1].focus.size || b[1].renderers - a[1].renderers)) console.log(' ', pad(k, 70), e.renderers, e.systems.size, e.focus.size);
const out = opt('--json');
if (out) fs.writeFileSync(out, JSON.stringify({ rows, unsupported: [...unsup].map(([k, e]) => ({ k, renderers: e.renderers, systems: e.systems.size, focus: e.focus.size })) }, null, 1));
