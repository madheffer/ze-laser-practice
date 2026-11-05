#!/usr/bin/env node
// Split a baked map's world glb into spatial chunks the game streams around the player (world/stream.js), and
// cut its draw calls. Rendering only: collision, hulls and entities stay whole, so gameplay is the same 1:1.
//
//   node tools/chunk-world.mjs <web/public/maps/<map>> [--cell 4096]      (npm --prefix tools install first)
//
// Per chunk (a cell x cell x cell box in Source units; a mesh wider than 1.5 cells goes in an always-loaded chunk):
//   - lightmapped meshes (TEXCOORD_1) that share a material are joined into one (they are lit per pixel from the
//     lightmap, so where the mesh ends doesn't change their shading); blended ones stay apart (draw order)
//   - meshes without a lightmap (props: lit by the probe volume around their centre) that repeat become one
//     EXT_mesh_gpu_instancing node per mesh; the renderer splits each by probe volume, per instance centre
//   - editor-only tool materials (render.js hides them anyway) are dropped
//   - geometry is meshopt-compressed (normals / tangents quantised; positions and UVs stay float)
// -> world/chunk_<n>.glb (images stay the world's own PNGs beside them, so quality tiers still swap them) and
//    world/chunks.json { version, cell, chunks: [{ file, min, max, always, tris }] }; manifest.json gets "chunks".
// The original world glb stays (lasers.cybo.dev reads it, and the game falls back to it).
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, getBounds, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshGPUInstancing, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, joinPrimitives, transformPrimitive, reorder, quantize } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const TOOL = /tools?(trigger|clip|nodraw|skip|invisible|playerclip|blocklight|areaportal|sky)/i; // render.js setWorld
const M = 1 / 0.0254; // glTF metres -> Source inches; glTF (x, y, z) = Source (y, z, x)
const toSrc = (v) => [v[2] * M, v[0] * M, v[1] * M];

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const cell = Number(args[args.indexOf('--cell') + 1]) > 0 && args.includes('--cell') ? Number(args[args.indexOf('--cell') + 1]) : 4096;
if (!dir) { console.error('usage: node tools/chunk-world.mjs <web/public/maps/<map>> [--cell 4096]'); process.exit(2); }
const mapDir = path.resolve(dir);
const manifestFile = path.join(mapDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const worldRel = String(manifest.world || '');
if (!/^world\/[\w.-]+\.glb$/.test(worldRel)) { console.error(`manifest.world isn't world/<name>.glb: ${worldRel}`); process.exit(1); }
const worldDir = path.join(mapDir, 'world');
const src = path.join(mapDir, worldRel);

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
io.setLogger?.(new Logger(Logger.Verbosity.WARN));
const t0 = Date.now();

// pass 1: which chunk each top-level mesh node belongs to (by its world bounds), keyed by node index
async function readWorld() {
  const doc = await io.read(src);
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  await doc.transform(dedup());
  return doc;
}
const doc0 = await readWorld();
const nodes0 = doc0.getRoot().listNodes();
const assign = new Map(); // chunk key -> Set(node index)
const boxes = new Map(); // chunk key -> { min, max } (Source)
const split = new Set(); // big lightmapped nodes cut by triangle into the cells they cross
const grow = (key, min, max) => {
  if (!assign.has(key)) { assign.set(key, new Set()); boxes.set(key, { min: [...min], max: [...max] }); }
  const bx = boxes.get(key);
  for (let k = 0; k < 3; k++) { bx.min[k] = Math.min(bx.min[k], min[k]); bx.max[k] = Math.max(bx.max[k], max[k]); }
};
nodes0.forEach((n, i) => {
  if (!n.getMesh() || n.getParentNode()) return;
  const b = getBounds(n);
  const lo = toSrc(b.min), hi = toSrc(b.max);
  const min = lo.map((v, k) => Math.min(v, hi[k])), max = lo.map((v, k) => Math.max(v, hi[k]));
  if (!min.every(Number.isFinite)) return;
  const big = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) > cell * 1.5;
  if (big && splittable(n)) {
    // lit per pixel from its lightmap, so where its pieces end doesn't change the shading: each triangle goes to
    // the cell of its centre (a cell's box grows to hold its triangles whole)
    split.add(i);
    for (const p of n.getMesh().listPrimitives()) {
      const { keys, tmin, tmax } = triangleCells(n, p);
      keys.forEach((key, t) => { grow(key, tmin[t], tmax[t]); assign.get(key).add(i); });
    }
    return;
  }
  const c = min.map((v, k) => (v + max[k]) / 2);
  const key = big ? 'always' : c.map((v) => Math.floor(v / cell)).join(',');
  grow(key, min, max);
  assign.get(key).add(i);
});

function splittable(node) {
  return node.getMesh().listPrimitives().every((p) => p.getAttribute('TEXCOORD_1') && p.getIndices() && p.getMode() === 4
    && p.getMaterial()?.getAlphaMode() !== 'BLEND');
}

// column-major 4x4 times a point
function xform(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

// each triangle's cell key and Source bounds
function triangleCells(node, prim) {
  const m = node.getWorldMatrix();
  const pos = prim.getAttribute('POSITION'), ia = prim.getIndices().getArray();
  const v = [0, 0, 0];
  const keys = [], tmin = [], tmax = [];
  for (let t = 0; t < ia.length; t += 3) {
    const ps = [0, 1, 2].map((j) => { pos.getElement(ia[t + j], v); return toSrc(xform(m, v[0], v[1], v[2])); });
    const lo = [0, 1, 2].map((k) => Math.min(ps[0][k], ps[1][k], ps[2][k])), hi = [0, 1, 2].map((k) => Math.max(ps[0][k], ps[1][k], ps[2][k]));
    keys.push([0, 1, 2].map((k) => Math.floor((ps[0][k] + ps[1][k] + ps[2][k]) / 3 / cell)).join(','));
    tmin.push(lo); tmax.push(hi);
  }
  return { keys, tmin, tmax };
}

// a new primitive with only the triangles `keep` says, its vertices compacted (no shared vertex buffer)
function subPrimitive(doc, prim, keep) {
  const ia = prim.getIndices().getArray();
  const remap = new Int32Array(prim.getAttribute('POSITION').getCount()).fill(-1);
  const used = [], idx = [];
  for (let t = 0; t < ia.length; t += 3) {
    if (!keep(t / 3)) continue;
    for (let j = 0; j < 3; j++) {
      const o = ia[t + j];
      if (remap[o] < 0) { remap[o] = used.length; used.push(o); }
      idx.push(remap[o]);
    }
  }
  if (!idx.length) return null;
  const buf = doc.getRoot().listBuffers()[0];
  const p = doc.createPrimitive().setMaterial(prim.getMaterial()).setMode(prim.getMode());
  for (const s of prim.listSemantics()) {
    const a = prim.getAttribute(s), src = a.getArray(), size = a.getElementSize();
    const dst = new src.constructor(used.length * size);
    used.forEach((o, k) => { for (let c = 0; c < size; c++) dst[k * size + c] = src[o * size + c]; });
    p.setAttribute(s, doc.createAccessor().setType(a.getType()).setNormalized(a.getNormalized()).setArray(dst).setBuffer(buf));
  }
  p.setIndices(doc.createAccessor().setType('SCALAR').setArray(used.length > 65535 ? new Uint32Array(idx) : new Uint16Array(idx)).setBuffer(buf));
  return p;
}
console.log(`${path.basename(mapDir)}: ${nodes0.length} nodes -> ${assign.size} chunks (cell ${cell})`);

// remove old chunk files first (only ours: chunk_<n>.glb)
for (const f of fs.readdirSync(worldDir)) if (/^chunk_\d+\.glb$/.test(f)) fs.unlinkSync(path.join(worldDir, f));

const out = [];
const keys = [...assign.keys()].sort((a, b) => (a === 'always' ? -1 : b === 'always' ? 1 : a.localeCompare(b)));
let n = 0, drawsBefore = 0, drawsAfter = 0;
for (const key of keys) {
  const doc = await readWorld(); // same order as pass 1 (deterministic read + dedup)
  const root = doc.getRoot();
  const keep = assign.get(key);
  const scene = root.listScenes()[0];
  root.listNodes().forEach((node, i) => {
    if (node.getParentNode()) return;
    if (!keep.has(i)) { node.dispose(); return; }
    if (!split.has(i)) return;
    // a big mesh cut by cell: only this cell's triangles
    const mesh = doc.createMesh(node.getMesh().getName());
    for (const p of node.getMesh().listPrimitives()) {
      const { keys } = triangleCells(node, p);
      const sub = subPrimitive(doc, p, (t) => keys[t] === key);
      if (sub) mesh.addPrimitive(sub);
    }
    node.setMesh(mesh);
  });
  for (const s of root.listScenes()) if (s !== scene) s.dispose();
  const nodes = scene.listChildren().filter((x) => x.getMesh());
  for (const node of nodes) drawsBefore += node.getMesh().listPrimitives().length;

  // drop tool-material primitives (hidden in the game anyway)
  for (const node of nodes) for (const p of node.getMesh().listPrimitives()) if (TOOL.test(p.getMaterial()?.getName() || '')) p.dispose();

  // lightmapped: join by material (+ attribute set), transforms baked in
  const groups = new Map();
  const lit = [];
  for (const node of nodes) {
    const mesh = node.getMesh();
    const prims = mesh.listPrimitives();
    if (!prims.length) { node.dispose(); continue; }
    if (!prims.every((p) => p.getAttribute('TEXCOORD_1'))) { lit.push(node); continue; }
    for (const p of prims) {
      const mat = p.getMaterial();
      if (mat?.getAlphaMode() === 'BLEND' || !p.getIndices()) continue; // stays as it is
      const sig = `${root.listMaterials().indexOf(mat)}|${p.listSemantics().sort().join(',')}|${p.getMode()}`;
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push({ node, prim: p });
    }
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const prims = list.map(({ node, prim }) => {
      const c = prim.clone(); // shares accessors: copy before transforming them
      const m = node.getWorldMatrix();
      const identity = m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-6);
      if (!identity) {
        for (const s of c.listSemantics()) c.setAttribute(s, c.getAttribute(s).clone());
        transformPrimitive(c, m);
      }
      return c;
    });
    const joined = joinPrimitives(prims);
    for (const p of prims) p.dispose();
    const mesh = doc.createMesh('joined').addPrimitive(joined);
    scene.addChild(doc.createNode('joined').setMesh(mesh));
    for (const { node, prim } of list) {
      prim.dispose();
      if (!node.getMesh().listPrimitives().length) node.dispose();
    }
  }

  // props without a lightmap that repeat: one instanced node per mesh
  const byMesh = new Map();
  for (const node of lit) {
    if (node.isDisposed()) continue;
    const m = node.getMesh();
    if (!byMesh.has(m)) byMesh.set(m, []);
    byMesh.get(m).push(node);
  }
  const inst = doc.createExtension(EXTMeshGPUInstancing);
  for (const [mesh, list] of byMesh) {
    if (list.length < 2) continue;
    const t = new Float32Array(list.length * 3), r = new Float32Array(list.length * 4), s = new Float32Array(list.length * 3);
    list.forEach((node, i) => { t.set(node.getTranslation(), i * 3); r.set(node.getRotation(), i * 4); s.set(node.getScale(), i * 3); });
    const buf = root.listBuffers()[0];
    const batch = inst.createInstancedMesh()
      .setAttribute('TRANSLATION', doc.createAccessor().setType('VEC3').setArray(t).setBuffer(buf))
      .setAttribute('ROTATION', doc.createAccessor().setType('VEC4').setArray(r).setBuffer(buf))
      .setAttribute('SCALE', doc.createAccessor().setType('VEC3').setArray(s).setBuffer(buf));
    scene.addChild(doc.createNode('instanced').setMesh(mesh).setExtension('EXT_mesh_gpu_instancing', batch));
    for (const node of list) node.dispose();
  }
  if (!inst.listProperties().length) inst.dispose();

  await doc.transform(prune({ keepAttributes: true }), reorder({ encoder: MeshoptEncoder }), quantize({ pattern: /^(NORMAL|TANGENT)$/ }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });

  let tris = 0;
  for (const node of scene.listChildren()) for (const p of node.getMesh()?.listPrimitives() || []) {
    drawsAfter++;
    tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
  }
  if (!scene.listChildren().length) continue;
  const file = `chunk_${String(n++).padStart(4, '0')}.glb`;
  fs.writeFileSync(path.join(worldDir, file), await glbWithExternalImages(doc));
  const bx = boxes.get(key);
  out.push({ file: `world/${file}`, min: bx.min.map(Math.floor), max: bx.max.map(Math.ceil), always: key === 'always', tris: Math.round(tris) });
}

// a GLB whose images stay as the PNGs beside it (glTF-Transform would embed them)
async function glbWithExternalImages(doc) {
  const { json, resources } = await io.writeJSON(doc, { format: 0 /* GLTF */ });
  const main = (json.buffers || []).findIndex((b) => b.uri && resources[b.uri]);
  let bin = new Uint8Array(0);
  if (main >= 0) {
    bin = resources[json.buffers[main].uri];
    // the data buffer must be buffer 0 in a GLB (the meshopt fallback buffer has no data)
    const order = [main, ...json.buffers.map((_, i) => i).filter((i) => i !== main)];
    const remap = new Map(order.map((old, i) => [old, i]));
    json.buffers = order.map((i) => json.buffers[i]);
    delete json.buffers[0].uri;
    json.buffers[0].byteLength = bin.byteLength;
    for (const bv of json.bufferViews || []) {
      bv.buffer = remap.get(bv.buffer);
      const ext = bv.extensions?.EXT_meshopt_compression;
      if (ext) ext.buffer = remap.get(ext.buffer);
    }
  }
  for (const img of json.images || []) if (!img.uri || /[\\/]|\.\./.test(img.uri)) throw new Error(`image without a plain uri: ${img.uri}`);
  const jsonBytes = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const binBytes = pad(Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength), 0);
  const total = 12 + 8 + jsonBytes.length + (binBytes.length ? 8 + binBytes.length : 0);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBytes.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const parts = [head, jh, jsonBytes];
  if (binBytes.length) { const bh = Buffer.alloc(8); bh.writeUInt32LE(binBytes.length, 0); bh.writeUInt32LE(0x004e4942, 4); parts.push(bh, binBytes); }
  return Buffer.concat(parts);
}
function pad(b, fill) { const r = (4 - (b.length % 4)) % 4; return r ? Buffer.concat([b, Buffer.alloc(r, fill)]) : b; }

const index = { version: manifest.version, cell, chunks: out };
fs.writeFileSync(path.join(worldDir, 'chunks.json'), JSON.stringify(index));
manifest.chunks = 'world/chunks.json';
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
const bytes = out.reduce((s, c) => s + fs.statSync(path.join(mapDir, c.file)).size, 0);
console.log(`${out.length} chunks, ${(bytes / 1048576).toFixed(1)} MB (world glb ${(fs.statSync(src).size / 1048576).toFixed(1)} MB), draws ${drawsBefore} -> ${drawsAfter}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
