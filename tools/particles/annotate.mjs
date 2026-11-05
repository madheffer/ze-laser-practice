#!/usr/bin/env node
// Make a decompiled particle class readable (tools/particles/ghidra/DumpParticleClasses.java output):
//  - offsets on the object (`this`, the first parameter) become the class's field names from particles.dll's own schema
//    (schema_raw.json: every field's offset, type, declaring class), scaled by the pointer type Ghidra gave param_1
//    in that function (`longlong *param_1` + 0x3d = 0x1e8 bytes);
//  - offsets on the particle collection (the second parameter of Operate / InitNewParticles) become the collection
//    members they are: current time, dt, particle count, attribute streams (+0x2d8 + 8*i, i = ParticleAttributeIndex_t),
//    initial-value streams (+0x4c8 + 8*i), stride bytes, flags, random counter.
//
//   node tools/particles/annotate.mjs <schema_raw.json> <C_OP_Spin.c> [more.c ...]   -> <name>.named.c beside each
// Anything not matched is left as Ghidra wrote it: nothing is guessed.
import fs from 'node:fs';
import path from 'node:path';

const [schemaFile, ...files] = process.argv.slice(2);
if (!schemaFile || !files.length) { console.error('usage: annotate.mjs <schema_raw.json> <class.c>...'); process.exit(2); }
const { classes } = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));

const ATTR = ['POSITION', 'LIFE_DURATION', 'PREV_POSITION', 'RADIUS', 'ROLL', 'ROLL_SPEED', 'COLOR', 'ALPHA', 'CREATION_TIME',
  'SEQUENCE', 'TRAIL_LENGTH', 'PARTICLE_ID', 'YAW', 'SEQUENCE2', 'HITBOX_INDEX', 'HITBOX_OFFSET', 'ALPHA2', 'SCRATCH_VEC',
  'SCRATCH_FLOAT', 'NONE', 'PITCH', 'NORMAL', 'GLOW_RGB', 'GLOW_ALPHA', 'ATTR24', 'ATTR25', 'SCRATCH_FLOAT1', 'SCRATCH_FLOAT2',
  'ATTR28', 'ATTR29', 'SCRATCH_VEC2'];
const COLLECTION = {
  0x18: 'col.definition', 0x20: 'col.firstChild', 0x28: 'col.parent', 0x30: 'col.nextSibling', 0x40: 'col.curTime4', 0x50: 'col.curTime',
  0x54: 'col.time54', 0x58: 'col.time58', 0x5c: 'col.endcapStart', 0x60: 'col.opTimeOrigin', 0x64: 'col.dt', 0x68: 'col.prevDt',
  0x74: 'col.count', 0x168: 'col.cpSlots', 0x170: 'col.controlPoints', 0x8bc: 'col.flags', 0x8c1: 'col.flags2',
  0x910: 'col.randomCounter', 0x914: 'col.seedOffset', 0x918: 'col.opSeed',
};
const collectionName = (off) => {
  if (COLLECTION[off]) return COLLECTION[off];
  if (off >= 0x2d8 && off < 0x2d8 + 8 * ATTR.length && (off - 0x2d8) % 8 === 0) return `col.attr[${ATTR[(off - 0x2d8) / 8]}]`;
  if (off >= 0x460 && off < 0x460 + ATTR.length) return `col.stride[${ATTR[off - 0x460]}]`;
  if (off >= 0x4c8 && off < 0x4c8 + 8 * ATTR.length && (off - 0x4c8) % 8 === 0) return `col.init[${ATTR[(off - 0x4c8) / 8]}]`;
  if (off >= 0x650 && off < 0x650 + ATTR.length) return `col.initStride[${ATTR[off - 0x650]}]`;
  return null;
};

function fieldsOf(cls, seen = new Set()) {
  const c = classes[cls];
  if (!c || seen.has(cls)) return [];
  seen.add(cls);
  const base = c.bases?.[0]?.class;
  return [...(base ? fieldsOf(base, seen) : []), ...(c.fields || []).map((f) => ({ name: f.name, offset: Number(f.offset), type: f.type }))];
}
const SCALE = { longlong: 8, ulonglong: 8, undefined8: 8, double: 8, int: 4, uint: 4, float: 4, undefined4: 4, short: 2, ushort: 2, undefined2: 2, char: 1, byte: 1, undefined: 1, undefined1: 1 };

for (const file of files) {
  const cls = path.basename(file).replace(/\.c$/, '');
  const fields = fieldsOf(cls).sort((a, b) => a.offset - b.offset);
  if (!fields.length) { console.warn(`${cls}: not in the schema`); continue; }
  const fieldAt = (off) => {
    let best = null;
    for (const f of fields) if (f.offset <= off) best = f; else break;
    if (!best) return null;
    const d = off - best.offset;
    return d === 0 ? best.name : `${best.name}+0x${d.toString(16)}`;
  };
  const src = fs.readFileSync(file, 'utf8');
  // per function (split at each "// ---- slot" header): read param_1 / param_2 declared types, rename offsets
  const parts = src.split(/(?=\n\/\/ ---- slot )/);
  const out = parts.map((part) => {
    const sig = /\(([^)]*)\)\s*\n\s*\{/.exec(part);
    const params = sig ? sig[1].split(',').map((s) => s.trim()) : [];
    const typeOf = (name) => {
      const p = params.find((x) => new RegExp(`\\b${name}$`).test(x));
      if (!p) return { scale: 1 };
      const m = /^(\w+)\s*(\*?)\s*\w+$/.exec(p);
      return m && m[2] ? { scale: SCALE[m[1]] || 1 } : { scale: 1 };
    };
    const t1 = typeOf('param_1'), t2 = typeOf('param_2');
    let s = part;
    s = s.replace(/param_1\s*\+\s*0x([0-9a-f]+)/gi, (m, hex) => {
      const off = parseInt(hex, 16) * t1.scale;
      const n = fieldAt(off);
      return n ? `&this->${n} /*+0x${off.toString(16)}*/` : m;
    });
    s = s.replace(/param_1\[(0x[0-9a-f]+|\d+)\]/gi, (m, idx) => {
      const off = Number(idx) * t1.scale;
      const n = fieldAt(off);
      return n ? `this->${n} /*+0x${off.toString(16)}*/` : m;
    });
    s = s.replace(/param_2\s*\+\s*(0x[0-9a-f]+|\d+)/gi, (m, v) => {
      const off = Number(v) * t2.scale;
      const n = collectionName(off);
      return n ? `&${n} /*+0x${off.toString(16)}*/` : m;
    });
    return s;
  }).join('');
  const header = `// ${cls} fields (offset name type):\n${fields.map((f) => `//   0x${f.offset.toString(16).padStart(3, '0')} ${f.name} ${f.type}`).join('\n')}\n// collection (2nd parameter of Operate): col.curTime +0x50, col.dt +0x64, col.count +0x74, col.attr[i] +0x2d8+8i, col.init[i] +0x4c8+8i\n\n`;
  fs.writeFileSync(file.replace(/\.c$/, '.named.c'), header + out);
  console.log(`${cls}: ${fields.length} fields`);
}
