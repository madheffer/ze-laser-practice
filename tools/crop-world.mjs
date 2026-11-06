#!/usr/bin/env node
// Crop a baked map to the parts its stages use: the world glb's triangles and the collision triangles outside every
// box (Source units; --box once per area) are dropped, so a map whose stages live in one corner ships only that corner. A triangle that
// reaches into the box is kept whole (walls crossing its edge stay closed). Entities, hulls and brush / studio models
// are left alone: their logic runs map-wide, and a stage's `view` box keeps their models from loading until they
// come into it.
//
//   node tools/crop-world.mjs <web/public/maps/<map>> --box minX minY minZ maxX maxY maxZ [--box ...]
//
// Rewrites world/<map>.glb, collision.bin, collision_fx.bin + collision_fx_layers.bin in place, and stamps the boxes in
// manifest.json ("crop", with collision.triangles and a new version so browsers refetch). Rerun the map's bake to
// undo. A chunked world (manifest "chunks") is refused: crop before chunking.
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, Logger, Format } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, compactPrimitive } from '@gltf-transform/functions';

const M = 1 / 0.0254; // glTF metres -> Source inches; glTF (x, y, z) = Source (y, z, x)
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--') && !/^-?\d/.test(a));
// every --box (one per area a stage plays in)
const boxes = args.flatMap((a, i) => (a === '--box' ? [args.slice(i + 1, i + 7).map(Number)] : []));
const okBox = (b) => b.length === 6 && b.every(Number.isFinite) && b[0] < b[3] && b[1] < b[4] && b[2] < b[5];
if (!dir || !boxes.length || !boxes.every(okBox)) {
  console.error('usage: node tools/crop-world.mjs <web/public/maps/<map>> --box minX minY minZ maxX maxY maxZ [--box ...]');
  process.exit(2);
}
const mapDir = path.resolve(dir);
const manifestFile = path.join(mapDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (manifest.chunks) { console.error('this world is chunked: rebake it, crop, then chunk'); process.exit(1); }
const worldRel = String(manifest.world || '');
if (!/^world\/[\w.-]+\.glb$/.test(worldRel)) { console.error(`manifest.world isn't world/<name>.glb: ${worldRel}`); process.exit(1); }

// A .glb whose images stay the PNG files beside it (the bake's layout; io.write would embed them): the JSON as
// gltf-transform writes it for a .gltf, its one buffer as the GLB's BIN chunk, the image URIs left as they are
async function packGlb(document) {
  const { json, resources } = await io.writeJSON(document, { format: Format.GLTF });
  if ((json.buffers || []).length !== 1) throw new Error(`expected one buffer, got ${(json.buffers || []).length}`);
  const bin = resources[json.buffers[0].uri];
  if (!bin) throw new Error('buffer resource missing');
  json.buffers[0] = { byteLength: bin.byteLength };
  const pad = (b, fill) => { const n = (4 - (b.length % 4)) % 4; return n ? Buffer.concat([b, Buffer.alloc(n, fill)]) : b; };
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20), d = pad(Buffer.from(bin), 0);
  const head = Buffer.alloc(12), jh = Buffer.alloc(8), dh = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + d.length, 8);
  jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  dh.writeUInt32LE(d.length, 0); dh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, j, dh, d]);
}

// does the triangle with these corners (Source units) reach into any box?
const touches = (ax, ay, az, bx, by, bz, cx, cy, cz) => boxes.some(([x0, y0, z0, x1, y1, z1]) =>
  Math.max(ax, bx, cx) >= x0 && Math.min(ax, bx, cx) <= x1 && Math.max(ay, by, cy) >= y0 && Math.min(ay, by, cy) <= y1 &&
  Math.max(az, bz, cz) >= z0 && Math.min(az, bz, cz) <= z1);

// 1. the world glb
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
io.setLogger?.(new Logger(Logger.Verbosity.WARN));
const src = path.join(mapDir, worldRel);
const doc = await io.read(src);
let before = 0, after = 0;
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const idx = prim.getIndices();
    if (!pos || !idx) continue;
    const src3 = (i) => {
      const [x, y, z] = pos.getElement(i, []);
      const gx = m[0] * x + m[4] * y + m[8] * z + m[12], gy = m[1] * x + m[5] * y + m[9] * z + m[13], gz = m[2] * x + m[6] * y + m[10] * z + m[14];
      return [gz * M, gx * M, gy * M];
    };
    const ia = idx.getArray();
    const kept = [];
    for (let t = 0; t + 2 < ia.length; t += 3) {
      const a = src3(ia[t]), b = src3(ia[t + 1]), c = src3(ia[t + 2]);
      if (touches(...a, ...b, ...c)) kept.push(ia[t], ia[t + 1], ia[t + 2]);
    }
    before += ia.length / 3;
    after += kept.length / 3;
    if (!kept.length) { prim.dispose(); continue; }
    idx.setArray(new Uint32Array(kept));
    compactPrimitive(prim);
  }
  if (!mesh.listPrimitives().length) { node.setMesh(null); mesh.dispose(); }
}
await doc.transform(prune());
const kb0 = fs.statSync(src).size >> 10;
fs.writeFileSync(src, await packGlb(doc));
console.log(`world: ${before} -> ${after} triangles, ${kb0} -> ${fs.statSync(src).size >> 10} KB`);
// textures no material uses any more
const used = new Set(doc.getRoot().listTextures().map((t) => t.getURI()).filter(Boolean));
let gone = 0;
for (const f of fs.readdirSync(path.dirname(src))) {
  if (f.endsWith('.png') && f !== 'lightmap.png' && !used.has(f)) { fs.unlinkSync(path.join(path.dirname(src), f)); gone++; }
}
if (gone) console.log(`world: ${gone} unused textures removed`);

// 2. collision (9 floats a triangle), and the particle set with its per-triangle layers
function cropTris(file, layersFile) {
  const p = path.join(mapDir, file);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  const layers = layersFile && fs.existsSync(path.join(mapDir, layersFile)) ? new Uint32Array(fs.readFileSync(path.join(mapDir, layersFile)).buffer.slice(0)) : null;
  const out = [], outL = [];
  for (let t = 0; t * 9 + 8 < f.length; t++) {
    const o = t * 9;
    if (!touches(f[o], f[o + 1], f[o + 2], f[o + 3], f[o + 4], f[o + 5], f[o + 6], f[o + 7], f[o + 8])) continue;
    for (let k = 0; k < 9; k++) out.push(f[o + k]);
    if (layers) outL.push(layers[t]);
  }
  fs.writeFileSync(p, Buffer.from(new Float32Array(out).buffer));
  if (layers) fs.writeFileSync(path.join(mapDir, layersFile), Buffer.from(new Uint32Array(outL).buffer));
  console.log(`${file}: ${f.length / 9} -> ${out.length / 9} triangles`);
  return out.length / 9;
}
const colRel = typeof manifest.collision?.file === 'string' && /^[\w.-]+\.bin$/.test(manifest.collision.file) ? manifest.collision.file : 'collision.bin';
const n = cropTris(colRel, null);
cropTris('collision_fx.bin', 'collision_fx_layers.bin');

manifest.crop = boxes.map((b) => ({ min: b.slice(0, 3), max: b.slice(3) }));
if (n != null && manifest.collision) manifest.collision.triangles = n;
manifest.version = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
console.log('manifest: crop stamped, version', manifest.version);
